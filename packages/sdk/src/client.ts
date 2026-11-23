import { Connection } from "./connection.js";
import type { Channel, Unsubscribe } from "./connection.js";
import { MistyError } from "./errors.js";
import { createFrameTransport } from "./mcp.js";
import type { FrameTransport } from "./mcp.js";
import { live } from "./live.js";
import type { Live } from "./live.js";
import { FIRST_OFFERS, INIT_MESSAGE, PROTOCOL_VERSIONS } from "./protocol.js";
import type { HelloResult, InitMessage, Offers, Topics, WatchOptions } from "./protocol.js";
import { openFileRoom, openRoom } from "./room.js";
import type { FileRoom, FileRoomOptions, Room, RoomHost, RoomOptions } from "./room.js";
import { applyTheme } from "./theme.js";
import type {
  AgentControl,
  AppContext,
  CallState,
  Card,
  ChatTarget,
  FileChange,
  FilePage,
  FileRef,
  ListFilesOptions,
  Me,
  Member,
  Mentionable,
  PickOptions,
  Presence,
  Route,
  SaveOptions,
  Span,
  Space,
  Theme,
  UploadOptions,
  VoiceChannel,
} from "./types.js";

export const SDK_VERSION = "0.2.0";

type LiveTopic = "members.presence" | "calls.channels" | "calls.current" | "agents.control";

export interface RoomOpener {
  (id: string, options?: RoomOptions): Room;
  forFile(fileId: string, options?: FileRoomOptions): FileRoom;
}

export interface LiveFilesOptions {
  folder?: string;
  accept?: string[];
}

export interface MistyLive {
  presence(): Live<Presence[]>;
  voiceChannels(): Live<VoiceChannel[]>;
  call(): Live<CallState>;
  files(options?: LiveFilesOptions): Live<FileRef[]>;
  agent(): Live<AgentControl>;
}

export interface Misty {
  readonly appId: string;
  readonly permissions: AppContext["permissions"];
  readonly protocol: number;
  supports(name: string): boolean;
  space(): Space;
  me(): Me;
  theme(): Theme;
  onTheme(listener: (theme: Theme) => void): Unsubscribe;
  route(): Route;
  onRoute(listener: (route: Route) => void): Unsubscribe;
  navigate(route: Route, options?: { replace?: boolean }): Promise<void>;

  members: {
    list(): Promise<Member[]>;
    presence(listener: (presence: Presence[]) => void): Unsubscribe;
    mentionables(query: string): Promise<Mentionable[]>;
  };

  chat: {
    post(target: ChatTarget, spans: Span[], card?: Card): Promise<{ message_id: string }>;
    openChat(target: ChatTarget): Promise<void>;
    notify(userId: string, text: string, route?: Route): Promise<void>;
  };

  files: {
    pick(options?: PickOptions): Promise<FileRef[]>;
    open(fileId: string, appId?: string): Promise<void>;
    save(options: SaveOptions): Promise<FileRef>;
    list(options?: ListFilesOptions): Promise<FilePage>;
    watch(listener: (change: FileChange) => void, options?: { folder?: string; accept?: string[] }): Unsubscribe;
    upload(options: UploadOptions): Promise<FileRef>;
    download(fileId: string): Promise<{ file: FileRef; data: ArrayBuffer }>;
  };

  room: RoomOpener;

  agents: {
    control(listener: (control: AgentControl) => void): Unsubscribe;
  };

  live: MistyLive;

  calls: {
    channels(listener: (channels: VoiceChannel[]) => void): Unsubscribe;
    current(listener: (call: CallState) => void): Unsubscribe;
    join(channelId: string): Promise<void>;
    leave(): Promise<void>;
    setMuted(muted: boolean): Promise<void>;
  };

  mcpTransport(): FrameTransport;

  onClose(listener: () => void): Unsubscribe;
  close(): void;
}

export interface CreateMistyOptions {
  applyTheme?: boolean;
}

export function createMisty(channel: Channel, context: HelloResult, options: CreateMistyOptions = {}): Misty {
  return buildMisty(new Connection(channel), context, options);
}

const MAX_LISTED_PAGES = 50;

const MAX_EARLY_CHANGES = 1_000;

const MAX_LIST_ATTEMPTS = 3;

function buildMisty(connection: Connection, context: HelloResult, options: CreateMistyOptions): Misty {
  const offers: Offers = context.offers ?? FIRST_OFFERS;
  const offered = new Set([...offers.calls, ...offers.topics]);
  const supports = (name: string) => offered.has(name);
  const roomHost: RoomHost = {
    syncs: offers.calls.includes("room.sync"),
    me: { user_id: context.me.user_id, name: context.me.name, tone: context.me.tone ?? null },
  };
  let theme = context.theme;
  let route = context.route;
  const themeListeners = new Set<(theme: Theme) => void>();
  const routeListeners = new Set<(route: Route) => void>();
  const shouldApply = options.applyTheme ?? typeof document !== "undefined";

  if (shouldApply) applyTheme(theme);
  connection.subscribe("theme", undefined, (next) => {
    theme = next;
    if (shouldApply) applyTheme(next);
    for (const listener of [...themeListeners]) listener(next);
  });
  connection.subscribe("route", undefined, (next) => {
    route = next;
    for (const listener of [...routeListeners]) listener(next);
  });

  const listen = <T>(set: Set<(value: T) => void>, listener: (value: T) => void): Unsubscribe => {
    set.add(listener);
    return () => set.delete(listener);
  };

  const topicValue = <T extends LiveTopic>(topic: T): Live<Topics[T][1]> =>
    live<Topics[T][1]>((set, fail) =>
      connection.subscribe(topic, undefined as Topics[T][0], set, (error) =>
        fail(error ?? new MistyError("closed", "Misty stopped sending this.")),
      ),
    );

  const shared = new Map<string, Live<unknown>>();
  const once = <T>(key: string, make: () => Live<T>): Live<T> => {
    const known = shared.get(key);
    if (known) return known as Live<T>;
    const made = make();
    shared.set(key, made as Live<unknown>);
    return made;
  };

  const liveFiles = (filesOptions: LiveFilesOptions = {}) =>
    live<FileRef[]>((set, fail) => {
      const files = new Map<string, FileRef>();
      const early: FileChange[] = [];
      let overflowed = false;
      let listed = false;
      let closed = false;
      const publish = () =>
        set([...files.values()].sort((left, right) => left.name.localeCompare(right.name)));
      const apply = (change: FileChange) => {
        if (change.kind === "removed") files.delete(change.id);
        else files.set(change.file.id, change.file);
      };
      const watch: WatchOptions = filesOptions.folder
        ? { folder: filesOptions.folder, accept: filesOptions.accept }
        : { accept: filesOptions.accept, default_folder: true };
      const stop = connection.subscribe(
        "files.watch",
        watch,
        (change) => {
          if (closed) return;
          if (!listed) {
            if (early.length < MAX_EARLY_CHANGES) early.push(change);
            else overflowed = true;
            return;
          }
          apply(change);
          publish();
        },
        (error) => {
          if (closed) return;
          closed = true;
          early.length = 0;
          fail(error ?? new MistyError("closed", "Misty stopped watching these files."));
        },
      );
      const list = async () => {
        for (let attempt = 0; attempt < MAX_LIST_ATTEMPTS; attempt += 1) {
          overflowed = false;
          files.clear();
          let cursor: string | undefined;
          for (let page = 0; page < MAX_LISTED_PAGES; page += 1) {
            const result = await connection.call("files.list", {
              folder: filesOptions.folder,
              accept: filesOptions.accept,
              cursor,
            });
            if (closed) return;
            for (const found of result.files) files.set(found.id, found);
            cursor = result.next_cursor;
            if (!cursor) break;
          }
          if (!overflowed) {
            listed = true;
            for (const change of early.splice(0)) apply(change);
            publish();
            return;
          }
          early.length = 0;
        }
        throw new MistyError("internal", "These files changed too often to list.");
      };
      list().catch((error: unknown) => {
        if (closed) return;
        closed = true;
        early.length = 0;
        stop();
        fail(error instanceof MistyError ? error : new MistyError("internal", String(error)));
      });
      return () => {
        closed = true;
        early.length = 0;
        stop();
      };
    });

  const room = ((id: string, roomOptions?: RoomOptions) =>
    openRoom(connection, id, roomOptions ?? {}, roomHost)) as RoomOpener;
  room.forFile = (fileId, fileOptions) => {
    if (!supports("room.sync"))
      throw new MistyError("unsupported", "This version of Misty can't open a file as a live document.");
    return openFileRoom(connection, fileId, fileOptions ?? {}, roomHost);
  };

  return {
    appId: context.app_id,
    permissions: context.permissions,
    protocol: context.protocol ?? 1,
    supports,
    space: () => context.space,
    me: () => context.me,
    theme: () => theme,
    onTheme: (listener) => listen(themeListeners, listener),
    route: () => route,
    onRoute: (listener) => listen(routeListeners, listener),
    navigate: (next, opts) => connection.call("route.navigate", { route: next, replace: opts?.replace }),

    members: {
      list: () => connection.call("members.list"),
      presence: (listener) => connection.subscribe("members.presence", undefined, listener),
      mentionables: (query) => connection.call("members.mentionables", { query }),
    },
    chat: {
      post: (target, spans, card) => connection.call("chat.post", { target, spans, card }),
      openChat: (target) => connection.call("chat.open", target),
      notify: (userId, text, notifyRoute) =>
        connection.call("chat.notify", { user_id: userId, text, route: notifyRoute }),
    },
    files: {
      pick: (pickOptions) => connection.call("files.pick", pickOptions),
      open: (fileId, appId) => connection.call("files.open", { file_id: fileId, app_id: appId }),
      save: (saveOptions) => connection.call("files.save", saveOptions),
      list: (listOptions) => connection.call("files.list", listOptions),
      watch: (listener, watchOptions) => connection.subscribe("files.watch", watchOptions, listener),
      upload: (uploadOptions) => connection.call("files.upload", uploadOptions),
      download: (fileId) => connection.call("files.download", { file_id: fileId }),
    },
    room,
    agents: {
      control: (listener) => connection.subscribe("agents.control", undefined, listener),
    },
    live: {
      presence: () => once("presence", () => topicValue("members.presence")),
      voiceChannels: () => once("voice", () => topicValue("calls.channels")),
      call: () => once("call", () => topicValue("calls.current")),
      agent: () => once("agent", () => topicValue("agents.control")),
      files: (filesOptions) =>
        once(`files:${JSON.stringify([filesOptions?.folder ?? null, filesOptions?.accept ?? null])}`, () =>
          liveFiles(filesOptions),
        ),
    },
    calls: {
      channels: (listener) => connection.subscribe("calls.channels", undefined, listener),
      current: (listener) => connection.subscribe("calls.current", undefined, listener),
      join: (channelId) => connection.call("calls.join", { channel_id: channelId }),
      leave: () => connection.call("calls.leave"),
      setMuted: (muted) => connection.call("calls.mute", { muted }),
    },
    mcpTransport: () => createFrameTransport(connection),
    onClose: (listener) => connection.onClose(listener),
    close: () => connection.close(),
  };
}

export interface ConnectOptions extends CreateMistyOptions {
  timeoutMs?: number;
}

interface StartMessage {
  version: unknown;
  versions: unknown;
  port: MessagePort;
}

export function pickProtocol(start: { version: unknown; versions?: unknown }): number | null {
  const offered = Array.isArray(start.versions) ? start.versions : [start.version];
  const common = offered.filter(
    (version): version is number => typeof version === "number" && PROTOCOL_VERSIONS.includes(version),
  );
  return common.length ? Math.max(...common) : null;
}

function startMessageOf(event: MessageEvent): StartMessage | undefined {
  if (event.source !== window.parent && event.source !== window) return undefined;
  const data = event.data as Partial<InitMessage> | null;
  const port = event.ports[0];
  if (!data || data.type !== INIT_MESSAGE || !port) return undefined;
  return { version: data.version, versions: data.versions, port };
}

let early: StartMessage | undefined;
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    const start = startMessageOf(event);
    if (start) early = start;
  });
}

const helloParams = (protocol: number) => ({ sdk: SDK_VERSION, protocol, versions: [...PROTOCOL_VERSIONS] });

function followRestarts(connection: Connection, first: MessagePort, protocol: number, context: HelloResult): void {
  let current = first;
  const onMessage = (event: MessageEvent) => {
    const start = startMessageOf(event);
    if (!start || start.port === current) return;
    if (early?.port === start.port) early = undefined;
    current = start.port;
    if (pickProtocol(start) !== protocol) {
      start.port.close();
      connection.close();
      return;
    }
    connection.replace(start.port);
    connection.call("hello", helloParams(protocol)).then(
      (next) => {
        const same =
          next.app_id === context.app_id &&
          next.space.id === context.space.id &&
          next.me.user_id === context.me.user_id;
        if (same) connection.resume();
        else connection.close();
      },
      () => connection.close(),
    );
  };
  window.addEventListener("message", onMessage);
  connection.onClose(() => window.removeEventListener("message", onMessage));
}

export function connect(options: ConnectOptions = {}): Promise<Misty> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise<Misty>((resolve, reject) => {
    let settled = false;
    let opened: Connection | undefined;
    const onMessage = (event: MessageEvent) => {
      const start = startMessageOf(event);
      if (start) begin(start);
    };
    const timer = setTimeout(() => {
      fail(
        opened
          ? new MistyError("internal", "Misty didn't answer the app in time.")
          : new MistyError("unsupported", "This page isn't running inside Misty."),
      );
    }, timeoutMs);
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    function fail(error: Error) {
      if (settled) return;
      finish();
      opened?.close();
      reject(error);
    }
    function begin(start: StartMessage) {
      if (settled || opened) return;
      window.removeEventListener("message", onMessage);
      const { port } = start;
      const protocol = pickProtocol(start);
      if (protocol === null) {
        port.close();
        fail(
          new MistyError(
            "unsupported",
            `This Misty speaks protocol ${String(start.versions ?? start.version)}, but the app's SDK speaks ${PROTOCOL_VERSIONS.join(", ")}.`,
          ),
        );
        return;
      }
      const connection = new Connection(port);
      opened = connection;
      connection
        .call("hello", helloParams(protocol))
        .then((context) => {
          if (settled) return;
          finish();
          const spoken = context.protocol ?? protocol;
          followRestarts(connection, port, spoken, context);
          resolve(buildMisty(connection, { ...context, protocol: spoken }, options));
        })
        .catch((error: unknown) => fail(error instanceof Error ? error : new MistyError("internal", String(error))));
    }
    if (early) {
      const start = early;
      early = undefined;
      begin(start);
      return;
    }
    window.addEventListener("message", onMessage);
  });
}

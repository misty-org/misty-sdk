import { Connection } from "./connection.js";
import type { Channel, Unsubscribe } from "./connection.js";
import { MistyError } from "./errors.js";
import { createFrameTransport } from "./mcp.js";
import type { FrameTransport } from "./mcp.js";
import { INIT_MESSAGE, PROTOCOL_VERSION } from "./protocol.js";
import type { InitMessage } from "./protocol.js";
import { openRoom } from "./room.js";
import type { Room, RoomOptions } from "./room.js";
import { applyTheme } from "./theme.js";
import type {
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

export const SDK_VERSION = "0.1.0";

/** Everything a Space gives an app. Each call is checked by Misty against what the mod approved. */
export interface Misty {
  readonly appId: string;
  /** What the mod approved at install; a call outside it answers `permission_denied`. */
  readonly permissions: AppContext["permissions"];
  space(): Space;
  me(): Me;
  theme(): Theme;
  onTheme(listener: (theme: Theme) => void): Unsubscribe;
  route(): Route;
  onRoute(listener: (route: Route) => void): Unsubscribe;
  navigate(route: Route, options?: { replace?: boolean }): Promise<void>;

  members: {
    list(): Promise<Member[]>;
    /** Calls back with everyone's presence now and on every change. */
    presence(listener: (presence: Presence[]) => void): Unsubscribe;
    /** Who and what a mention picker offers for what was typed. */
    mentionables(query: string): Promise<Mentionable[]>;
  };

  chat: {
    /** Posts an APP message with an Open card to a channel or DM. */
    post(target: ChatTarget, spans: Span[], card?: Card): Promise<{ message_id: string }>;
    openChat(target: ChatTarget): Promise<void>;
    notify(userId: string, text: string, route?: Route): Promise<void>;
  };

  files: {
    pick(options?: PickOptions): Promise<FileRef[]>;
    /** Opens a Space file in the app that handles it (this one, or another installed one). */
    open(fileId: string, appId?: string): Promise<void>;
    /**
     * Saves into the Space's drive, in the app's own folder (`/<App name>/`) unless `folder` says
     * otherwise. Saving a file the app opened replaces it; if someone changed it meanwhile, a text
     * file merges both, and anything else keeps the last save, with the one it replaced in the trash.
     */
    save(options: SaveOptions): Promise<FileRef>;
    list(options?: ListFilesOptions): Promise<FilePage>;
    watch(listener: (change: FileChange) => void, options?: { folder?: string; accept?: string[] }): Unsubscribe;
    upload(options: UploadOptions): Promise<FileRef>;
    download(fileId: string): Promise<{ file: FileRef; data: ArrayBuffer }>;
  };

  /** A live Yjs document on the Space's collaboration rooms. Call `destroy()` when done. */
  room(id: string, options?: RoomOptions): Room;

  /**
   * The Space's voice channels and this window's call, for showing them in the app's own interface. The
   * call itself runs in Misty's window, end-to-end encrypted; the app never touches its sound or video.
   * Needs the `calls` permission.
   */
  calls: {
    /** Calls back with the voice channels and who is in each, now and on every change. */
    channels(listener: (channels: VoiceChannel[]) => void): Unsubscribe;
    /** Calls back with this window's call (its channel, its microphone), now and on every change. */
    current(listener: (call: CallState) => void): Unsubscribe;
    /** Drops into a voice channel, out of the one this window is in first. */
    join(channelId: string): Promise<void>;
    leave(): Promise<void>;
    setMuted(muted: boolean): Promise<void>;
  };

  /** The app's MCP stream, for `mcp: frame` apps; hand it to the official MCP library. */
  mcpTransport(): FrameTransport;

  /** Fires once when the host closes the channel (the tab closed or Misty is quitting). */
  onClose(listener: () => void): Unsubscribe;
  close(): void;
}

export interface CreateMistyOptions {
  /** Apply the host's theme to the document now and on every change. On by default in a browser. */
  applyTheme?: boolean;
}

/** Builds the client over an open channel and the context the host sent. Hosts and tests use this directly. */
export function createMisty(channel: Channel, context: AppContext, options: CreateMistyOptions = {}): Misty {
  return buildMisty(new Connection(channel), context, options);
}

function buildMisty(connection: Connection, context: AppContext, options: CreateMistyOptions): Misty {
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

  return {
    appId: context.app_id,
    permissions: context.permissions,
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
    room: (id, roomOptions) => openRoom(connection, id, roomOptions),
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
  /** How long to wait for the host to start the app before giving up. Default 10 seconds. */
  timeoutMs?: number;
}

/** The start message as it arrived, kept until `connect()` asks for it. */
interface StartMessage {
  version: unknown;
  port: MessagePort;
}

/** Whether a window message is the host's start message: from the frame's parent (or the page itself) with a port. */
function startMessageOf(event: MessageEvent): StartMessage | undefined {
  // The frame's parent starts a sandboxed frame; a webview starts itself.
  if (event.source !== window.parent && event.source !== window) return undefined;
  const data = event.data as Partial<InitMessage> | null;
  const port = event.ports[0];
  if (!data || data.type !== INIT_MESSAGE || !port) return undefined;
  return { version: data.version, port };
}

// The host starts the app when its frame has loaded, which can be before the app's own code gets as far as
// calling `connect()` (a framework mounts a tick later). So the message is caught here, when this module
// loads, and kept for `connect()`.
let early: StartMessage | undefined;
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    const start = startMessageOf(event);
    if (start) early = start;
  });
}

/**
 * Connects an app running inside Misty. Takes the start message the host sent (waiting for it if it hasn't
 * come), takes the channel it hands over and asks for the app's context. Rejects when the page isn't running
 * inside Misty.
 */
export function connect(options: ConnectOptions = {}): Promise<Misty> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise<Misty>((resolve, reject) => {
    const waiting: { timer?: ReturnType<typeof setTimeout> } = {};
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(waiting.timer);
    };
    const begin = ({ version, port }: StartMessage) => {
      cleanup();
      if (version !== PROTOCOL_VERSION) {
        port.close();
        reject(
          new MistyError(
            "unsupported",
            `This Misty speaks protocol ${String(version)}, but the app's SDK speaks ${PROTOCOL_VERSION}.`,
          ),
        );
        return;
      }
      const connection = new Connection(port);
      connection
        .call("hello", { sdk: SDK_VERSION, protocol: PROTOCOL_VERSION })
        .then((context) => resolve(buildMisty(connection, context, options)))
        .catch((error: unknown) => {
          connection.close();
          reject(error instanceof Error ? error : new MistyError("internal", String(error)));
        });
    };
    const onMessage = (event: MessageEvent) => {
      const start = startMessageOf(event);
      if (start) begin(start);
    };
    if (early) {
      const start = early;
      early = undefined;
      begin(start);
      return;
    }
    waiting.timer = setTimeout(() => {
      cleanup();
      reject(new MistyError("unsupported", "This page isn't running inside Misty."));
    }, timeoutMs);
    window.addEventListener("message", onMessage);
  });
}

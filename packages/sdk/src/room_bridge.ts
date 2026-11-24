import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { BridgeRoom } from "./bridge_room.js";
import { MistyError, asMistyError } from "./errors.js";
import type { FileRoomOpener, FileRoomSession } from "./file_room_session.js";
import { ROOM_OPTIONS_FEATURE, type RoomEvent, type RoomProblemCode } from "./protocol.js";
import { AGENT_CLAIM } from "./agents.js";
import { IDENTITY_FIELD } from "./room_client.js";
import type { AgentCaller } from "./types.js";
import { withTimeout } from "./timing.js";

export type { BridgeRoom } from "./bridge_room.js";
export { bridgeRoomOf } from "./bridge_room.js";

export type RoomStamp = Record<string, unknown>;

export interface RoomSourceOptions {
  gc: boolean;
  history?: boolean;
  key?: string;
  signal?: AbortSignal;
}

export type RoomSource = (id: string, options: RoomSourceOptions) => BridgeRoom | Promise<BridgeRoom>;

const FROM_APP = Symbol("misty-app-room");

const ROOM_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const FILE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

const DOTS_ONLY = /^\.+$/;

const FILE_ROOM = "file/";

export const ROOM_STALL_MS = 20_000;

const MAX_APP_CLIENTS = 16;

const RETIRED_KEPT = 64;

export const BRIDGE_CALLS = ["room.update", "room.awareness", "room.sync", "room.serialized", "room.option"] as const;

export const BRIDGE_TOPICS = ["room", "room.connection", "room.problem", ROOM_OPTIONS_FEATURE] as const;

export const isRoomId = (id: string) => ROOM_ID.test(id) && !DOTS_ONLY.test(id);

export const isFileRoomId = (id: string) => FILE_ID.test(id) && !DOTS_ONLY.test(id);

const PROBLEM_CODES: ReadonlySet<string> = new Set<RoomProblemCode>([
  "too_large",
  "too_large_warning",
  "stalled",
  "read_only",
  "save_failed",
  "reloaded",
]);

const openError = (error: unknown): MistyError =>
  error instanceof MistyError
    ? error
    : asMistyError(error, "internal").code === "internal"
      ? new MistyError("internal", "The room couldn't be opened. Check your connection and try again.")
      : asMistyError(error);

const optionsOf = (value: unknown): { key?: string; text?: string | null; history?: boolean } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const said = value as Record<string, unknown>;
  return {
    ...(typeof said.key === "string" && said.key ? { key: said.key } : {}),
    ...(typeof said.text === "string" || said.text === null ? { text: said.text as string | null } : {}),
    ...(typeof said.history === "boolean" ? { history: said.history } : {}),
  };
};

const carriedUpdate = (message: Uint8Array): Uint8Array | null => {
  try {
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    if (type !== syncProtocol.messageYjsSyncStep2 && type !== syncProtocol.messageYjsUpdate)
      return null;
    return decoding.readVarUint8Array(decoder);
  } catch {
    return null;
  }
};

const syncMessageOf = (write: (encoder: encoding.Encoder) => void) => {
  const encoder = encoding.createEncoder();
  write(encoder);
  return encoding.toUint8Array(encoder);
};

interface OpenRoom {
  room?: BridgeRoom;
  ready: Promise<BridgeRoom>;
  file?: FileRoomSession;
  queued: { kind: "update" | "awareness"; bytes: Uint8Array }[];
  mine: Set<number>;
  foreign: Set<number>;
  clocks: Map<number, number>;
  states: Map<number, string | null>;
  agents: Map<number, string>;
}

export interface RoomBridgeOptions {
  identity: RoomStamp | (() => RoomStamp);
  agents?: () => readonly AgentCaller[];
  source: RoomSource;
  files?: FileRoomOpener;
}

export interface RoomBridge {
  calls: Record<(typeof BRIDGE_CALLS)[number], (params: Record<string, unknown>) => Promise<unknown>>;
  subscribe(params: Record<string, unknown>, emit: (event: RoomEvent) => void, end: (error?: MistyError) => void): () => void;
  agentsChanged(): void;
}

export function createRoomBridge(options: RoomBridgeOptions): RoomBridge {
  const { source } = options;
  const identity = () => (typeof options.identity === "function" ? options.identity() : options.identity);
  const allowedAgent = (id: unknown): AgentCaller | null => {
    if (typeof id !== "string" || !id) return null;
    return options.agents?.().find((agent) => agent.id === id) ?? null;
  };
  const rooms = new Map<string, OpenRoom>();
  const retired = new Map<string, Set<number>>();
  const validRoom = isRoomId;
  const validFile = isFileRoomId;
  const roomId = (params: Record<string, unknown>) => {
    const id = params.id;
    const valid =
      typeof id === "string" &&
      (validRoom(id) || (id.startsWith(FILE_ROOM) && validFile(id.slice(FILE_ROOM.length))));
    if (!valid) throw new MistyError("invalid", "That isn't a room id.");
    return id;
  };
  const opened = (params: Record<string, unknown>) => {
    const open = rooms.get(roomId(params));
    if (!open) throw new MistyError("invalid", "Join the room first.");
    return open;
  };
  const bytes = (value: unknown, what = "The update") => {
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object Uint8Array]") {
      const view = value as Uint8Array;
      return value instanceof Uint8Array
        ? view
        : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (tag === "[object ArrayBuffer]") return new Uint8Array(value as ArrayBuffer);
    throw new MistyError("invalid", `${what} is missing.`);
  };
  const retire = (id: string, clients: Set<number>) => {
    if (!clients.size) return;
    const kept = retired.get(id) ?? new Set<number>();
    for (const client of clients) kept.add(client);
    for (const client of kept) {
      if (kept.size <= RETIRED_KEPT) break;
      kept.delete(client);
    }
    retired.set(id, kept);
  };
  const encodeEntries = (
    room: BridgeRoom,
    open: OpenRoom,
    entries: [number, string | null][],
    step: number,
  ) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, entries.length);
    for (const [client, json] of entries) {
      const clock =
        Math.max(open.clocks.get(client) ?? 0, room.awareness.meta.get(client)?.clock ?? 0) + step;
      open.clocks.set(client, clock);
      open.states.set(client, json);
      encoding.writeVarUint(encoder, client);
      encoding.writeVarUint(encoder, clock);
      encoding.writeVarString(encoder, json ?? "null");
    }
    return encoding.toUint8Array(encoder);
  };
  const stamp = (id: string, open: OpenRoom, room: BridgeRoom, update: Uint8Array) => {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const states = room.awareness.getStates();
    const gone = retired.get(id);
    const entries: [number, string | null][] = [];
    for (let index = 0; index < count; index += 1) {
      const client = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder);
      const json = decoding.readVarString(decoder);
      if (client === room.awareness.clientID || open.foreign.has(client) || gone?.has(client))
        continue;
      const state: unknown = JSON.parse(json);
      if (!open.mine.has(client)) {
        if (states.has(client)) {
          open.foreign.add(client);
          continue;
        }
        if (state === null || open.mine.size >= MAX_APP_CLIENTS) continue;
        open.mine.add(client);
      }
      const fields =
        typeof state === "object" && state !== null && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
      const claim = state === null ? undefined : fields[AGENT_CLAIM];
      if (claim === undefined) {
        open.agents.delete(client);
        entries.push([client, state === null ? null : JSON.stringify({ ...fields, [IDENTITY_FIELD]: identity() })]);
        continue;
      }
      const agent = allowedAgent(claim);
      if (!agent) {
        open.agents.delete(client);
        if (open.states.get(client) !== undefined && open.states.get(client) !== null) entries.push([client, null]);
        continue;
      }
      open.agents.set(client, agent.id);
      entries.push([
        client,
        JSON.stringify({
          ...fields,
          [IDENTITY_FIELD]: { ...identity(), agent: { id: agent.id, name: agent.name } },
        }),
      ]);
    }
    return entries.length ? encodeEntries(room, open, entries, 1) : null;
  };
  const apply = (
    id: string,
    open: OpenRoom,
    room: BridgeRoom,
    kind: "update" | "awareness",
    update: Uint8Array,
  ) => {
    if (kind === "update") {
      if (open.file && !open.file.admit(update)) return;
      Y.applyUpdate(room.doc, update, FROM_APP);
      return;
    }
    const stamped = stamp(id, open, room, update);
    if (stamped) applyAwarenessUpdate(room.awareness, stamped, FROM_APP);
  };
  const restore = (open: OpenRoom, room: BridgeRoom) => {
    const entries = [...open.states].filter(
      (entry): entry is [number, string] => entry[1] !== null,
    );
    if (!entries.length) return;
    const states = room.awareness.getStates();
    const present = entries.filter(([client]) => states.has(client)).map(([client]) => client);
    applyAwarenessUpdate(room.awareness, encodeEntries(room, open, entries, 2), FROM_APP);
    if (present.length) room.resend?.(present);
  };
  const take = (kind: "update" | "awareness") => async (params: Record<string, unknown>) => {
    const id = roomId(params);
    const open = opened(params);
    const update = bytes(params.update);
    if (open.room) apply(id, open, open.room, kind, update);
    else open.queued.push({ kind, bytes: update });
  };

  const agentsChanged = () => {
    for (const open of rooms.values()) {
      const room = open.room;
      if (!room || !open.agents.size) continue;
      const leaving = [...open.agents].filter(([, id]) => !allowedAgent(id)).map(([client]) => client);
      if (!leaving.length) continue;
      for (const client of leaving) open.agents.delete(client);
      applyAwarenessUpdate(
        room.awareness,
        encodeEntries(room, open, leaving.map((client): [number, null] => [client, null]), 1),
        FROM_APP,
      );
    }
  };

  return {
    agentsChanged,
    calls: {
      "room.update": take("update"),
      "room.awareness": take("awareness"),
      "room.sync": async (params: Record<string, unknown>) => {
        const open = opened(params);
        const message = bytes(params.message, "The sync message");
        const room = await withTimeout(
          open.ready.then(async (ready) => {
            await ready.synced;
            return ready;
          }),
          ROOM_STALL_MS,
          "The room hasn't connected yet. Try again in a moment.",
        );
        const carried = open.file ? carriedUpdate(message) : null;
        if (carried && open.file && !open.file.admit(carried)) return { messages: [] };
        const reply = encoding.createEncoder();
        const type = syncProtocol.readSyncMessage(
          decoding.createDecoder(message),
          reply,
          room.doc,
          FROM_APP,
        );
        const messages: Uint8Array[] = [];
        if (encoding.length(reply) > 0) messages.push(encoding.toUint8Array(reply));
        if (type === syncProtocol.messageYjsSyncStep1)
          messages.push(syncMessageOf((encoder) => syncProtocol.writeSyncStep1(encoder, room.doc)));
        return { messages };
      },
      "room.option": async (params: Record<string, unknown>) => {
        const open = opened(params);
        const message = params.message;
        if (typeof message !== "object" || message === null || Array.isArray(message))
          throw new MistyError("invalid", "The option message is missing.");
        const option = (message as Record<string, unknown>).option;
        if (typeof option !== "string" || option === "file")
          throw new MistyError("invalid", "That isn't an option message an app may send.");
        const room = open.room ?? (await open.ready);
        if (!room.sendOption?.(message as Record<string, unknown>))
          throw new MistyError("closed", "The room isn't connected right now.");
      },
      "room.serialized": async (params: Record<string, unknown>) => {
        const open = opened(params);
        if (!open.file) throw new MistyError("invalid", "That room isn't a file.");
        const request = params.request;
        if (typeof request !== "number" || !Number.isSafeInteger(request))
          throw new MistyError("invalid", "The request is missing.");
        if (typeof params.error === "string")
          return open.file.serializeFailed(request, params.error);
        await open.file.serialized(request, bytes(params.data, "The file's bytes"));
      },
    },
    subscribe(params, emit, end) {
      const fileId = params.file;
      const isFile = fileId !== undefined;
      if (isFile && (typeof fileId !== "string" || !validFile(fileId)))
        throw new MistyError("invalid", "That isn't a file.");
      const openFile = options.files;
      if (isFile && !openFile)
        throw new MistyError("unsupported", "Files can't be opened as live documents here.");
      const id = isFile ? `${FILE_ROOM}${fileId as string}` : roomId(params);
      if (!isFile && id.startsWith(FILE_ROOM))
        throw new MistyError("invalid", "That isn't a room id.");
      if (rooms.has(id)) throw new MistyError("conflict", "The app is already in that room.");
      const syncs = params.sync === true;
      const gc = params.gc !== false;
      const asked = optionsOf(params.options);
      let resolveReady!: (room: BridgeRoom) => void;
      let rejectReady!: (error: unknown) => void;
      const entry: OpenRoom = {
        queued: [],
        ready: new Promise<BridgeRoom>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        }),
        mine: new Set(),
        foreign: new Set(),
        clocks: new Map(),
        states: new Map(),
        agents: new Map(),
      };
      entry.ready.catch(() => undefined);
      rooms.set(id, entry);
      const abort = new AbortController();
      let closed = false;
      const stops: (() => void)[] = [];
      let stall: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const watch = () => {
        clearTimeout(stall);
        stall = undefined;
        if (stopped) return;
        stall = setTimeout(() => {
          stall = undefined;
          if (!closed)
            emit({
              type: "problem",
              code: "stalled",
              message: "The room hasn't connected yet. Misty keeps trying.",
            });
        }, ROOM_STALL_MS);
      };
      const settled = () => {
        clearTimeout(stall);
        stall = undefined;
      };
      const leave = () => {
        if (closed) return;
        closed = true;
        rooms.delete(id);
        settled();
        for (const stop of stops.splice(0)) stop();
        abort.abort();
        rejectReady(new MistyError("cancelled", "The app left the room."));
        retire(id, entry.mine);
        const room = entry.room;
        if (room) {
          const states = room.awareness.getStates();
          const present = [...entry.mine].filter((client) => states.has(client));
          if (present.length) removeAwarenessStates(room.awareness, present, FROM_APP);
        }
        if (entry.file) entry.file.close();
        else room?.close();
      };
      const fail = (error: MistyError) => {
        if (closed) return;
        leave();
        end(error);
      };
      const roomLost = (room: BridgeRoom) => {
        if (closed) return;
        fail(room.lost() ?? new MistyError("closed", "The room was closed."));
      };
      watch();

      const opening =
        isFile && openFile
          ? openFile(fileId as string, { gc, ...asked, signal: abort.signal }, emit, fail).then(
              (session) => {
                entry.file = session;
                return session.room;
              },
            )
          : Promise.resolve(
              source(id, {
                gc,
                ...(asked.history === undefined ? {} : { history: asked.history }),
                ...(asked.key === undefined ? {} : { key: asked.key }),
                signal: abort.signal,
              }),
            );

      void opening
        .then((room) => {
          if (closed) {
            if (entry.file) entry.file.close();
            else room.close();
            return;
          }
          entry.room = room;
          const onUpdate = (update: Uint8Array, origin: unknown) => {
            if (origin !== FROM_APP && !closed) emit({ type: "sync", update });
          };
          const onAwareness = (
            { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
            origin: unknown,
          ) => {
            if (closed || origin === FROM_APP) return;
            const theirs = [...added, ...updated, ...removed].filter(
              (client) => !entry.mine.has(client),
            );
            if (!theirs.length) return;
            for (const client of theirs) entry.foreign.add(client);
            emit({ type: "awareness", update: encodeAwarenessUpdate(room.awareness, theirs) });
          };
          room.awareness.on("update", onAwareness);
          stops.push(() => room.awareness.off("update", onAwareness));
          stops.push(
            room.onLost(() => {
              if (closed || !room.lost()) return;
              roomLost(room);
            }),
          );
          if (room.onProblem)
            stops.push(
              room.onProblem((problem) => {
                if (closed) return;
                if (problem.code === "too_large") {
                  stopped = true;
                  settled();
                }
                if (PROBLEM_CODES.has(problem.code))
                  emit({ type: "problem", code: problem.code as RoomProblemCode, message: problem.message });
              }),
            );
          if (room.onOption)
            stops.push(
              room.onOption((message) => {
                if (!closed) emit({ type: "option", message });
              }),
            );
          for (const { kind, bytes: queued } of entry.queued.splice(0))
            apply(id, entry, room, kind, queued);
          if (room.lost()) {
            roomLost(room);
            return;
          }
          void room.synced.then(() => {
            if (closed) return;
            settled();
            if (syncs)
              emit({
                type: "message",
                message: syncMessageOf((encoder) => syncProtocol.writeSyncStep1(encoder, room.doc)),
              });
            else emit({ type: "sync", update: Y.encodeStateAsUpdate(room.doc) });
            room.doc.on("update", onUpdate);
            stops.push(() => room.doc.off("update", onUpdate));
            if (room.onConnection)
              stops.push(
                room.onConnection((connected) => {
                  if (closed) return;
                  if (!connected) {
                    watch();
                    emit({ type: "connection", connected: false });
                    return;
                  }
                  stopped = false;
                  settled();
                  if (syncs)
                    emit({
                      type: "message",
                      message: syncMessageOf((encoder) =>
                        syncProtocol.writeSyncStep1(encoder, room.doc),
                      ),
                    });
                  restore(entry, room);
                  emit({ type: "connection", connected: true });
                }),
              );
            resolveReady(room);
            entry.file?.started();
            const others = [...room.awareness.getStates().keys()].filter(
              (client) => !entry.mine.has(client),
            );
            for (const client of others) entry.foreign.add(client);
            if (others.length)
              emit({ type: "awareness", update: encodeAwarenessUpdate(room.awareness, others) });
          });
        })
        .catch((error: unknown) => {
          if (closed) return;
          fail(openError(error));
        });
      return leave;
    },
  };
}

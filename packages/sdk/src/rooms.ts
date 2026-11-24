import * as Y from "yjs";
import { bytesOf } from "./base64.js";
import { bridgeRoomOf } from "./bridge_room.js";
import type { Unsubscribe } from "./connection.js";
import { MistyError, asMistyError, safely } from "./errors.js";
import { fileRoomOpener } from "./file_room_session.js";
import type { FileStore } from "./file_store.js";
import type { RoomEvent, RoomWireOptions } from "./protocol.js";
import { openFileRoom, settledWrites } from "./room.js";
import type { FileRoom, FileRoomOptions, Room, RoomLink, RoomOptions } from "./room.js";
import { createRoomBridge, type RoomBridge } from "./room_bridge.js";
import { openRoomClient, type RoomClient } from "./room_client.js";
import type { RequestTransport, Transport } from "./transport.js";
import type { Identity } from "./types.js";

export interface RoomOpener {
  (key: string, options: FileRoomOptions & { file: string }): FileRoom;
  (key: string, options?: RoomOptions): Room;
  forFile(fileId: string, options?: FileRoomOptions): FileRoom;
}

export interface ReadOptions {
  as?: "doc" | "json";
}

export type RoomEdit = (doc: Y.Doc) => void | Promise<void>;

export interface Rooms {
  room: RoomOpener;
  read(key: string, options?: { as?: "doc" }): Promise<Y.Doc | null>;
  read(key: string, options: { as: "json" }): Promise<Record<string, unknown> | null>;
  change(key: string, edit: RoomEdit, options?: RoomOptions): Promise<void>;
}

const JOIN_BOUND_MS = 60_000;

export function wireOptionsOf(options: RoomOptions = {}): RoomWireOptions {
  return {
    ...(options.file === undefined ? {} : { file: options.file }),
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.gc === undefined ? {} : { gc: options.gc }),
  };
}

export function roomOver(client: RoomClient, release: () => void): Room {
  const errorListeners = new Set<(error: MistyError) => void>();
  const stopProblems = client.onProblem((problem) => {
    for (const listener of [...errorListeners]) safely(() => listener(problem));
  });
  let destroyed = false;
  let up = true;
  const stopUp = client.onConnection((connected) => {
    up = connected;
  });
  const stopLost = client.onLost(() => release());
  return {
    id: client.key,
    doc: client.doc,
    awareness: client.awareness,
    synced: client.synced,
    get lost() {
      return client.lost;
    },
    get connected() {
      return !destroyed && client.lost === null && up;
    },
    onLost(listener) {
      return client.onLost(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onConnection(listener) {
      return client.onConnection(listener);
    },
    history: client.history,
    identity: (clientId) => client.identity(clientId),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopProblems();
      stopLost();
      stopUp();
      errorListeners.clear();
      release();
      client.close();
    },
  };
}

function waitFor(synced: Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const bound = setTimeout(() => reject(new MistyError("stalled", "The room didn't connect in time.")), JOIN_BOUND_MS);
    synced.then(
      () => {
        clearTimeout(bound);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(bound);
        reject(asMistyError(error));
      },
    );
  });
}

export interface RoomRequestsOptions {
  space: string;
  request?: RequestTransport;
  join(key: string, options: RoomOptions): Room;
}

export function roomRequests(options: RoomRequestsOptions): Pick<Rooms, "read" | "change"> {
  const { space, request } = options;
  const joined = async <T>(key: string, roomOptions: RoomOptions, use: (room: Room) => Promise<T>): Promise<T> => {
    const room = options.join(key, roomOptions);
    try {
      await waitFor(room.synced);
      return await use(room);
    } finally {
      room.destroy();
    }
  };
  const docFrom = (update: Uint8Array | null) => {
    if (update === null) return null;
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, update);
    return doc;
  };
  const read = async (key: string, readOptions: ReadOptions = {}): Promise<Y.Doc | Record<string, unknown> | null> => {
    const json = readOptions.as === "json";
    if (request) {
      const answer = await request.read({ space, key, as: json ? "json" : "update" });
      if (answer === null) return null;
      return json ? (answer as Record<string, unknown>) : docFrom(bytesOf(answer));
    }
    return joined(key, {}, async (room) => {
      if (json) return room.doc.toJSON() as Record<string, unknown>;
      return docFrom(Y.encodeStateAsUpdate(room.doc));
    });
  };
  const change = async (key: string, edit: RoomEdit, roomOptions: RoomOptions = {}): Promise<void> => {
    if (request) {
      const current = await request.read({ space, key, as: "update" });
      const doc = new Y.Doc({ gc: roomOptions.gc ?? true });
      try {
        if (current !== null) Y.applyUpdate(doc, bytesOf(current));
        const before = Y.encodeStateVector(doc);
        await edit(doc);
        const update = Y.encodeStateAsUpdate(doc, before);
        if (sameUpdate(update)) return;
        const wire = wireOptionsOf(roomOptions);
        await request.write({ space, key, update, ...(Object.keys(wire).length ? { options: wire } : {}) });
      } finally {
        doc.destroy();
      }
      return;
    }
    await joined(key, roomOptions, async (room) => {
      await edit(room.doc);
      await settledWrites(room);
    });
  };
  return { read: read as Rooms["read"], change };
}

const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc());

const sameUpdate = (update: Uint8Array) =>
  update.length === EMPTY_UPDATE.length && update.every((byte, index) => byte === EMPTY_UPDATE[index]);

export function localLink(bridge: RoomBridge): RoomLink {
  return {
    call: (method, params) => bridge.calls[method](params as unknown as Record<string, unknown>) as Promise<never>,
    subscribe(_topic, params, listener, onEnd) {
      let left = false;
      let finished = false;
      let stop: (() => void) | null = null;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        queueMicrotask(() => {
          if (!left) onEnd(error === undefined ? undefined : asMistyError(error));
        });
      };
      try {
        stop = bridge.subscribe(
          params as unknown as Record<string, unknown>,
          (event: RoomEvent) =>
            queueMicrotask(() => {
              if (!left) listener(event);
            }),
          finish,
        );
      } catch (error) {
        finish(error);
        return () => {
          left = true;
        };
      }
      return () => {
        if (left) return;
        left = true;
        if (!finished) stop?.();
      };
    },
    onReset: () => () => undefined,
  };
}

export interface DirectRoomsOptions {
  transport: Transport;
  space: string;
  identity: Identity;
  files?: FileStore | (() => FileStore);
  notice?(message: string): void;
}

export interface DirectRooms extends Rooms {
  close(): void;
  onClose(listener: () => void): Unsubscribe;
}

export function directRooms(options: DirectRoomsOptions): DirectRooms {
  const { transport, space, identity } = options;
  const open = new Map<string, () => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  let store: FileStore | null = null;
  const storeOf = (): FileStore => {
    if (store) return store;
    const given = typeof options.files === "function" ? options.files() : options.files;
    if (!given) throw new MistyError("unsupported", "This connection has no drive to open files from.");
    store = given;
    return given;
  };
  const claim = (key: string) => {
    if (closed) throw new MistyError("closed", "This connection is closed.");
    if (open.has(key))
      throw new MistyError("conflict", "This room is already open in this app. Use the open one, or destroy it first.");
  };
  const clientFor = (key: string, wire: RoomWireOptions) =>
    openRoomClient({ transport, space, key, options: wire, identity });
  const plain = (key: string, roomOptions: RoomOptions = {}): Room => {
    claim(key);
    const client = clientFor(key, wireOptionsOf({ ...roomOptions, file: undefined }));
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      if (open.get(key) === destroy) open.delete(key);
    };
    const room = roomOver(client, release);
    const destroy = () => room.destroy();
    open.set(key, destroy);
    return room;
  };
  let bridge: RoomBridge | null = null;
  const bridgeOf = () => {
    if (bridge) return bridge;
    const files = storeOf();
    bridge = createRoomBridge({
      identity: () => ({ user_id: identity.user_id, id: identity.user_id, name: identity.name, tone: identity.tone }),
      source: (id, sourceOptions) =>
        bridgeRoomOf(
          clientFor(sourceOptions.key ?? id, {
            ...(sourceOptions.gc ? {} : { gc: false }),
            ...(sourceOptions.history === undefined ? {} : { history: sourceOptions.history }),
          }),
        ),
      files: fileRoomOpener({
        store: files,
        open: (fileOptions) =>
          clientFor(fileOptions.key, {
            file: fileOptions.file,
            ...(fileOptions.text === undefined ? {} : { text: fileOptions.text }),
            ...(fileOptions.history === undefined ? {} : { history: fileOptions.history }),
            ...(fileOptions.gc ? {} : { gc: false }),
          }),
        ...(options.notice ? { notice: options.notice } : {}),
      }),
    });
    return bridge;
  };
  const host = { syncs: true, me: identity, options: true, option: true };
  const fileRoom = (key: string, fileId: string, fileOptions: FileRoomOptions = {}): FileRoom => {
    claim(key);
    const link = localLink(bridgeOf());
    const room = openFileRoom(link, fileId, { ...fileOptions, key }, host);
    const destroy = () => room.destroy();
    open.set(key, destroy);
    const forget = () => {
      if (open.get(key) === destroy) open.delete(key);
    };
    room.onLost(forget);
    const leave = room.destroy.bind(room);
    Object.defineProperty(room, "destroy", {
      value: () => {
        forget();
        leave();
      },
    });
    return room;
  };
  const room = ((key: string, roomOptions?: RoomOptions & FileRoomOptions) => {
    if (roomOptions?.file !== undefined) {
      const { file, ...rest } = roomOptions;
      return fileRoom(key, file, rest);
    }
    return plain(key, roomOptions);
  }) as RoomOpener;
  room.forFile = (fileId, fileOptions) => fileRoom(fileId, fileId, fileOptions);
  const requests = roomRequests({
    space,
    ...(transport.request ? { request: transport.request } : {}),
    join: (key, roomOptions) => {
      if (closed) throw new MistyError("closed", "This connection is closed.");
      return roomOver(clientFor(key, wireOptionsOf({ ...roomOptions, file: undefined })), () => undefined);
    },
  });
  return {
    room,
    read: requests.read,
    change: requests.change,
    close() {
      if (closed) return;
      closed = true;
      for (const destroy of [...open.values()]) destroy();
      open.clear();
      for (const listener of [...closeListeners]) safely(listener);
      closeListeners.clear();
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
}

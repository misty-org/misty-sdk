import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Connection, Unsubscribe } from "./connection.js";
import { MistyError } from "./errors.js";
import type { RoomEvent, RoomParams } from "./protocol.js";
import type { AvatarTone, FileFormat, FileRef, Identity } from "./types.js";

export const IDENTITY_FIELD = "misty";

export const FILE_META = "misty:file";

export const FILE_TEXT = "text";

export interface RoomOptions {
  gc?: boolean;
}

export interface Room {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly synced: Promise<void>;
  readonly lost: MistyError | null;
  onLost(listener: (error: MistyError) => void): Unsubscribe;
  onError(listener: (error: MistyError) => void): Unsubscribe;
  identity(clientId: number): Identity | null;
  destroy(): void;
}

export type FileData = Uint8Array | ArrayBuffer | Blob | string;

export interface FileRoomOptions extends RoomOptions {
  load?(data: ArrayBuffer, doc: Y.Doc): void | Promise<void>;
  serialize?(doc: Y.Doc): FileData | Promise<FileData>;
}

export interface FileRoom extends Room {
  readonly fileId: string;
  readonly file: FileRef | null;
  readonly format: FileFormat | null;
  readonly text: Y.Text;
  readonly writer: boolean;
  readonly ready: Promise<void>;
  onFile(listener: (file: FileRef) => void): Unsubscribe;
  onWriter(listener: (writer: boolean) => void): Unsubscribe;
}

export interface RoomHost {
  syncs: boolean;
  me: Identity;
}

const REMOTE = Symbol("misty-room-remote");

const TONES: ReadonlySet<string> = new Set(["red", "orange", "yellow", "green", "blue", "purple", "gray"]);

const FATAL: ReadonlySet<string> = new Set(["closed", "not_found", "permission_denied", "cancelled"]);

function identityOf(state: unknown): Identity | null {
  if (typeof state !== "object" || state === null) return null;
  const found = (state as Record<string, unknown>)[IDENTITY_FIELD];
  if (typeof found !== "object" || found === null) return null;
  const { user_id: userId, name, tone } = found as Record<string, unknown>;
  if (typeof userId !== "string" || !userId) return null;
  return {
    user_id: userId,
    name: typeof name === "string" ? name : "",
    tone: typeof tone === "string" && TONES.has(tone) ? (tone as AvatarTone) : null,
  };
}

const bytesOf = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(0);
};

async function fileBytes(data: FileData): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return bytesOf(data);
}

const asError = (error: unknown): MistyError =>
  error instanceof MistyError ? error : new MistyError("internal", error instanceof Error ? error.message : String(error));

export function openRoom(connection: Connection, id: string, options: RoomOptions, host: RoomHost): Room {
  return open(connection, { id }, id, options, host);
}

export function openFileRoom(
  connection: Connection,
  fileId: string,
  options: FileRoomOptions,
  host: RoomHost,
): FileRoom {
  return open(connection, { file: fileId }, `file/${fileId}`, options, host) as FileRoom;
}

function open(
  connection: Connection,
  target: { id: string } | { file: string },
  wireId: string,
  options: FileRoomOptions,
  host: RoomHost,
): Room | FileRoom {
  const gc = options.gc ?? true;
  const doc = new Y.Doc({ gc });
  const awareness = new Awareness(doc);
  const syncs = host.syncs;
  let destroyed = false;
  let lost: MistyError | null = null;
  let dirty = syncs;
  let awarenessDirty = false;
  let resyncing = false;
  const lostListeners = new Set<(error: MistyError) => void>();
  const errorListeners = new Set<(error: MistyError) => void>();
  let resolveSynced!: () => void;
  let rejectSynced!: (error: Error) => void;
  const synced = new Promise<void>((resolve, reject) => {
    resolveSynced = resolve;
    rejectSynced = reject;
  });
  synced.catch(() => {});

  let file: FileRef | null = null;
  let format: FileFormat | null = null;
  let writer = false;
  const fileListeners = new Set<(file: FileRef) => void>();
  const writerListeners = new Set<(writer: boolean) => void>();
  let resolveFile!: () => void;
  const fileKnown = new Promise<void>((resolve) => {
    resolveFile = resolve;
  });
  const ready = Promise.all([synced, fileKnown]).then(() => undefined);
  ready.catch(() => {});

  const lose = (error: MistyError) => {
    if (destroyed || lost) return;
    lost = error;
    rejectSynced(error);
    for (const listener of [...lostListeners]) listener(error);
    lostListeners.clear();
    stop();
  };

  const report = (error: MistyError) => {
    for (const listener of [...errorListeners]) listener(error);
  };

  const failed = (error: unknown) => {
    if (destroyed || lost) return;
    const problem = asError(error);
    if (FATAL.has(problem.code)) return lose(problem);
    report(problem);
    if (syncs) {
      dirty = true;
      heal();
    }
  };

  const ask = (message: Uint8Array) => connection.call("room.sync", { id: wireId, message });

  const answer = async (message: Uint8Array): Promise<void> => {
    const encoder = encoding.createEncoder();
    syncProtocol.readSyncMessage(decoding.createDecoder(bytesOf(message)), encoder, doc, REMOTE);
    if (encoding.length(encoder) === 0) return;
    const { messages } = await ask(encoding.toUint8Array(encoder));
    for (const reply of messages) await answer(reply);
  };

  const sendAwareness = () => {
    awarenessDirty = false;
    const update = encodeAwarenessUpdate(awareness, [doc.clientID]);
    connection.call("room.awareness", { id: wireId, update }).catch((error: unknown) => {
      awarenessDirty = true;
      failed(error);
    });
  };

  const resync = async () => {
    resyncing = true;
    dirty = false;
    try {
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, doc);
      const { messages } = await ask(encoding.toUint8Array(encoder));
      for (const reply of messages) await answer(reply);
      resolveSynced();
    } catch (error) {
      const problem = asError(error);
      if (FATAL.has(problem.code)) lose(problem);
      else {
        dirty = true;
        report(problem);
      }
    } finally {
      resyncing = false;
    }
  };

  const heal = () => {
    if (destroyed || lost) return;
    if (awarenessDirty && awareness.getLocalState() !== null) sendAwareness();
    if (!syncs || !dirty || resyncing) return;
    void resync();
  };

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || destroyed || lost) return;
    connection.call("room.update", { id: wireId, update }).then(heal, failed);
  };
  const onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE || destroyed || lost) return;
    const update = encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]);
    connection.call("room.awareness", { id: wireId, update }).catch((error: unknown) => {
      awarenessDirty = true;
      failed(error);
    });
  };
  doc.on("update", onDocUpdate);
  awareness.on("update", onAwarenessUpdate);

  const loadFile = async (version: number, data: ArrayBuffer) => {
    if (!options.load) return;
    const meta = doc.getMap<unknown>(FILE_META);
    if (meta.get("loaded") !== undefined) return;
    try {
      await options.load(data, doc);
      if (!destroyed && !lost) meta.set("loaded", version);
    } catch (error) {
      report(asError(error));
    }
  };

  const serializeFile = async (request: number) => {
    try {
      if (!options.serialize) throw new MistyError("unsupported", "This app can't write this file.");
      const data = await fileBytes(await options.serialize(doc));
      await connection.call("room.serialized", { id: wireId, request, data });
    } catch (error) {
      if (destroyed || lost) return;
      const problem = asError(error);
      if (FATAL.has(problem.code)) return lose(problem);
      await connection
        .call("room.serialized", { id: wireId, request, error: problem.message })
        .catch(failed);
    }
  };

  const receive = (event: RoomEvent) => {
    if (destroyed || lost) return;
    switch (event.type) {
      case "sync":
        Y.applyUpdate(doc, bytesOf(event.update), REMOTE);
        if (!syncs) resolveSynced();
        heal();
        return;
      case "awareness":
        applyAwarenessUpdate(awareness, bytesOf(event.update), REMOTE);
        return;
      case "message":
        answer(bytesOf(event.message)).then(heal, failed);
        return;
      case "file": {
        file = event.file;
        format = event.format;
        const changed = writer !== event.writer;
        writer = event.writer;
        resolveFile();
        for (const listener of [...fileListeners]) listener(event.file);
        if (changed) for (const listener of [...writerListeners]) listener(writer);
        return;
      }
      case "load":
        synced.then(
          () => loadFile(event.version, event.data),
          () => undefined,
        );
        return;
      case "serialize":
        void serializeFile(event.request);
        return;
      default:
        return;
    }
  };

  const params: RoomParams = { ...target, ...(gc ? {} : { gc }), ...(syncs ? { sync: true } : {}) };
  let unsubscribe: Unsubscribe | undefined;
  let stopped = false;
  function stop() {
    stopped = true;
    unsubscribe?.();
    unsubscribe = undefined;
    doc.off("update", onDocUpdate);
    awareness.off("update", onAwarenessUpdate);
  }
  const ended = connection.subscribe("room", params, receive, (error) =>
    lose(error ?? new MistyError("closed", "The room was closed.")),
  );
  if (stopped) ended();
  else unsubscribe = ended;
  if (syncs) heal();

  const room: Room = {
    id: "file" in target ? target.file : target.id,
    doc,
    awareness,
    synced,
    get lost() {
      return lost;
    },
    onLost(listener) {
      if (lost) {
        listener(lost);
        return () => {};
      }
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    identity(clientId) {
      if (clientId === doc.clientID) return host.me;
      return identityOf(awareness.getStates().get(clientId));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lostListeners.clear();
      errorListeners.clear();
      fileListeners.clear();
      writerListeners.clear();
      if (!lost) stop();
      awareness.destroy();
      doc.destroy();
      rejectSynced(new MistyError("cancelled", "The room was left."));
    },
  };
  if (!("file" in target)) return room;

  const fileRoom = room as FileRoom;
  Object.defineProperties(fileRoom, {
    fileId: { value: target.file, enumerable: true },
    file: { get: () => file, enumerable: true },
    format: { get: () => format, enumerable: true },
    text: { get: () => doc.getText(FILE_TEXT), enumerable: true },
    writer: { get: () => writer, enumerable: true },
    ready: { value: ready, enumerable: true },
    onFile: {
      value: (listener: (next: FileRef) => void): Unsubscribe => {
        fileListeners.add(listener);
        return () => fileListeners.delete(listener);
      },
    },
    onWriter: {
      value: (listener: (next: boolean) => void): Unsubscribe => {
        writerListeners.add(listener);
        return () => writerListeners.delete(listener);
      },
    },
  });
  return fileRoom;
}

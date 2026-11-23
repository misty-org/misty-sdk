import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Connection, Unsubscribe } from "./connection.js";
import { MistyError, safely } from "./errors.js";
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
  readonly connected: boolean;
  onLost(listener: (error: MistyError) => void): Unsubscribe;
  onError(listener: (error: MistyError) => void): Unsubscribe;
  onConnection(listener: (connected: boolean) => void): Unsubscribe;
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
  readonly loaded: boolean;
  readonly editable: boolean;
  readonly ready: Promise<void>;
  onFile(listener: (file: FileRef) => void): Unsubscribe;
  onWriter(listener: (writer: boolean) => void): Unsubscribe;
}

export interface RoomHost {
  syncs: boolean;
  me: Identity;
}

const REMOTE = Symbol("misty-room-remote");

const LOADING = Symbol("misty-room-load");

const TONES: ReadonlySet<string> = new Set(["red", "orange", "yellow", "green", "blue", "purple", "gray"]);

const FATAL: ReadonlySet<string> = new Set(["closed", "not_found", "permission_denied", "cancelled"]);

const REOPENS: ReadonlySet<string> = new Set(["internal"]);

const MAX_REOPENS = 8;

const LOAD_BOUND_MS = 100_000;

const MAX_LOAD_FAILURES = 2;

const READY_BOUND_MS = 300_000;

const RETRY_BASE_MS = 500;

const RETRY_MAX_MS = 30_000;

const backoff = (attempt: number): number => {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
};

const openIds = new WeakMap<Connection, Set<string>>();

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

function stopOutdatedCheck(awareness: Awareness): void {
  clearInterval((awareness as unknown as { _checkInterval?: ReturnType<typeof setInterval> })._checkInterval);
}

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
  const taken = openIds.get(connection) ?? new Set<string>();
  if (taken.has(wireId)) {
    throw new MistyError("conflict", "This room is already open in this app. Use the open one, or destroy it first.");
  }
  taken.add(wireId);
  openIds.set(connection, taken);
  const release = () => taken.delete(wireId);

  const isFile = "file" in target;
  const gc = options.gc ?? true;
  const doc = new Y.Doc({ gc });
  const awareness = new Awareness(doc);
  stopOutdatedCheck(awareness);
  const syncs = host.syncs;
  let destroyed = false;
  let lost: MistyError | null = null;
  let subscribed = false;
  let generation = 0;
  let dirty = syncs;
  let awarenessDirty = false;
  let resyncing = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let reopens = 0;
  let reopening = false;
  let reopenTimer: ReturnType<typeof setTimeout> | undefined;
  let connected = true;
  let isSynced = false;
  const held: Uint8Array[] = [];
  const lostListeners = new Set<(error: MistyError) => void>();
  const errorListeners = new Set<(error: MistyError) => void>();
  const connectionListeners = new Set<(connected: boolean) => void>();
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
  let fileSeen = false;
  let fileLoaded: boolean | undefined;
  let editable = true;
  let hasWriter: boolean | undefined;
  let loading = false;
  let nextLoad: { version: number; data: ArrayBuffer } | null = null;
  let loadFailures = 0;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const fileListeners = new Set<(file: FileRef) => void>();
  const writerListeners = new Set<(writer: boolean) => void>();
  const meta = isFile ? doc.getMap<unknown>(FILE_META) : null;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});

  const settleReady = (error?: MistyError) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    readyTimer = undefined;
    if (error) rejectReady(error);
    else resolveReady();
  };

  const markedLoaded = () => meta !== null && meta.get("loaded") !== undefined;

  const contentLoaded = () => fileSeen && (fileLoaded !== false || markedLoaded());

  const checkReady = () => {
    if (!isFile || readySettled || destroyed || lost || !isSynced || !fileSeen) return;
    if (contentLoaded()) return settleReady();
    if (!editable && !writer && hasWriter !== true) {
      settleReady(
        new MistyError("read_only", "Nobody who can edit this file has it open, so it can't be shown live."),
      );
    }
  };

  const markSynced = () => {
    if (isSynced) return;
    isSynced = true;
    resolveSynced();
    checkReady();
    if (isFile && !readySettled && readyTimer === undefined)
      readyTimer = setTimeout(() => {
        readyTimer = undefined;
        if (destroyed || lost) return;
        settleReady(new MistyError("stalled", "The file didn't load in time. Close it and open it again."));
      }, READY_BOUND_MS);
  };

  const report = (error: MistyError) => {
    for (const listener of [...errorListeners]) safely(() => listener(error));
  };

  const setConnected = (next: boolean, refresh: boolean) => {
    if (refresh) refreshAwareness();
    if (connected === next) return;
    connected = next;
    for (const listener of [...connectionListeners]) safely(() => listener(next));
  };

  const lose = (error: MistyError) => {
    if (destroyed || lost) return;
    lost = error;
    stop();
    release();
    rejectSynced(error);
    settleReady(error);
    const listeners = [...lostListeners];
    lostListeners.clear();
    for (const listener of listeners) safely(() => listener(error));
  };

  const retryLater = () => {
    if (destroyed || lost || retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      heal();
    }, backoff(retries));
    retries += 1;
  };

  const failed = (error: unknown) => {
    if (destroyed || lost) return;
    const problem = asError(error);
    if (FATAL.has(problem.code)) return lose(problem);
    report(problem);
    if (syncs) dirty = true;
    retryLater();
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

  function refreshAwareness() {
    if (destroyed || lost || !subscribed) return;
    const state = awareness.getLocalState();
    if (state !== null) awareness.setLocalState({ ...state });
  }

  const settled = () => {
    retries = 0;
    reopens = 0;
    if (!reopening) return;
    reopening = false;
    setConnected(true, false);
  };

  const resync = async () => {
    resyncing = true;
    dirty = false;
    try {
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, doc);
      const { messages } = await ask(encoding.toUint8Array(encoder));
      for (const reply of messages) await answer(reply);
      if (destroyed || lost) return;
      markSynced();
      settled();
    } catch (error) {
      const problem = asError(error);
      if (FATAL.has(problem.code)) {
        lose(problem);
        return;
      }
      dirty = true;
      if (!destroyed && !lost) report(problem);
    } finally {
      resyncing = false;
      if (dirty) retryLater();
    }
  };

  function heal() {
    if (destroyed || lost || !subscribed) return;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (awarenessDirty) sendAwareness();
    if (!syncs || !dirty || resyncing) return;
    void resync();
  }

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || destroyed || lost) return;
    if (!subscribed) {
      if (syncs) dirty = true;
      else held.push(update);
      return;
    }
    connection.call("room.update", { id: wireId, update }).then(heal, failed);
  };
  const onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE || destroyed || lost) return;
    if (!subscribed) {
      awarenessDirty = true;
      return;
    }
    const update = encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]);
    connection.call("room.awareness", { id: wireId, update }).catch((error: unknown) => {
      awarenessDirty = true;
      failed(error);
    });
  };
  doc.on("update", onDocUpdate);
  awareness.on("update", onAwarenessUpdate);
  const onMeta = () => checkReady();
  meta?.observe(onMeta);

  const loadFile = async (version: number, data: ArrayBuffer): Promise<void> => {
    if (!meta || !options.load || destroyed || lost || markedLoaded()) return;
    if (loading) {
      nextLoad = { version, data };
      return;
    }
    if (!writer) return;
    loading = true;
    const scratch = new Y.Doc({ gc });
    let bound: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => options.load?.(data, scratch)),
        new Promise<never>((_, reject) => {
          bound = setTimeout(
            () => reject(new MistyError("stalled", "The app took too long to load this file.")),
            LOAD_BOUND_MS,
          );
        }),
      ]);
      if (destroyed || lost || markedLoaded() || !writer) return;
      const update = Y.encodeStateAsUpdate(scratch);
      doc.transact(() => {
        Y.applyUpdate(doc, update);
        meta.set("loaded", version);
      }, LOADING);
      loadFailures = 0;
    } catch (error) {
      if (destroyed || lost) return;
      const problem = asError(error);
      report(problem);
      loadFailures += 1;
      if (loadFailures >= MAX_LOAD_FAILURES) {
        nextLoad = null;
        settleReady(new MistyError(problem.code, `The app couldn't load this file. ${problem.message}`));
      }
    } finally {
      clearTimeout(bound);
      scratch.destroy();
      loading = false;
      const queued = nextLoad;
      nextLoad = null;
      if (queued && !readySettled) void loadFile(queued.version, queued.data);
    }
  };

  const answerSerialize = (request: number, reply: { data: Uint8Array } | { error: string }) =>
    connection.call("room.serialized", { id: wireId, request, ...reply }).catch((error: unknown) => {
      if (!destroyed && !lost) report(asError(error));
    });

  const serializeFile = async (request: number) => {
    try {
      await synced;
    } catch {
      return;
    }
    if (destroyed || lost) return;
    if (!contentLoaded()) {
      await answerSerialize(request, { error: "The document hasn't loaded yet, so there is nothing to save." });
      return;
    }
    let data: Uint8Array;
    try {
      if (!options.serialize) throw new MistyError("unsupported", "This app can't write this file.");
      data = await fileBytes(await options.serialize(doc));
    } catch (error) {
      if (destroyed || lost) return;
      const problem = asError(error);
      report(problem);
      await answerSerialize(request, { error: problem.message });
      return;
    }
    if (destroyed || lost) return;
    await answerSerialize(request, { data });
  };

  const receive = (event: RoomEvent) => {
    if (destroyed || lost) return;
    switch (event.type) {
      case "sync":
        try {
          Y.applyUpdate(doc, bytesOf(event.update), REMOTE);
        } catch (error) {
          report(asError(error));
        }
        if (!syncs) {
          markSynced();
          settled();
        }
        heal();
        return;
      case "awareness":
        try {
          applyAwarenessUpdate(awareness, bytesOf(event.update), REMOTE);
        } catch (error) {
          report(asError(error));
        }
        return;
      case "message":
        answer(bytesOf(event.message)).then(heal, failed);
        return;
      case "connection":
        setConnected(event.connected, event.connected);
        return;
      case "problem": {
        const problem = new MistyError(event.code, event.message);
        report(problem);
        if (event.code === "reloaded") lose(problem);
        return;
      }
      case "file": {
        file = event.file;
        format = event.format;
        if (event.format === "app" && (!options.load || !options.serialize)) {
          lose(
            new MistyError(
              "unsupported",
              "This app can't keep this file as a live document: it needs both load and serialize.",
            ),
          );
          return;
        }
        const changed = writer !== event.writer;
        writer = event.writer;
        if (typeof event.loaded === "boolean") fileLoaded = event.loaded;
        editable = event.editable !== false;
        hasWriter = typeof event.has_writer === "boolean" ? event.has_writer : undefined;
        fileSeen = true;
        for (const listener of [...fileListeners]) safely(() => listener(event.file));
        if (changed) for (const listener of [...writerListeners]) safely(() => listener(writer));
        checkReady();
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

  const flushHeld = () => {
    if (!held.length) return;
    const update = Y.mergeUpdates(held.splice(0));
    connection.call("room.update", { id: wireId, update }).then(heal, failed);
  };

  const reopen = () => {
    reopenTimer = undefined;
    if (destroyed || lost) return;
    subscribeRoom();
    if (!subscribed) return;
    if (syncs) {
      dirty = true;
      heal();
    } else flushHeld();
    refreshAwareness();
  };

  const onEnd = (error?: MistyError) => {
    if (destroyed || lost) return;
    const problem = error ?? new MistyError("closed", "The room was closed.");
    generation += 1;
    subscribed = false;
    unsubscribe = undefined;
    if (!REOPENS.has(problem.code) || reopens >= MAX_REOPENS) return lose(problem);
    report(problem);
    reopening = true;
    setConnected(false, false);
    reopenTimer = setTimeout(reopen, backoff(reopens));
    reopens += 1;
  };

  function subscribeRoom() {
    const mine = ++generation;
    subscribed = true;
    const ended = connection.subscribe("room", params, receive, (error) => {
      if (mine === generation) onEnd(error);
    });
    if (mine === generation && subscribed) unsubscribe = ended;
    else ended();
  }

  const stopReset = connection.onReset(() => {
    if (destroyed || lost || !subscribed) return;
    if (syncs) dirty = true;
    heal();
    refreshAwareness();
  });

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    generation += 1;
    subscribed = false;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    clearTimeout(reopenTimer);
    reopenTimer = undefined;
    clearTimeout(readyTimer);
    readyTimer = undefined;
    const end = unsubscribe;
    unsubscribe = undefined;
    end?.();
    doc.off("update", onDocUpdate);
    awareness.off("update", onAwarenessUpdate);
    meta?.unobserve(onMeta);
    stopReset();
  }

  subscribeRoom();
  if (syncs) heal();

  const room: Room = {
    id: "file" in target ? target.file : target.id,
    doc,
    awareness,
    synced,
    get lost() {
      return lost;
    },
    get connected() {
      return connected && !lost;
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
    onConnection(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
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
      connectionListeners.clear();
      fileListeners.clear();
      writerListeners.clear();
      stop();
      release();
      awareness.destroy();
      doc.destroy();
      const left = new MistyError("cancelled", "The room was left.");
      rejectSynced(left);
      settleReady(left);
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
    loaded: { get: () => isSynced && contentLoaded(), enumerable: true },
    editable: { get: () => editable, enumerable: true },
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

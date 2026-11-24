import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Unsubscribe } from "./connection.js";
import { MistyError, asMistyError, safely } from "./errors.js";
import { historyOver, type RoomHistory } from "./history.js";
import type { RoomOpened, RoomWireOptions } from "./protocol.js";
import { retryDelay } from "./timing.js";
import {
  CLOSE_CODES,
  FINAL_CLOSES,
  closeError,
  type Transport,
  type TransportConnection,
} from "./transport.js";
import type { AvatarTone, Identity } from "./types.js";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;

export const IDENTITY_FIELD = "misty";

const STEADY_MS = 10_000;
const FULL_BASE_MS = 15_000;
const FULL_CAP_MS = 300_000;

const TONES: ReadonlySet<string> = new Set(["red", "orange", "yellow", "green", "blue", "purple", "gray"]);

export type RoomStatus = "connected" | "disconnected";

export interface SyncTap {
  incoming(message: Uint8Array): boolean;
  outgoing(update: Uint8Array, origin: unknown): boolean;
}

export interface RoomClientOptions {
  transport: Transport;
  space: string;
  key: string;
  options?: RoomWireOptions;
  identity?: Identity;
  doc?: Y.Doc;
}

export interface RoomClient {
  readonly key: string;
  readonly space: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly origin: object;
  readonly synced: Promise<void>;
  readonly opened: Promise<RoomOpened>;
  readonly admitted: RoomOpened | null;
  readonly latest: RoomOpened | null;
  readonly linked: boolean;
  readonly connected: boolean;
  readonly lost: MistyError | null;
  readonly history: RoomHistory;
  identity(clientId: number): Identity | null;
  onLost(listener: (error: MistyError) => void): Unsubscribe;
  onConnection(listener: (connected: boolean) => void): Unsubscribe;
  onStatus(listener: (status: RoomStatus) => void): Unsubscribe;
  onSync(listener: (synced: boolean) => void): Unsubscribe;
  onClose(listener: (code: number, reason: string) => void): Unsubscribe;
  onProblem(listener: (problem: MistyError) => void): Unsubscribe;
  onMessage(listener: (message: Record<string, unknown>) => void): Unsubscribe;
  send(message: Record<string, unknown>): boolean;
  sendUpdate(update: Uint8Array): boolean;
  applySync(message: Uint8Array): void;
  tapSync(tap: SyncTap): Unsubscribe;
  resend(clients: number[]): void;
  disconnect(): void;
  close(): void;
}

export function identityOf(state: unknown): Identity | null {
  if (typeof state !== "object" || state === null) return null;
  const found = (state as Record<string, unknown>)[IDENTITY_FIELD];
  if (typeof found !== "object" || found === null) return null;
  const { user_id: userId, id, name, tone, agent } = found as Record<string, unknown>;
  const who = typeof userId === "string" && userId ? userId : typeof id === "string" && id ? id : null;
  if (!who) return null;
  const identity: Identity = {
    user_id: who,
    name: typeof name === "string" ? name : "",
    tone: typeof tone === "string" && TONES.has(tone) ? (tone as AvatarTone) : null,
  };
  if (typeof agent === "object" && agent !== null) {
    const { id: agentId, name: agentName } = agent as Record<string, unknown>;
    if (typeof agentId === "string" && agentId) {
      identity.agent = { id: agentId, name: typeof agentName === "string" && agentName ? agentName : "Agent" };
      identity.name = identity.agent.name;
    }
  }
  return identity;
}

export function stopOutdatedCheck(awareness: Awareness): void {
  clearInterval((awareness as unknown as { _checkInterval?: ReturnType<typeof setInterval> })._checkInterval);
}

const frameOf = (write: (encoder: encoding.Encoder) => void): Uint8Array => {
  const encoder = encoding.createEncoder();
  write(encoder);
  return encoding.toUint8Array(encoder);
};

const problemFor = (code: unknown, message: unknown): MistyError => {
  const said = typeof message === "string" && message ? message : "";
  if (code === "read_only") return new MistyError("read_only", said || "You can see this room but not change it.");
  if (code === "too_large")
    return new MistyError("too_large", said || "This room is bigger than the server takes, so changes here aren't being saved.");
  if (code === "too_large_warning")
    return new MistyError("too_large_warning", said || "This room is close to the server's size limit.");
  return new MistyError("internal", said || "The room's server reported a problem.");
};

export function openRoomClient(options: RoomClientOptions): RoomClient {
  const { transport, space, key } = options;
  const wire: RoomWireOptions = { ...(options.options ?? {}) };
  const ownsDoc = options.doc === undefined;
  const doc = options.doc ?? new Y.Doc({ gc: wire.gc ?? true });
  const awareness = new Awareness(doc);
  stopOutdatedCheck(awareness);
  const origin: object = {};
  let conn: TransportConnection | null = null;
  let generation = 0;
  let admitted: RoomOpened | null = null;
  let latest: RoomOpened | null = null;
  let isSynced = false;
  let everSynced = false;
  let link: "opening" | "up" | "down" = "opening";
  let destroyed = false;
  let stopped = false;
  let lost: MistyError | null = null;
  let failures = 0;
  let fulls = 0;
  let upSince = 0;
  let movedTo: string | undefined;
  let reauth = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tap: SyncTap | null = null;
  let tooLarge = false;
  let size: "saved" | "warning" | "blocked" = "saved";
  let readOnlySaid = false;
  const lostListeners = new Set<(error: MistyError) => void>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  const statusListeners = new Set<(status: RoomStatus) => void>();
  const syncListeners = new Set<(synced: boolean) => void>();
  const closeListeners = new Set<(code: number, reason: string) => void>();
  const problemListeners = new Set<(problem: MistyError) => void>();
  const messageListeners = new Set<(message: Record<string, unknown>) => void>();
  let resolveSynced!: () => void;
  let rejectSynced!: (error: Error) => void;
  const synced = new Promise<void>((resolve, reject) => {
    resolveSynced = resolve;
    rejectSynced = reject;
  });
  synced.catch(() => undefined);
  let resolveOpened!: (opened: RoomOpened) => void;
  let rejectOpened!: (error: Error) => void;
  const opened = new Promise<RoomOpened>((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });
  opened.catch(() => undefined);

  const each = <T extends unknown[]>(listeners: Set<(...args: T) => void>, ...args: T) => {
    for (const listener of [...listeners]) safely(() => listener(...args));
  };

  const problem = (error: MistyError) => each(problemListeners, error);

  const sendRaw = (frame: Uint8Array) => {
    if (!admitted || !conn) return false;
    conn.sendBinary(frame);
    return true;
  };

  const sendAwareness = (clients: number[]) => {
    if (!admitted || clients.length === 0) return;
    sendRaw(
      frameOf((encoder) => {
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clients));
      }),
    );
  };

  const markSynced = () => {
    if (isSynced) return;
    isSynced = true;
    upSince = Date.now();
    fulls = 0;
    const was = link;
    link = "up";
    if (!everSynced) {
      everSynced = true;
      resolveSynced();
    }
    each(syncListeners, true);
    if (was === "down") each(connectionListeners, true);
  };

  const applySync = (message: Uint8Array) => {
    if (destroyed || !admitted) return;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, MESSAGE_SYNC);
    let type: number;
    try {
      type = syncProtocol.readSyncMessage(decoding.createDecoder(message), reply, doc, origin);
    } catch (error) {
      problem(asMistyError(error));
      return;
    }
    if (encoding.length(reply) > 1) sendRaw(encoding.toUint8Array(reply));
    if (type === syncProtocol.messageYjsSyncStep2) markSynced();
  };

  const receive = (frame: Uint8Array) => {
    let decoder: decoding.Decoder;
    let type: number;
    try {
      decoder = decoding.createDecoder(frame);
      type = decoding.readVarUint(decoder);
    } catch {
      return;
    }
    if (type === MESSAGE_SYNC) {
      const message = decoding.readTailAsUint8Array(decoder);
      if (tap?.incoming(message)) return;
      applySync(message);
      return;
    }
    if (type === MESSAGE_AWARENESS) {
      try {
        applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), origin);
      } catch (error) {
        problem(asMistyError(error));
      }
      return;
    }
    if (type === MESSAGE_QUERY_AWARENESS) sendAwareness([...awareness.getStates().keys()]);
  };

  const receiveText = (message: Record<string, unknown>) => {
    if (message.type === "moved") {
      if (typeof message.url === "string" && message.url) movedTo = message.url;
      return;
    }
    if (message.type === "document_status") {
      if (message.status === "saved") size = "saved";
      else if (message.status === "blocked") {
        if (size !== "blocked")
          problem(problemFor("too_large", "This room reached the server's size limit, so the latest changes weren't saved."));
        size = "blocked";
      } else if (message.status === "warning") {
        if (size === "saved") problem(problemFor("too_large_warning", ""));
        size = "warning";
      }
    } else if (message.type === "error") {
      if (message.code === "read_only") {
        if (!readOnlySaid) problem(problemFor(message.code, message.message));
        readOnlySaid = true;
      } else if (message.code === "too_large") {
        if (!tooLarge) problem(problemFor(message.code, message.message));
        tooLarge = true;
      } else problem(problemFor(message.code, message.message));
    }
    each(messageListeners, message);
  };

  const dropRemoteStates = () => {
    const others = [...awareness.getStates().keys()].filter((client) => client !== doc.clientID);
    if (others.length) removeAwarenessStates(awareness, others, origin);
    for (const client of others) awareness.meta.delete(client);
  };

  const later = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, delay);
  };

  const lose = (error: MistyError) => {
    if (lost || destroyed) return;
    lost = error;
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    const was = conn;
    conn = null;
    was?.close();
    rejectSynced(error);
    rejectOpened(error);
    const listeners = [...lostListeners];
    lostListeners.clear();
    for (const listener of listeners) safely(() => listener(error));
  };

  const linkDown = (code: number, reason: string) => {
    conn = null;
    const wasAdmitted = admitted !== null;
    admitted = null;
    const wasSynced = isSynced;
    isSynced = false;
    dropRemoteStates();
    each(closeListeners, code, reason);
    if (wasSynced) each(syncListeners, false);
    if (wasAdmitted) each(statusListeners, "disconnected");
    if (link === "up") {
      link = "down";
      each(connectionListeners, false);
    }
  };

  const closed = (code: number, reason: string) => {
    const steady = upSince !== 0 && Date.now() - upSince >= STEADY_MS;
    upSince = 0;
    linkDown(code, reason);
    if (destroyed || stopped) return;
    if (FINAL_CLOSES.has(code)) {
      lose(closeError(code));
      return;
    }
    if (code === CLOSE_CODES.moved) {
      later(0);
      return;
    }
    if (code === CLOSE_CODES.reauth) {
      reauth = true;
      later(0);
      return;
    }
    if (code === CLOSE_CODES.too_large) {
      if (!tooLarge) problem(problemFor("too_large", ""));
      tooLarge = true;
    }
    if (code === CLOSE_CODES.full) {
      fulls += 1;
      problem(new MistyError("stalled", "This room is full right now. Misty keeps trying to join it."));
      later(retryDelay(fulls, FULL_BASE_MS, FULL_CAP_MS));
      return;
    }
    failures = steady ? 0 : failures + 1;
    later(retryDelay(failures));
  };

  function connect() {
    if (destroyed || stopped || conn) return;
    const mine = ++generation;
    const url = movedTo;
    const fresh = reauth;
    movedTo = undefined;
    reauth = false;
    conn = transport.open(
      { space, key, options: wire, ...(url === undefined ? {} : { url }), ...(fresh ? { fresh } : {}) },
      {
        opened(said) {
          if (mine !== generation || destroyed) return;
          admitted = said;
          latest = said;
          resolveOpened(said);
          each(statusListeners, "connected");
          if (mine !== generation || !admitted) return;
          sendRaw(
            frameOf((encoder) => {
              encoding.writeVarUint(encoder, MESSAGE_SYNC);
              syncProtocol.writeSyncStep1(encoder, doc);
            }),
          );
          if (awareness.getLocalState() !== null) sendAwareness([doc.clientID]);
        },
        binary(frame) {
          if (mine !== generation || destroyed || !admitted) return;
          receive(frame);
        },
        text(message) {
          if (mine !== generation || destroyed) return;
          receiveText(message);
        },
        closed(code, reason) {
          if (mine !== generation || destroyed) return;
          generation += 1;
          closed(code, reason);
        },
      },
    );
  }

  const onUpdate = (update: Uint8Array, from: unknown) => {
    if (from === origin || destroyed) return;
    if (tap?.outgoing(update, from)) return;
    if (!admitted) return;
    sendRaw(
      frameOf((encoder) => {
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, update);
      }),
    );
  };
  const onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    from: unknown,
  ) => {
    if (from === origin || destroyed) return;
    sendAwareness([...added, ...updated, ...removed]);
  };
  doc.on("update", onUpdate);
  awareness.on("update", onAwareness);

  const history = historyOver({
    send: (message) => client.send({ option: "history", ...message }),
    onMessage: (listener) =>
      client.onMessage((message) => {
        if (message.option === "history") listener(message);
      }),
    onDown: (listener) => client.onStatus((status) => status === "disconnected" && listener()),
    available: () => (latest === null ? undefined : latest.options.history === true),
  });

  const client: RoomClient = {
    key,
    space,
    doc,
    awareness,
    origin,
    synced,
    opened,
    get admitted() {
      return admitted;
    },
    get latest() {
      return latest;
    },
    get linked() {
      return admitted !== null && !destroyed;
    },
    get connected() {
      return admitted !== null && isSynced && !destroyed;
    },
    get lost() {
      return lost;
    },
    history,
    identity(clientId) {
      const said = identityOf(awareness.getStates().get(clientId));
      if (said || clientId !== doc.clientID) return said;
      if (latest?.identity.id)
        return { user_id: latest.identity.id, name: latest.identity.name, tone: options.identity?.tone ?? null };
      return options.identity ?? null;
    },
    onLost(listener) {
      if (lost) {
        const error = lost;
        queueMicrotask(() => listener(error));
        return () => undefined;
      }
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    onConnection(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onSync(listener) {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onProblem(listener) {
      problemListeners.add(listener);
      return () => problemListeners.delete(listener);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    send(message) {
      if (!admitted || !conn || destroyed) return false;
      conn.sendText(message);
      return true;
    },
    sendUpdate(update) {
      return sendRaw(
        frameOf((encoder) => {
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.writeUpdate(encoder, update);
        }),
      );
    },
    applySync,
    tapSync(next) {
      tap = next;
      return () => {
        if (tap === next) tap = null;
      };
    },
    resend(clients) {
      const states = awareness.getStates();
      sendAwareness(clients.filter((client) => states.has(client)));
    },
    disconnect() {
      if (destroyed || stopped) return;
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      generation += 1;
      const was = conn;
      conn = null;
      was?.close();
      linkDown(CLOSE_CODES.normal, "");
    },
    close() {
      if (destroyed) return;
      if (admitted && awareness.getLocalState() !== null) removeAwarenessStates(awareness, [doc.clientID], "local");
      destroyed = true;
      clearTimeout(timer);
      timer = undefined;
      generation += 1;
      const was = conn;
      conn = null;
      admitted = null;
      was?.close();
      doc.off("update", onUpdate);
      awareness.off("update", onAwareness);
      awareness.destroy();
      if (ownsDoc) doc.destroy();
      const left = new MistyError("cancelled", "The room was left.");
      rejectSynced(left);
      rejectOpened(left);
      lostListeners.clear();
      connectionListeners.clear();
      statusListeners.clear();
      syncListeners.clear();
      closeListeners.clear();
      problemListeners.clear();
      messageListeners.clear();
    },
  };

  connect();
  return client;
}

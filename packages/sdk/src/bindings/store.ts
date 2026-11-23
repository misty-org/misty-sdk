import * as Y from "yjs";
import type { Unsubscribe } from "../connection.js";
import type { Room } from "../room.js";
import { peersOf, type Peer } from "./identity.js";

export type { Peer } from "./identity.js";
export { colorsOf, peersOf, TONE_COLORS, TONE_INK } from "./identity.js";

export interface StoreChange {
  changed: string[];
  removed: string[];
  local: boolean;
}

export interface StoreOptions {
  name?: string;
  captureTimeout?: number;
}

export interface Store<T> {
  readonly map: Y.Map<T>;
  readonly undoManager: Y.UndoManager;
  readonly origin: object;
  get(key: string): T | undefined;
  has(key: string): boolean;
  keys(): string[];
  entries(): [string, T][];
  toObject(): Record<string, T>;
  readonly size: number;
  set(key: string, value: T): void;
  update(key: string, patch: Partial<T>): void;
  delete(key: string): void;
  transact(work: () => void): void;
  subscribe(listener: (change: StoreChange) => void): Unsubscribe;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  onHistory(listener: () => void): Unsubscribe;
  peers(): Peer[];
  setPresence(presence: Record<string, unknown> | null): void;
  onPeers(listener: (peers: Peer[]) => void): Unsubscribe;
  destroy(): void;
}

const PRESENCE_FIELD = "presence";

export function bindStore<T = unknown>(room: Room, options: StoreOptions = {}): Store<T> {
  const map = room.doc.getMap<T>(options.name ?? "store");
  const origin = { store: options.name ?? "store" };
  const undoManager = new Y.UndoManager(map, {
    trackedOrigins: new Set([origin]),
    captureTimeout: options.captureTimeout ?? 500,
  });
  const listeners = new Set<(change: StoreChange) => void>();
  const historyListeners = new Set<() => void>();
  const peerListeners = new Set<(peers: Peer[]) => void>();
  let destroyed = false;

  const observe = (event: Y.YMapEvent<T>, transaction: Y.Transaction) => {
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [key, change] of event.changes.keys) (change.action === "delete" ? removed : changed).push(key);
    const local = transaction.origin === origin || transaction.origin === undoManager;
    for (const listener of [...listeners]) listener({ changed, removed, local });
  };
  map.observe(observe);
  const history = () => {
    for (const listener of [...historyListeners]) listener();
  };
  undoManager.on("stack-item-added", history);
  undoManager.on("stack-item-popped", history);
  undoManager.on("stack-cleared", history);
  const peersChanged = () => {
    const peers = peersOf(room);
    for (const listener of [...peerListeners]) listener(peers);
  };
  room.awareness.on("change", peersChanged);

  const write = (work: () => void) => {
    if (!destroyed) room.doc.transact(work, origin);
  };

  return {
    map,
    undoManager,
    origin,
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    keys: () => [...map.keys()],
    entries: () => [...map.entries()],
    toObject: () => Object.fromEntries(map.entries()) as Record<string, T>,
    get size() {
      return map.size;
    },
    set: (key, value) => write(() => map.set(key, value)),
    update: (key, patch) =>
      write(() => {
        const current = map.get(key);
        map.set(key, { ...(current as object), ...(patch as object) } as T);
      }),
    delete: (key) => write(() => map.delete(key)),
    transact: write,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    undo: () => undoManager.undo() !== null,
    redo: () => undoManager.redo() !== null,
    canUndo: () => undoManager.canUndo(),
    canRedo: () => undoManager.canRedo(),
    onHistory(listener) {
      historyListeners.add(listener);
      return () => historyListeners.delete(listener);
    },
    peers: () => peersOf(room),
    setPresence: (presence) => room.awareness.setLocalStateField(PRESENCE_FIELD, presence),
    onPeers(listener) {
      peerListeners.add(listener);
      listener(peersOf(room));
      return () => peerListeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      map.unobserve(observe);
      room.awareness.off("change", peersChanged);
      undoManager.destroy();
      listeners.clear();
      historyListeners.clear();
      peerListeners.clear();
    },
  };
}

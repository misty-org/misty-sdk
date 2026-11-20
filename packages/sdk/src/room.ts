import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Connection } from "./connection.js";
import { MistyError } from "./errors.js";

/** How a room's document is kept. */
export interface RoomOptions {
  /**
   * False keeps deleted content in the document, on this side and the host's, for an app that undoes its own
   * history or says who deleted what. On by default, as in Yjs.
   */
  gc?: boolean;
}

/** A live Yjs document on one of the Space's collaboration rooms, with who else is in it. */
export interface Room {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** Resolves once the room's current state has arrived; rejects if it can't be opened. */
  readonly synced: Promise<void>;
  /**
   * Why the room stopped for good, once it has: `not_found` when it was deleted, `permission_denied` when this
   * person can no longer reach it, `closed` when Misty closed. Null while it is open.
   */
  readonly lost: MistyError | null;
  /** Calls back once, when the room stops for good (before or after it synced). */
  onLost(listener: (error: MistyError) => void): () => void;
  /** Leaves the room and frees the document. */
  destroy(): void;
}

const REMOTE = Symbol("misty-room-remote");

export function openRoom(connection: Connection, id: string, options: RoomOptions = {}): Room {
  const gc = options.gc ?? true;
  const doc = new Y.Doc({ gc });
  const awareness = new Awareness(doc);
  let destroyed = false;
  let lost: MistyError | null = null;
  const lostListeners = new Set<(error: MistyError) => void>();
  let resolveSynced!: () => void;
  let rejectSynced!: (error: Error) => void;
  const synced = new Promise<void>((resolve, reject) => {
    resolveSynced = resolve;
    rejectSynced = reject;
  });
  // A destroyed or failed room never reports to nobody listening.
  synced.catch(() => {});

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || destroyed) return;
    void connection.call("room.update", { id, update }).catch(() => {});
  };
  const onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE || destroyed) return;
    const update = encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]);
    void connection.call("room.awareness", { id, update }).catch(() => {});
  };
  doc.on("update", onDocUpdate);
  awareness.on("update", onAwarenessUpdate);

  const unsubscribe = connection.subscribe(
    "room",
    gc ? { id } : { id, gc },
    (event) => {
      if (destroyed) return;
      if (event.type === "sync") {
        Y.applyUpdate(doc, event.update, REMOTE);
        resolveSynced();
      } else {
        applyAwarenessUpdate(awareness, event.update, REMOTE);
      }
    },
    (error) => {
      if (destroyed || lost) return;
      lost = error ?? new MistyError("closed", "The room was closed.");
      rejectSynced(lost);
      for (const listener of [...lostListeners]) listener(lost);
      lostListeners.clear();
    },
  );

  return {
    id,
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
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lostListeners.clear();
      unsubscribe();
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwarenessUpdate);
      awareness.destroy();
      doc.destroy();
      rejectSynced(new MistyError("cancelled", "The room was left."));
    },
  };
}

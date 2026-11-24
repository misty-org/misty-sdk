import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { RoomOpened } from "./protocol.js";
import { memoryTransport, type MemoryPeer } from "./transport_memory.js";
import type { RequestTransport } from "./transport.js";

export interface MemoryRoom {
  doc: Y.Doc;
  awareness: Awareness;
  peers: Set<MemoryPeer>;
}

export interface MemoryServerOptions {
  admit?(peer: MemoryPeer): number | void;
  onText?(peer: MemoryPeer, message: Record<string, unknown>, room: MemoryRoom): void;
  opened?(peer: MemoryPeer): Partial<RoomOpened>;
  afterOpen?(peer: MemoryPeer, room: MemoryRoom): void;
  request?: RequestTransport;
}

const frame = (write: (encoder: encoding.Encoder) => void) => {
  const encoder = encoding.createEncoder();
  write(encoder);
  return encoding.toUint8Array(encoder);
};

export function memoryServer(options: MemoryServerOptions = {}) {
  const rooms = new Map<string, MemoryRoom>();
  const opens: MemoryPeer[] = [];
  const roomFor = (key: string): MemoryRoom => {
    const known = rooms.get(key);
    if (known) return known;
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    clearInterval((awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
    awareness.setLocalState(null);
    const room: MemoryRoom = { doc, awareness, peers: new Set() };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const message = frame((encoder) => {
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeUpdate(encoder, update);
      });
      for (const peer of room.peers) if (peer !== origin) peer.sendBinary(message);
    });
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const message = frame((encoder) => {
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
      });
      for (const peer of room.peers) if (peer !== origin) peer.sendBinary(message);
    });
    rooms.set(key, room);
    return room;
  };
  const transport = memoryTransport(
    (peer) => {
      opens.push(peer);
      const refused = options.admit?.(peer);
      if (typeof refused === "number") {
        peer.close(refused);
        return;
      }
      const room = roomFor(peer.request.key);
      room.peers.add(peer);
      peer.onClose(() => room.peers.delete(peer));
      peer.open({
        type: "opened",
        room: `rm_${peer.request.key}`,
        role: "edit",
        options: peer.request.options,
        seats: 40,
        max_bytes: 8 * 1024 * 1024,
        identity: { kind: "person", id: "ana", name: "Ana" },
        ...(options.opened?.(peer) ?? {}),
      });
      peer.sendBinary(
        frame((encoder) => {
          encoding.writeVarUint(encoder, 0);
          syncProtocol.writeSyncStep1(encoder, room.doc);
        }),
      );
      const states = [...room.awareness.getStates().keys()];
      if (states.length)
        peer.sendBinary(
          frame((encoder) => {
            encoding.writeVarUint(encoder, 1);
            encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(room.awareness, states));
          }),
        );
      peer.onBinary((data) => {
        const decoder = decoding.createDecoder(data);
        const type = decoding.readVarUint(decoder);
        if (type === 0) {
          const reply = encoding.createEncoder();
          encoding.writeVarUint(reply, 0);
          syncProtocol.readSyncMessage(decoder, reply, room.doc, peer);
          if (encoding.length(reply) > 1) peer.sendBinary(encoding.toUint8Array(reply));
        } else if (type === 1) {
          applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), peer);
        }
      });
      peer.onText((message) => options.onText?.(peer, message, room));
      options.afterOpen?.(peer, room);
    },
    options.request ? { request: options.request } : {},
  );
  return { transport, rooms, opens, roomFor };
}

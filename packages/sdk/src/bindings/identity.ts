import { localAgentIdentity } from "../agents.js";
import type { Room } from "../room.js";
import type { AvatarTone, Identity } from "../types.js";

export const TONE_COLORS: Record<AvatarTone, string> = {
  red: "#eab7ab",
  orange: "#f0c38e",
  yellow: "#f0d58c",
  green: "#c5cf8e",
  blue: "#a0c4d4",
  purple: "#d3b3c9",
  gray: "#d5c9b8",
};

export const TONE_INK = "#3c3836";

export interface Peer extends Identity {
  clientId: number;
  color: string;
  colorLight: string;
  state: Record<string, unknown>;
}

export function colorsOf(tone: AvatarTone | null): { color: string; colorLight: string } {
  const color = TONE_COLORS[tone ?? "gray"];
  return { color, colorLight: `${color}55` };
}

export function editorUser(identity: Identity | null): { name: string; color: string; colorLight: string } {
  return { name: identity?.name || "Someone", ...colorsOf(identity?.tone ?? null) };
}

export function identityIn(room: Room, clientId: number): Identity | null {
  return localAgentIdentity(room, clientId) ?? room.identity(clientId);
}

export function peersOf(room: Room): Peer[] {
  const peers: Peer[] = [];
  for (const [clientId, raw] of room.awareness.getStates()) {
    if (clientId === room.doc.clientID) continue;
    const who = identityIn(room, clientId);
    if (!who) continue;
    peers.push({ clientId, ...who, ...colorsOf(who.tone), state: (raw ?? {}) as Record<string, unknown> });
  }
  return peers;
}

const holds = new WeakMap<object, Map<string, number>>();

function hold(awareness: object, field: string, change: 1 | -1): number {
  const counts = holds.get(awareness) ?? new Map<string, number>();
  holds.set(awareness, counts);
  const next = Math.max(0, (counts.get(field) ?? 0) + change);
  if (next) counts.set(field, next);
  else counts.delete(field);
  return next;
}

export function trustIdentity(room: Room, field: string, cursorFields: readonly string[] = []): () => void {
  const me = room.identity(room.doc.clientID);
  room.awareness.setLocalStateField(field, editorUser(me));
  hold(room.awareness, field, 1);
  const rewrite = ({ added, updated }: { added: number[]; updated: number[] }) => {
    const states = room.awareness.getStates();
    for (const clientId of [...added, ...updated]) {
      if (clientId === room.doc.clientID) continue;
      const state = states.get(clientId) as Record<string, unknown> | undefined;
      if (!state) continue;
      const who = identityIn(room, clientId);
      if (who) {
        state[field] = editorUser(who);
        continue;
      }
      delete state[field];
      for (const cursor of cursorFields) delete state[cursor];
    }
  };
  room.awareness.on("change", rewrite);
  room.awareness.on("update", rewrite);
  rewrite({ added: [...room.awareness.getStates().keys()], updated: [] });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    room.awareness.off("change", rewrite);
    room.awareness.off("update", rewrite);
    if (hold(room.awareness, field, -1) === 0) room.awareness.setLocalStateField(field, null);
  };
}

export function clearLocalFields(room: Room, fields: readonly string[]): void {
  if (room.awareness.getLocalState() === null) return;
  for (const field of fields) room.awareness.setLocalStateField(field, null);
}

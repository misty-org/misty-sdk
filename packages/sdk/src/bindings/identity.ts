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

export function peersOf(room: Room): Peer[] {
  const peers: Peer[] = [];
  for (const [clientId, raw] of room.awareness.getStates()) {
    if (clientId === room.doc.clientID) continue;
    const who = room.identity(clientId);
    if (!who) continue;
    peers.push({ clientId, ...who, ...colorsOf(who.tone), state: (raw ?? {}) as Record<string, unknown> });
  }
  return peers;
}

export function trustIdentity(room: Room, field: string): () => void {
  const me = room.identity(room.doc.clientID);
  room.awareness.setLocalStateField(field, editorUser(me));
  const rewrite = ({ added, updated }: { added: number[]; updated: number[] }) => {
    const states = room.awareness.getStates();
    for (const clientId of [...added, ...updated]) {
      if (clientId === room.doc.clientID) continue;
      const state = states.get(clientId) as Record<string, unknown> | undefined;
      const who = room.identity(clientId);
      if (state && who) state[field] = editorUser(who);
    }
  };
  room.awareness.on("change", rewrite);
  room.awareness.on("update", rewrite);
  rewrite({ added: [...room.awareness.getStates().keys()], updated: [] });
  return () => {
    room.awareness.off("change", rewrite);
    room.awareness.off("update", rewrite);
  };
}

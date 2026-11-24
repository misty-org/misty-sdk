import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Room } from "./room.js";
import { stopOutdatedCheck } from "./room_client.js";
import type { AgentCaller, Identity } from "./types.js";

export const AGENT_CLAIM = "agent";

export const AGENT_META = "misty/agent";

const MAX_EDITING = 32;

const MIRRORED = Symbol("misty-agent-mirror");

const PRESENCE = Symbol("misty-agent-presence");

export interface AgentEditing {
  type: string;
  key: string;
}

export interface AgentInRoomOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scope?: (doc: Y.Doc) => Y.AbstractType<any> | Y.AbstractType<any>[];
  captureTimeout?: number;
}

export interface AgentInRoom {
  readonly agent: AgentCaller;
  readonly doc: Y.Doc;
  readonly clientId: number;
  readonly origin: object;
  readonly undoManager: Y.UndoManager | null;
  transact(work: (doc: Y.Doc) => void): void;
  undo(): boolean;
  redo(): boolean;
  setPresence(presence: Record<string, unknown> | null): void;
  readonly editing: AgentEditing[];
  destroy(): void;
}

const locals = new WeakMap<Y.Doc, Map<number, Identity>>();

const joined = new WeakMap<Room, Map<string, AgentInRoom>>();

export function localAgentIdentity(room: Room, clientId: number): Identity | null {
  return locals.get(room.doc)?.get(clientId) ?? null;
}

export function agentOfCall(context: unknown): AgentCaller | null {
  if (typeof context !== "object" || context === null) return null;
  const record = context as Record<string, unknown>;
  const meta = record._meta;
  const found =
    record.agent ?? (typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>)[AGENT_META] : undefined);
  if (typeof found !== "object" || found === null) return null;
  const { id, name } = found as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  return { id, name: typeof name === "string" && name ? name : "Agent" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyType = Y.AbstractType<any>;

function namesOf(doc: Y.Doc): Map<AnyType, string> {
  const names = new Map<AnyType, string>();
  for (const [name, type] of doc.share) names.set(type, name);
  return names;
}

function editedIn(doc: Y.Doc, transaction: Y.Transaction): AgentEditing[] {
  const names = namesOf(doc);
  const edits: AgentEditing[] = [];
  for (const [type, keys] of transaction.changed) {
    let root: AnyType | null = type;
    while (root && root._item?.parent instanceof Y.AbstractType) root = root._item.parent as AnyType;
    const name = root ? names.get(root) : undefined;
    if (!name) continue;
    for (const key of keys) {
      if (typeof key === "string") edits.push({ type: name, key });
      else if (root !== type && type._item?.parentSub) edits.push({ type: name, key: type._item.parentSub });
      if (edits.length >= MAX_EDITING) return edits;
    }
    if (!keys.size || [...keys].every((key) => key === null)) edits.push({ type: name, key: "" });
  }
  return edits.slice(0, MAX_EDITING);
}

export function joinAsAgent(room: Room, agent: AgentCaller, options: AgentInRoomOptions = {}): AgentInRoom {
  const already = joined.get(room)?.get(agent.id);
  if (already) return already;
  const main = room.doc;
  const doc = new Y.Doc({ gc: main.gc });
  const origin = { agent: agent.id };
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(main), MIRRORED);
  const fromMain = (update: Uint8Array, from: unknown) => {
    if (from === origin) return;
    Y.applyUpdate(doc, update, MIRRORED);
  };
  const toMain = (update: Uint8Array, from: unknown) => {
    if (from === MIRRORED) return;
    Y.applyUpdate(main, update, origin);
  };
  main.on("update", fromMain);
  doc.on("update", toMain);

  const scope = options.scope?.(doc);
  const undoManager = scope
    ? new Y.UndoManager(scope, { trackedOrigins: new Set([origin]), captureTimeout: options.captureTimeout ?? 500 })
    : null;

  const awareness = new Awareness(doc);
  stopOutdatedCheck(awareness);
  let presence: Record<string, unknown> | null = null;
  let editing: AgentEditing[] = [];
  const publish = () => {
    awareness.setLocalState({ [AGENT_CLAIM]: agent.id, presence, editing });
  };
  const forward = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const clients = [...added, ...updated, ...removed].filter((client) => client === doc.clientID);
    if (!clients.length) return;
    applyAwarenessUpdate(room.awareness, encodeAwarenessUpdate(awareness, clients), PRESENCE);
  };
  awareness.on("update", forward);

  const identities = locals.get(main) ?? new Map<number, Identity>();
  locals.set(main, identities);
  const me = room.identity(main.clientID);
  identities.set(doc.clientID, {
    user_id: me?.user_id ?? "",
    name: agent.name,
    tone: me?.tone ?? null,
    agent: { id: agent.id, name: agent.name },
  });

  const onTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin !== origin && transaction.origin !== undoManager) return;
    const edits = editedIn(doc, transaction);
    if (!edits.length) return;
    editing = edits;
    publish();
  };
  doc.on("afterTransaction", onTransaction);
  publish();

  let destroyed = false;
  const handle: AgentInRoom = {
    agent,
    doc,
    clientId: doc.clientID,
    origin,
    undoManager,
    transact(work) {
      if (destroyed) throw new Error(`${agent.name} has left this room.`);
      doc.transact(() => work(doc), origin);
    },
    undo: () => (undoManager && !destroyed ? undoManager.undo() !== null : false),
    redo: () => (undoManager && !destroyed ? undoManager.redo() !== null : false),
    setPresence(next) {
      if (destroyed) return;
      presence = next;
      publish();
    },
    get editing() {
      return editing.map((edit) => ({ ...edit }));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      joined.get(room)?.delete(agent.id);
      main.off("update", fromMain);
      doc.off("update", toMain);
      doc.off("afterTransaction", onTransaction);
      removeAwarenessStates(awareness, [doc.clientID], "destroy");
      awareness.off("update", forward);
      awareness.destroy();
      undoManager?.destroy();
      identities.delete(doc.clientID);
      doc.destroy();
    },
  };
  const byAgent = joined.get(room) ?? new Map<string, AgentInRoom>();
  byAgent.set(agent.id, handle);
  joined.set(room, byAgent);
  return handle;
}

export function agentsIn(room: Room): AgentInRoom[] {
  return [...(joined.get(room)?.values() ?? [])];
}

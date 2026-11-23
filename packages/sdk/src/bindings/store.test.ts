import { Awareness } from "y-protocols/awareness";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Room } from "../room.js";
import { bindStore } from "./store.js";
import { trustIdentity } from "./identity.js";

function fakeRoom(): Room {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  return {
    id: "r",
    doc,
    awareness,
    synced: Promise.resolve(),
    lost: null,
    onLost: () => () => {},
    onError: () => () => {},
    identity: (clientId) => {
      if (clientId === doc.clientID) return { user_id: "ana", name: "Ana", tone: "blue" };
      const state = awareness.getStates().get(clientId) as { misty?: { user_id: string; name: string } } | undefined;
      return state?.misty ? { user_id: state.misty.user_id, name: state.misty.name, tone: "red" } : null;
    },
    destroy: () => {},
  };
}

describe("bindStore", () => {
  it("writes, reads and undoes only this person's own writes", () => {
    const room = fakeRoom();
    const store = bindStore<{ x: number; y?: number }>(room, { name: "cells", captureTimeout: 0 });
    const seen: boolean[] = [];
    store.subscribe((change) => seen.push(change.local));
    store.set("a", { x: 1 });
    store.update("a", { y: 2 });
    room.doc.transact(() => room.doc.getMap("cells").set("b", { x: 9 }), "someone-else");
    expect(store.toObject()).toEqual({ a: { x: 1, y: 2 }, b: { x: 9 } });
    expect(seen).toEqual([true, true, false]);
    store.undo();
    store.undo();
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toEqual({ x: 9 });
    expect(store.redo()).toBe(true);
    expect(store.get("a")).toEqual({ x: 1 });
    store.destroy();
  });
});

describe("trustIdentity", () => {
  it("draws every remote person by Misty's identity, whatever their own field says", () => {
    const room = fakeRoom();
    const stop = trustIdentity(room, "user");
    expect(room.awareness.getLocalState()).toMatchObject({ user: { name: "Ana", color: "#a0c4d4" } });
    room.awareness.states.set(7, { misty: { user_id: "sam", name: "Sam" }, user: { name: "Not Sam" } });
    room.awareness.emit("change", [{ added: [7], updated: [], removed: [] }, "remote"]);
    expect(room.awareness.getStates().get(7)).toMatchObject({ user: { name: "Sam", color: "#eab7ab" } });
    stop();
  });
});

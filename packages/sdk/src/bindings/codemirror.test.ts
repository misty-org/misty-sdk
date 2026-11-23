import { EditorState, Transaction } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import { describe, expect, it } from "vitest";
import { ySyncAnnotation, ySyncFacet, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { Room } from "../room.js";
import { bindCodemirror } from "./codemirror.js";

function fakeRoom(): Room {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  return {
    id: "r",
    doc,
    awareness,
    synced: Promise.resolve(),
    lost: null,
    connected: true,
    onLost: () => () => {},
    onError: () => () => {},
    onConnection: () => () => {},
    identity: (clientId) => (clientId === doc.clientID ? { user_id: "ana", name: "Ana", tone: "blue" } : null),
    destroy: () => {},
  };
}

describe("bindCodemirror", () => {
  it("takes Mod-z before an editor's own history, so undo never takes back someone else's edit", () => {
    const room = fakeRoom();
    const collab = bindCodemirror(room);
    const ownHistory = keymap.of([{ key: "Mod-z", run: () => true }]);
    const state = EditorState.create({ extensions: [ownHistory, collab.extension] });
    const first = state
      .facet(keymap)
      .flat()
      .find((binding) => binding.key === "Mod-z");
    expect(first?.run).toBe(yUndoManagerKeymap[0]?.run);
    collab.destroy();
  });

  it("keeps changes that come from the room out of the editor's own history", () => {
    const room = fakeRoom();
    const collab = bindCodemirror(room);
    const state = EditorState.create({ extensions: [collab.extension] });
    const remote = state.update({
      changes: { from: 0, insert: "x" },
      annotations: [ySyncAnnotation.of(state.facet(ySyncFacet))],
    });
    expect(remote.annotation(Transaction.addToHistory)).toBe(false);
    const local = state.update({ changes: { from: 0, insert: "y" } });
    expect(local.annotation(Transaction.addToHistory)).toBeUndefined();
    collab.destroy();
  });

  it("refuses a text with Windows line endings rather than garble it", () => {
    const room = fakeRoom();
    room.doc.getText("text").insert(0, "a\r\nb");
    let refused: unknown;
    try {
      bindCodemirror(room);
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ code: "unsupported" });
  });

  it("takes its cursor out of the room when it's done", () => {
    const room = fakeRoom();
    const collab = bindCodemirror(room);
    room.awareness.setLocalStateField("cursor", { anchor: 0, head: 0 });
    collab.destroy();
    expect(room.awareness.getLocalState()).toMatchObject({ cursor: null, user: null });
  });
});

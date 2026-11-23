import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { Room } from "../room.js";
import { trustIdentity } from "./identity.js";

export interface CodemirrorBinding {
  extension: Extension;
  text: Y.Text;
  undoManager: Y.UndoManager;
  destroy(): void;
}

export interface CodemirrorOptions {
  text?: Y.Text;
  name?: string;
}

const LOCAL = Symbol("misty-codemirror");

export function bindCodemirror(room: Room, options: CodemirrorOptions = {}): CodemirrorBinding {
  const text = options.text ?? room.doc.getText(options.name ?? "text");
  const stopIdentity = trustIdentity(room, "user");
  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([LOCAL]) });
  return {
    extension: [yCollab(text, room.awareness, { undoManager }), keymap.of(yUndoManagerKeymap)],
    text,
    undoManager,
    destroy() {
      stopIdentity();
      undoManager.destroy();
    },
  };
}

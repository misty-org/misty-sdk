import { EditorState, Prec, Transaction } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { Room } from "../room.js";
import { clearLocalFields, trustIdentity } from "./identity.js";
import { refuseCarriageReturns } from "./line_endings.js";

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

const CURSOR_FIELD = "cursor";

const remoteOutOfHistory = EditorState.transactionExtender.of((transaction) =>
  transaction.annotation(ySyncAnnotation) === undefined
    ? null
    : { annotations: Transaction.addToHistory.of(false) },
);

export function bindCodemirror(room: Room, options: CodemirrorOptions = {}): CodemirrorBinding {
  const text = options.text ?? room.doc.getText(options.name ?? "text");
  refuseCarriageReturns(text);
  const stopIdentity = trustIdentity(room, "user", [CURSOR_FIELD]);
  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([LOCAL]) });
  let destroyed = false;
  return {
    extension: [
      Prec.high(keymap.of(yUndoManagerKeymap)),
      yCollab(text, room.awareness, { undoManager }),
      remoteOutOfHistory,
    ],
    text,
    undoManager,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopIdentity();
      clearLocalFields(room, [CURSOR_FIELD]);
      undoManager.destroy();
    },
  };
}

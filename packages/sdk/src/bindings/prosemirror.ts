import type { Command, Plugin } from "prosemirror-state";
import { redo, undo, yCursorPlugin, ySyncPlugin, yUndoPlugin } from "y-prosemirror";
import type * as Y from "yjs";
import type { Room } from "../room.js";
import { trustIdentity } from "./identity.js";

export interface ProsemirrorBinding {
  plugins: Plugin[];
  fragment: Y.XmlFragment;
  undo: Command;
  redo: Command;
  destroy(): void;
}

export interface ProsemirrorOptions {
  fragment?: Y.XmlFragment;
  name?: string;
}

export function bindProsemirror(room: Room, options: ProsemirrorOptions = {}): ProsemirrorBinding {
  const fragment = options.fragment ?? room.doc.getXmlFragment(options.name ?? "prosemirror");
  const stopIdentity = trustIdentity(room, "user");
  return {
    plugins: [ySyncPlugin(fragment), yCursorPlugin(room.awareness), yUndoPlugin()],
    fragment,
    undo: (state) => undo(state),
    redo: (state) => redo(state),
    destroy: stopIdentity,
  };
}

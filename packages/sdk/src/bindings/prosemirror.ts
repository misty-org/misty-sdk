import type { Schema } from "prosemirror-model";
import type { Command, Plugin } from "prosemirror-state";
import { redoCommand, undoCommand, yCursorPlugin, ySyncPlugin, yUndoPlugin } from "y-prosemirror";
import type * as Y from "yjs";
import type { MistyError } from "../errors.js";
import type { Room } from "../room.js";
import { clearLocalFields, trustIdentity } from "./identity.js";
import { newerVersion, schemaGap, schemaGuard } from "./schema_guard.js";

export { schemaGap } from "./schema_guard.js";

export interface ProsemirrorBinding {
  plugins: Plugin[];
  fragment: Y.XmlFragment;
  undo: Command;
  redo: Command;
  readonly unsupported: MistyError | null;
  destroy(): void;
}

export interface ProsemirrorOptions {
  fragment?: Y.XmlFragment;
  name?: string;
  schema?: Schema;
  onUnsupported?: (error: MistyError) => void;
}

const CURSOR_FIELD = "cursor";

export function bindProsemirror(room: Room, options: ProsemirrorOptions = {}): ProsemirrorBinding {
  const fragment = options.fragment ?? room.doc.getXmlFragment(options.name ?? "prosemirror");
  if (options.schema && schemaGap(fragment, options.schema)) throw newerVersion();
  const stopIdentity = trustIdentity(room, "user", [CURSOR_FIELD]);
  const guard = schemaGuard(fragment, { schema: options.schema, onUnsupported: options.onUnsupported });

  let destroyed = false;
  return {
    plugins: [guard.plugin, ySyncPlugin(fragment), yCursorPlugin(room.awareness), yUndoPlugin()],
    fragment,
    undo: (state, dispatch) => !guard.unsupported && undoCommand(state, dispatch),
    redo: (state, dispatch) => !guard.unsupported && redoCommand(state, dispatch),
    get unsupported() {
      return guard.unsupported;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      guard.stop();
      stopIdentity();
      clearLocalFields(room, [CURSOR_FIELD]);
    },
  };
}

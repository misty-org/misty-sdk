import type { Schema } from "prosemirror-model";
import type { Plugin } from "prosemirror-state";
import type * as Y from "yjs";
import type { MistyError } from "../errors.js";
import type { Room } from "../room.js";
import { clearLocalFields, editorUser, trustIdentity } from "./identity.js";
import { newerVersion, schemaGap, schemaGuard } from "./schema_guard.js";

export interface TiptapBinding {
  collaboration: {
    document: Y.Doc;
    field: string;
    ySyncOptions: { onInvalidContent: (error: Error) => void };
  };
  caret: { provider: { awareness: Room["awareness"] }; user: { name: string; color: string } };
  guard: { name: string; priority: number; plugins: Plugin[] };
  readonly unsupported: MistyError | null;
  destroy(): void;
}

export interface TiptapOptions {
  name?: string;
  schema?: Schema;
  onUnsupported?: (error: MistyError) => void;
}

const CURSOR_FIELD = "cursor";

const GUARD_PRIORITY = 1001;

export function bindTiptap(room: Room, options: TiptapOptions = {}): TiptapBinding {
  const field = options.name ?? "prosemirror";
  const fragment = room.doc.getXmlFragment(field);
  if (options.schema && schemaGap(fragment, options.schema)) throw newerVersion();
  const stopIdentity = trustIdentity(room, "user", [CURSOR_FIELD]);
  const me = editorUser(room.identity(room.doc.clientID));
  let invalid: MistyError | null = null;
  let told = false;
  const tell = (error: MistyError) => {
    if (told) return;
    told = true;
    options.onUnsupported?.(error);
  };
  const guard = schemaGuard(fragment, { schema: options.schema, onUnsupported: tell });
  let destroyed = false;
  return {
    collaboration: {
      document: room.doc,
      field,
      ySyncOptions: {
        onInvalidContent: () => {
          if (guard.unsupported || invalid) return;
          invalid = newerVersion();
          tell(invalid);
        },
      },
    },
    caret: { provider: { awareness: room.awareness }, user: { name: me.name, color: me.color } },
    guard: { name: "mistySchemaGuard", priority: GUARD_PRIORITY, plugins: [guard.plugin] },
    get unsupported() {
      return guard.unsupported ?? invalid;
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

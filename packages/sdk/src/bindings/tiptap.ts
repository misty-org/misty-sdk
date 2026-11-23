import type * as Y from "yjs";
import type { Room } from "../room.js";
import { editorUser, trustIdentity } from "./identity.js";

export interface TiptapBinding {
  collaboration: { document: Y.Doc; field: string };
  caret: { provider: { awareness: Room["awareness"] }; user: { name: string; color: string } };
  destroy(): void;
}

export function bindTiptap(room: Room, options: { name?: string } = {}): TiptapBinding {
  const stopIdentity = trustIdentity(room, "user");
  const me = editorUser(room.identity(room.doc.clientID));
  return {
    collaboration: { document: room.doc, field: options.name ?? "prosemirror" },
    caret: { provider: { awareness: room.awareness }, user: { name: me.name, color: me.color } },
    destroy: stopIdentity,
  };
}

import type { editor as MonacoEditor } from "monaco-editor";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";
import type { Room } from "../room.js";
import { peersOf, trustIdentity } from "./identity.js";

export interface MonacoBindingHandle {
  binding: MonacoBinding;
  text: Y.Text;
  undoManager: Y.UndoManager;
  destroy(): void;
}

export interface MonacoOptions {
  text?: Y.Text;
  name?: string;
}

const STYLE_ID = "misty-monaco-peers";

function cssString(value: string): string {
  return JSON.stringify(value.replace(/[\n\r]/g, " "));
}

function drawPeers(room: Room, doc: Document) {
  let style = doc.getElementById(STYLE_ID);
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  style.textContent = peersOf(room)
    .map(
      ({ clientId, color, colorLight, name }) =>
        `.yRemoteSelection-${clientId}{background-color:${colorLight}}` +
        `.yRemoteSelectionHead-${clientId}{position:absolute;border-left:2px solid ${color};height:100%;box-sizing:border-box}` +
        `.yRemoteSelectionHead-${clientId}::after{position:absolute;top:-1.4em;left:-2px;padding:0 4px;` +
        `border-radius:4px;white-space:nowrap;font-size:11px;background:${color};color:#3c3836;` +
        `content:${cssString(name)}}`,
    )
    .join("");
}

export function bindMonaco(
  room: Room,
  editor: MonacoEditor.IStandaloneCodeEditor,
  options: MonacoOptions = {},
): MonacoBindingHandle {
  const model = editor.getModel();
  if (!model) throw new Error("The editor has no model to bind.");
  const text = options.text ?? room.doc.getText(options.name ?? "text");
  const stopIdentity = trustIdentity(room, "user");
  const binding = new MonacoBinding(text, model, new Set([editor]), room.awareness);
  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([binding]) });
  const doc = editor.getContainerDomNode().ownerDocument;
  const redraw = () => drawPeers(room, doc);
  room.awareness.on("change", redraw);
  redraw();
  const keys = editor.onKeyDown((event) => {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.browserEvent.key.toLowerCase();
    if (!mod || (key !== "z" && key !== "y")) return;
    event.preventDefault();
    event.stopPropagation();
    if (key === "y" || event.shiftKey) undoManager.redo();
    else undoManager.undo();
  });
  return {
    binding,
    text,
    undoManager,
    destroy() {
      keys.dispose();
      room.awareness.off("change", redraw);
      doc.getElementById(STYLE_ID)?.remove();
      stopIdentity();
      undoManager.destroy();
      binding.destroy();
    },
  };
}

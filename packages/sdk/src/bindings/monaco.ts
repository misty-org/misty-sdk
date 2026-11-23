import type { IDisposable, editor as MonacoEditor } from "monaco-editor";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";
import type { Room } from "../room.js";
import { clearLocalFields, peersOf, trustIdentity } from "./identity.js";
import { refuseCarriageReturns } from "./line_endings.js";

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

type Editor = MonacoEditor.IStandaloneCodeEditor;

const STYLE_PREFIX = "misty-monaco-peers";

const SELECTION_FIELD = "selection";

const KEY_Y = 55;

const KEY_Z = 56;

const LINE_FEED = 0 as MonacoEditor.EndOfLineSequence;

let nextStyle = 0;

function cssString(value: string): string {
  return JSON.stringify(value.replace(/[\n\r]/g, " "));
}

function drawPeers(room: Room, doc: Document, styleId: string) {
  let style = doc.getElementById(styleId);
  if (!style) {
    style = doc.createElement("style");
    style.id = styleId;
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

function tracked(editor: Editor, disposables: IDisposable[]): Editor {
  return new Proxy(editor, {
    get(target, property) {
      if (property === "onDidChangeCursorSelection") {
        return (...args: Parameters<Editor["onDidChangeCursorSelection"]>) => {
          const disposable = target.onDidChangeCursorSelection(...args);
          disposables.push(disposable);
          return disposable;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function bindMonaco(room: Room, editor: Editor, options: MonacoOptions = {}): MonacoBindingHandle {
  const model = editor.getModel();
  if (!model) throw new Error("The editor has no model to bind.");
  const text = options.text ?? room.doc.getText(options.name ?? "text");
  refuseCarriageReturns(text);
  const stopIdentity = trustIdentity(room, "user", [SELECTION_FIELD]);
  const leaked: IDisposable[] = [];
  const binding = new MonacoBinding(text, model, new Set([tracked(editor, leaked)]), room.awareness);
  model.setEOL(LINE_FEED);
  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([binding]) });
  const doc = editor.getContainerDomNode().ownerDocument;
  const styleId = `${STYLE_PREFIX}-${(nextStyle += 1)}`;
  const redraw = () => drawPeers(room, doc, styleId);
  room.awareness.on("change", redraw);
  redraw();
  const keys = editor.onKeyDown((event) => {
    const mod = event.metaKey || event.ctrlKey;
    const keyCode: number = event.keyCode;
    if (!mod || (keyCode !== KEY_Z && keyCode !== KEY_Y)) return;
    event.preventDefault();
    event.stopPropagation();
    if (keyCode === KEY_Y || event.shiftKey) undoManager.redo();
    else undoManager.undo();
  });
  let destroyed = false;
  return {
    binding,
    text,
    undoManager,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      keys.dispose();
      for (const disposable of leaked.splice(0)) disposable.dispose();
      room.awareness.off("change", redraw);
      doc.getElementById(styleId)?.remove();
      stopIdentity();
      clearLocalFields(room, [SELECTION_FIELD]);
      undoManager.destroy();
      binding.destroy();
    },
  };
}

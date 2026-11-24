import * as Y from "yjs";
import type { Room } from "../room.js";
import { peersOf } from "./identity.js";

interface Position {
  lineNumber: number;
  column: number;
}

interface Selection {
  getStartPosition(): Position;
  getEndPosition(): Position;
}

interface Disposable {
  dispose(): void;
}

interface ModelChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export interface MonacoTextModel {
  getValue(): string;
  setEOL(eol: number): void;
  getFullModelRange(): unknown;
  getPositionAt(offset: number): Position;
  getOffsetAt(position: Position): number;
  pushEditOperations(before: unknown[], edits: { range: unknown; text: string }[], after: () => null): unknown;
  applyEdits(edits: { range: unknown; text: string }[]): unknown;
  deltaDecorations(old: string[], next: { range: unknown; options: Record<string, unknown> }[]): string[];
  onDidChangeContent(listener: (event: { changes: ModelChange[] }) => void): Disposable;
}

export interface MonacoCodeEditor {
  getModel(): unknown;
  getSelection(): Selection | null;
  onDidChangeCursorSelection(listener: () => void): Disposable;
  onDidChangeModel(listener: () => void): Disposable;
}

export interface MonacoNamespace {
  Range: new (startLine: number, startColumn: number, endLine: number, endColumn: number) => unknown;
}

export interface MonacoModelBinding {
  text: Y.Text;
  destroy(): void;
}

export interface MonacoModelOptions {
  text?: Y.Text;
  styleId?: string;
}

const SELECTION_FIELD = "selection";

const LOCAL = Symbol("misty-monaco-model");

const cssString = (value: string) => JSON.stringify(value.replace(/[\n\r]/g, " "));

const normalized = (value: string) => value.replace(/\r\n?/g, "\n");

export function bindMonacoModel(
  room: Room,
  parts: { editor: MonacoCodeEditor; model: MonacoTextModel; monaco: MonacoNamespace },
  options: MonacoModelOptions = {},
): MonacoModelBinding {
  const { editor, model, monaco } = parts;
  const text = options.text ?? room.doc.getText("text");
  const styleId = options.styleId ?? "misty-monaco-model-peers";
  let applying = false;
  let decorations: string[] = [];
  model.setEOL(0);

  const range = (from: Position, to: Position) => new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);

  const setModel = (value: string) => {
    if (model.getValue() === value) return;
    applying = true;
    try {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    } finally {
      applying = false;
    }
  };

  const applyDelta = (delta: { retain?: number; insert?: unknown; delete?: number }[]) => {
    applying = true;
    try {
      let index = 0;
      for (const op of delta) {
        if (op.retain !== undefined) index += op.retain;
        else if (op.insert !== undefined) {
          const inserted = typeof op.insert === "string" ? op.insert : "";
          const at = model.getPositionAt(index);
          model.applyEdits([{ range: range(at, at), text: inserted }]);
          index += inserted.length;
        } else if (op.delete !== undefined) {
          model.applyEdits([{ range: range(model.getPositionAt(index), model.getPositionAt(index + op.delete)), text: "" }]);
        }
      }
    } finally {
      applying = false;
    }
  };

  const publishSelection = () => {
    const selection = editor.getModel() === model ? editor.getSelection() : null;
    if (!selection) {
      room.awareness.setLocalStateField(SELECTION_FIELD, null);
      return;
    }
    const anchor = model.getOffsetAt(selection.getStartPosition());
    const head = model.getOffsetAt(selection.getEndPosition());
    room.awareness.setLocalStateField(SELECTION_FIELD, {
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, anchor)),
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, head)),
    });
  };

  const paint = () => {
    const peers = peersOf(room);
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    style.textContent = peers
      .map(
        (peer) =>
          `.misty-peer-${peer.clientId}{background-color:${peer.colorLight}}` +
          `.misty-peer-head-${peer.clientId}{border-left:2px solid ${peer.color}}` +
          `.misty-peer-head-${peer.clientId}::after{position:absolute;margin-top:-1.4em;padding:0 4px;border-radius:4px;` +
          `white-space:nowrap;font-size:11px;background:${peer.color};color:#3c3836;content:${cssString(peer.name || "Someone")}}`,
      )
      .join("");
    const next: { range: unknown; options: Record<string, unknown> }[] = [];
    for (const peer of peers) {
      const state = peer.state as Record<string, unknown>;
      const presence = (state.presence ?? null) as Record<string, unknown> | null;
      const selection = (state[SELECTION_FIELD] ?? presence?.[SELECTION_FIELD] ?? null) as
        | { anchor?: unknown; head?: unknown }
        | null;
      if (!selection?.anchor || !selection.head) continue;
      const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(selection.anchor), room.doc);
      const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(selection.head), room.doc);
      if (!anchor || !head || anchor.type !== text || head.type !== text) continue;
      const start = model.getPositionAt(Math.min(anchor.index, head.index));
      const end = model.getPositionAt(Math.max(anchor.index, head.index));
      if (anchor.index !== head.index) next.push({ range: range(start, end), options: { className: `misty-peer-${peer.clientId}` } });
      next.push({ range: range(end, end), options: { beforeContentClassName: `misty-peer-head-${peer.clientId}` } });
    }
    decorations = model.deltaDecorations(decorations, next);
  };

  const onText = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin === LOCAL) return;
    applyDelta(event.delta as { retain?: number; insert?: unknown; delete?: number }[]);
    paint();
  };

  const onContent = (event: { changes: ModelChange[] }) => {
    if (applying) return;
    const changes = [...event.changes].sort((left, right) => right.rangeOffset - left.rangeOffset);
    room.doc.transact(() => {
      for (const change of changes) {
        if (change.rangeLength) text.delete(change.rangeOffset, change.rangeLength);
        if (change.text) text.insert(change.rangeOffset, normalized(change.text));
      }
    }, LOCAL);
  };

  setModel(text.toString());
  text.observe(onText);
  const disposables = [
    model.onDidChangeContent(onContent),
    editor.onDidChangeCursorSelection(publishSelection),
    editor.onDidChangeModel(publishSelection),
  ];
  room.awareness.on("change", paint);
  publishSelection();
  paint();

  return {
    text,
    destroy() {
      text.unobserve(onText);
      for (const disposable of disposables) disposable.dispose();
      room.awareness.off("change", paint);
      room.awareness.setLocalStateField(SELECTION_FIELD, null);
      decorations = model.deltaDecorations(decorations, []);
      document.getElementById(styleId)?.remove();
    },
  };
}

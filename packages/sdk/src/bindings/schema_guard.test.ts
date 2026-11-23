import { Schema } from "prosemirror-model";
import { EditorState, Plugin } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Awareness } from "y-protocols/awareness";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { MistyError } from "../errors.js";
import type { Room } from "../room.js";
import { schemaGuard } from "./schema_guard.js";
import { bindTiptap } from "./tiptap.js";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    text: {},
  },
});

function fakeSync(fragment: Y.XmlFragment) {
  const binding = {
    destroy: vi.fn(),
    initView: vi.fn() as unknown,
    _forceRerender: vi.fn() as unknown,
    _prosemirrorChanged: vi.fn() as unknown,
    mapping: new Map<unknown, unknown>([[fragment, { nodeSize: 4 }]]),
  };
  const plugin = new Plugin({
    state: { init: () => ({ type: fragment, binding }), apply: (_tr, value) => value },
  });
  return { binding, plugin };
}

function fakeView(state: EditorState) {
  const view = {
    state,
    dispatch: (tr: Transaction) => {
      view.state = view.state.apply(tr);
    },
  };
  return view as unknown as EditorView & { state: EditorState };
}

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

describe("schemaGuard", () => {
  it("stops the editor's sync before it renders content the schema doesn't know", async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("prosemirror");
    fragment.insert(0, [new Y.XmlElement("callout")]);
    const heard: MistyError[] = [];
    const guard = schemaGuard(fragment, { onUnsupported: (error) => heard.push(error) });
    const sync = fakeSync(fragment);
    const initView = sync.binding.initView;
    const state = EditorState.create({ schema, plugins: [guard.plugin, sync.plugin] });
    guard.plugin.spec.view?.(fakeView(state));
    await Promise.resolve();
    expect(guard.unsupported?.code).toBe("unsupported");
    expect(sync.binding.destroy).toHaveBeenCalled();
    expect(sync.binding.initView).not.toBe(initView);
    expect(heard.map((error) => error.code)).toEqual(["unsupported"]);
    expect(fragment.length).toBe(1);
    expect(state.filterTransaction(state.tr.insertText("a", 1))).toBe(false);
    guard.stop();
  });

  it("freezes when someone else adds a node the schema doesn't know", async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("prosemirror");
    fragment.insert(0, [new Y.XmlElement("paragraph")]);
    const guard = schemaGuard(fragment);
    const sync = fakeSync(fragment);
    const view = fakeView(EditorState.create({ schema, plugins: [guard.plugin, sync.plugin] }));
    guard.plugin.spec.view?.(view);
    expect(guard.unsupported).toBeNull();
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const element = new Y.XmlElement("paragraph");
    element.setAttribute("tone", "warm");
    other.getXmlFragment("prosemirror").insert(1, [element]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
    expect(guard.unsupported?.code).toBe("unsupported");
    expect(sync.binding.destroy).toHaveBeenCalled();
    expect(fragment.length).toBe(2);
    expect(sync.binding.mapping.size).toBe(0);
    expect(sync.binding.mapping.get(element)).toEqual({ nodeSize: 0 });
    guard.stop();
  });
});

describe("bindTiptap", () => {
  it("hands TipTap the schema guard to run ahead of its sync, and tells the app once", async () => {
    const room = fakeRoom();
    const heard: string[] = [];
    const collab = bindTiptap(room, { onUnsupported: (error) => heard.push(error.code) });
    expect(collab.guard.priority).toBeGreaterThan(1000);
    expect(collab.guard.plugins).toHaveLength(1);
    const fragment = room.doc.getXmlFragment("prosemirror");
    fragment.insert(0, [new Y.XmlElement("callout")]);
    const sync = fakeSync(fragment);
    const state = EditorState.create({ schema, plugins: [...collab.guard.plugins, sync.plugin] });
    collab.guard.plugins[0]!.spec.view?.(fakeView(state));
    collab.collaboration.ySyncOptions.onInvalidContent(new Error("invalid"));
    await Promise.resolve();
    expect(collab.unsupported?.code).toBe("unsupported");
    expect(sync.binding.destroy).toHaveBeenCalled();
    expect(heard).toEqual(["unsupported"]);
    collab.destroy();
  });

  it("throws at once for a document that already doesn't fit the schema it's given", () => {
    const room = fakeRoom();
    room.doc.getXmlFragment("prosemirror").insert(0, [new Y.XmlElement("callout")]);
    expect(() => bindTiptap(room, { schema })).toThrow(/newer version/);
  });
});

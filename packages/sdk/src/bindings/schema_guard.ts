import type { Schema } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import * as Y from "yjs";
import { MistyError } from "../errors.js";

export interface SchemaGuard {
  plugin: Plugin;
  readonly unsupported: MistyError | null;
  stop(): void;
}

export interface SchemaGuardOptions {
  schema?: Schema;
  onUnsupported?: (error: MistyError) => void;
}

interface FragmentEvent {
  readonly target: unknown;
  readonly keys: ReadonlyMap<string, unknown>;
  readonly changes: { readonly added: ReadonlySet<Y.Item> };
}

interface SyncBinding {
  destroy(): void;
  initView: unknown;
  _forceRerender: unknown;
  _prosemirrorChanged: unknown;
  mapping: Map<unknown, unknown>;
}

const NO_NODE = Object.freeze({ nodeSize: 0 });

function frozenMapping(): Map<unknown, unknown> {
  const mapping = new Map<unknown, unknown>();
  Object.defineProperty(mapping, "size", { get: () => 0 });
  mapping.get = () => NO_NODE;
  mapping.set = () => mapping;
  return mapping;
}

const HASHED_MARK = /(.*)(--[a-zA-Z0-9+/=]{8})$/;

const guardKey = new PluginKey("misty-schema-guard");

const markName = (attribute: string): string => HASHED_MARK.exec(attribute)?.[1] ?? attribute;

const knows = (attrs: object | undefined, key: string): boolean =>
  key === "ychange" || (attrs !== undefined && Object.hasOwn(attrs, key));

export const newerVersion = () =>
  new MistyError("unsupported", "This document was made by a newer version of the app, so it can't be edited here.");

function textGap(text: Y.XmlText, schema: Schema): string | null {
  for (const op of text.toDelta() as { attributes?: Record<string, unknown> }[]) {
    for (const [key, value] of Object.entries(op.attributes ?? {})) {
      const name = markName(key);
      if (name === "ychange") continue;
      const mark = schema.marks[name];
      if (!mark) return name;
      if (typeof value !== "object" || value === null) continue;
      for (const attr of Object.keys(value)) if (!knows(mark.spec.attrs, attr)) return `${name}.${attr}`;
    }
  }
  return null;
}

function elementGap(element: Y.XmlElement, schema: Schema): string | null {
  const node = schema.nodes[element.nodeName];
  if (!node) return element.nodeName;
  for (const key of Object.keys(element.getAttributes())) {
    if (!knows(node.spec.attrs, key)) return `${element.nodeName}.${key}`;
  }
  return null;
}

export function schemaGap(type: unknown, schema: Schema): string | null {
  if (type instanceof Y.XmlText) return textGap(type, schema);
  if (type instanceof Y.XmlElement) {
    const gap = elementGap(type, schema);
    if (gap) return gap;
  }
  if (!(type instanceof Y.XmlFragment)) return null;
  for (const child of type.toArray()) {
    const gap = schemaGap(child, schema);
    if (gap) return gap;
  }
  return null;
}

function eventGap(event: FragmentEvent, schema: Schema): string | null {
  const target = event.target;
  if (target instanceof Y.XmlText) return textGap(target, schema);
  if (target instanceof Y.XmlElement && event.keys.size > 0) {
    const gap = elementGap(target, schema);
    if (gap) return gap;
  }
  for (const item of event.changes.added) {
    for (const content of item.content.getContent() as unknown[]) {
      const gap = schemaGap(content, schema);
      if (gap) return gap;
    }
  }
  return null;
}

function syncBinding(state: EditorState, fragment: Y.XmlFragment): SyncBinding | undefined {
  for (const plugin of state.plugins) {
    const found = plugin.getState(state) as { type?: unknown; binding?: SyncBinding } | undefined;
    if (found && typeof found === "object" && found.type === fragment && found.binding) return found.binding;
  }
  return undefined;
}

function quiet(binding: SyncBinding | undefined): void {
  if (!binding) return;
  binding.destroy();
  const nothing = () => {};
  binding.initView = nothing;
  binding._forceRerender = nothing;
  binding._prosemirrorChanged = nothing;
  binding.mapping = frozenMapping();
}

export function schemaGuard(fragment: Y.XmlFragment, options: SchemaGuardOptions = {}): SchemaGuard {
  let unsupported: MistyError | null = null;
  let view: EditorView | null = null;
  let schema: Schema | null = options.schema ?? null;
  let watching = false;
  let stopped = false;

  const tell = (error: MistyError) => queueMicrotask(() => options.onUnsupported?.(error));

  const freeze = () => {
    if (unsupported) return;
    unsupported = newerVersion();
    stopWatching();
    const current = view;
    if (current) {
      quiet(syncBinding(current.state, fragment));
      current.dispatch(current.state.tr.setMeta(guardKey, true));
    }
    tell(unsupported);
  };

  const watch = (events: FragmentEvent[]) => {
    if (!schema || unsupported) return;
    for (const event of events) {
      if (eventGap(event, schema)) return freeze();
    }
  };

  function startWatching() {
    if (watching || stopped || unsupported) return;
    watching = true;
    fragment.observeDeep(watch);
  }

  function stopWatching() {
    if (!watching) return;
    watching = false;
    fragment.unobserveDeep(watch);
  }

  if (schema) {
    if (schemaGap(fragment, schema)) {
      unsupported = newerVersion();
      tell(unsupported);
    } else startWatching();
  }

  const plugin = new Plugin({
    key: guardKey,
    filterTransaction: (transaction) => !unsupported || !transaction.docChanged,
    props: {
      editable: () => !unsupported,
    },
    view: (editorView) => {
      view = editorView;
      schema ??= editorView.state.schema;
      if (!unsupported && schemaGap(fragment, schema)) {
        unsupported = newerVersion();
        stopWatching();
        tell(unsupported);
      }
      if (unsupported) quiet(syncBinding(editorView.state, fragment));
      else startWatching();
      return {
        destroy: () => {
          stopWatching();
          if (view === editorView) view = null;
        },
      };
    },
  });

  return {
    plugin,
    get unsupported() {
      return unsupported;
    },
    stop() {
      stopped = true;
      stopWatching();
    },
  };
}

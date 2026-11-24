---
title: Editor bindings
order: 4
---

# Editor bindings

A room bound to the editor an app is built on takes a few lines. Each binding:

- keeps the editor and the room's document in step, through the editor's own Yjs binding;
- draws everyone else's cursor and selection by Misty's identity (their name and avatar color), whatever their own
  awareness says;
- undoes only this person's own changes, so one person's undo never takes back another's work;
- takes its own cursor out of the room's awareness when it's destroyed.

Each editor's Yjs binding is an optional peer dependency: install the one for your editor. Yjs itself (`yjs`,
`y-protocols`, `lib0`) is a peer dependency too, so the app, the SDK and the editor's binding share one copy of
it; two copies of Yjs can't read each other's documents.

| Entry point | Editor | Install |
| --- | --- | --- |
| `@misty/sdk/codemirror` | CodeMirror 6 | `y-codemirror.next @codemirror/state @codemirror/view` |
| `@misty/sdk/monaco` | Monaco | `y-monaco monaco-editor` |
| `@misty/sdk/prosemirror` | ProseMirror | `y-prosemirror prosemirror-state prosemirror-view prosemirror-model` |
| `@misty/sdk/tiptap` | TipTap 3 | `@tiptap/extension-collaboration @tiptap/extension-collaboration-caret` |
| `@misty/sdk/store` | Anything with objects by id (shapes, cards, rows) | nothing |

Bind a [file's live document](live-rooms.md#a-file-as-a-live-document) the same way: a plain text file is
`room.text`, which every text binding takes by default. Bind once the room is `ready` (a file) or `synced`, so the
binding sees the document as it is.

The CodeMirror and Monaco bindings throw a `MistyError` with code `unsupported` for a text with Windows line
endings (`\r\n`): both editors count a line break as one character where the shared text has two, so every edit
after it would land in the wrong place for everyone. Show such a file read-only, or let the person convert it.

## CodeMirror

```ts
import { bindCodemirror } from "@misty/sdk/codemirror";

const room = misty.room.forFile(fileId);
await room.ready;
const collab = bindCodemirror(room); // room.doc.getText("text"), or { text } / { name }
const view = new EditorView({
  parent,
  doc: collab.text.toString(),
  extensions: [basicSetup, collab.extension],
});
// on close: view.destroy(); collab.destroy(); room.destroy();
```

Start the view with the shared text as its `doc`, as above, so the editor and the room begin equal.

`collab.extension` carries the sync, remote cursors and the undo keys (Mod-z, Mod-y, Mod-Shift-z), bound to
`collab.undoManager` ahead of any other keymap, so `basicSetup`'s own history never answers them. Changes that
arrive from the room are kept out of CodeMirror's own history too. If the app has its own Undo button or menu,
call `collab.undoManager.undo()`, never CodeMirror's `undo` command; leaving `history()` out of the editor (build
the setup without it) rules out the mix-up altogether.

## Monaco

```ts
import { bindMonaco } from "@misty/sdk/monaco";

const editor = monaco.editor.create(parent, { value: "", language: "markdown" });
const collab = bindMonaco(room, editor);
```

Undo and redo in the editor go to `collab.undoManager`, by the physical Z and Y keys, so they work on every
keyboard layout. Remote cursors are styled for you, with each person's name over their caret. The binding keeps the
model's line endings to `\n`.

## ProseMirror

```ts
import { bindProsemirror } from "@misty/sdk/prosemirror";
import { keymap } from "prosemirror-keymap";

const collab = bindProsemirror(room, {
  schema, // optional: check the document against it before binding
  onUnsupported: (error) => showReadOnly(error.message),
}); // room.doc.getXmlFragment("prosemirror"), or { fragment } / { name }
const state = EditorState.create({
  schema,
  plugins: [...collab.plugins, keymap({ "Mod-z": collab.undo, "Mod-y": collab.redo, "Mod-Shift-z": collab.redo })],
});
```

`collab.undo` and `collab.redo` are commands: asked without `dispatch` (as menus ask whether to enable an item),
they only say whether there is something to undo.

ProseMirror's Yjs binding deletes from the shared document anything the editor's schema doesn't know (a node, a
mark or an attribute), for everyone. That happens whenever someone opens a document with an older version of the
app than the one that wrote it. So the binding checks the document against the schema first, and keeps checking
as changes arrive: when something is missing it stops the editor where it is (read-only, nothing more written to
the room), sets `collab.unsupported` and calls `onUnsupported` with a `MistyError` whose code is `unsupported`
("This document was made by a newer version of the app"). With `schema` given, `bindProsemirror` throws that
error at once instead. Ask the person to update the app.

## TipTap

```ts
import { Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { bindTiptap } from "@misty/sdk/tiptap";

const collab = bindTiptap(room, { onUnsupported: (error) => showReadOnly(error.message) });
const editor = new Editor({
  extensions: [
    StarterKit.configure({ undoRedo: false }),
    Extension.create({
      name: collab.guard.name,
      priority: collab.guard.priority,
      addProseMirrorPlugins: () => collab.guard.plugins,
    }),
    Collaboration.configure(collab.collaboration),
    CollaborationCaret.configure(collab.caret),
  ],
});
```

TipTap's Collaboration extension brings its own undo, which already undoes only this person's changes; turn
StarterKit's off as shown.

`collab.guard` is the same schema guard the ProseMirror binding carries: when the document holds a node, a mark or
an attribute the editor's schema doesn't know, it keeps that content, stops editing and syncing in this editor, and
`onUnsupported` hears it once while `collab.unsupported` holds it. Add it as an extension with the priority it gives
(above Collaboration's), so it sees the document before TipTap's sync does. Pass `schema` (TipTap's `getSchema`
of the editor's extensions) to have `bindTiptap` throw that error at once for a document that already doesn't fit.
`collab.collaboration` also passes TipTap's sync an `onInvalidContent`, for a `@tiptap/y-tiptap` that has it.

## A plain object store

For an app whose model is objects by id (a diagram's shapes, a board's cards), `bindStore` gives a store on one
`Y.Map`, one entry per key, each value plain JSON. The last write of a key wins: a value is one whole, so when two
people change different fields of the same key at once, one change wins. Keep values that people edit apart under
keys of their own.

```ts
import { bindStore } from "@misty/sdk/store";

const shapes = bindStore<Shape>(room, { name: "shapes" });

shapes.set(shape.id, shape);
shapes.update(shape.id, { x: 40 });
shapes.transact(() => {
  shapes.delete(a.id);
  shapes.delete(b.id);
}); // one change, one undo step

shapes.subscribe(({ changed, removed, local }) => {
  if (!local) redraw(changed, removed);
});

shapes.undo(); // this person's own writes only; false when there was nothing to take back
shapes.setPresence({ cursor: { x, y }, selected: [shape.id] });
shapes.onPeers((peers) => {
  // { clientId, user_id, name, tone, color, colorLight, state }, state.presence being what each one set
});
```

`update` merges into the value as it is now, and does nothing to a key someone has since deleted. `get`,
`entries` and `toObject` hand out copies: change one and nothing happens until it is written back with `set`.

`peersOf(room)` and `colorsOf(tone)` are exported too, for an app that draws people itself.

## With no build step

`@misty/sdk/misty-sdk.js` (`dist/misty-sdk.js`) is one script that sets `window.MistySDK`: everything the package
exports, `MistySDK.Y` (Yjs, bundled, so make every Yjs type from it), `MistySDK.bindStore`, `MistySDK.peersOf`,
`MistySDK.colorsOf`, `MistySDK.openDocument`, `MistySDK.joinAsAgent` and `MistySDK.agentOfCall`, and
`MistySDK.bindMonacoModel`. It is for pages without a bundler and for the adapters Misty's registry reviews. It carries
its own copy of Yjs, so a page that uses it makes every Yjs type from `MistySDK.Y` and loads no other Yjs.

```html
<script src="misty-sdk.js"></script>
<script>
  MistySDK.connect().then(async (misty) => {
    const room = misty.room("board");
    await room.synced;
    const cards = MistySDK.bindStore(room, { name: "cards" });
  });
</script>
```

### Monaco from a page

The script can't carry `/monaco`, which imports Monaco itself. `bindMonacoModel(room, { editor, model, monaco },
{ text? })` binds a Monaco model the page already has to a room's text, given the page's own `editor`, `model` and
`monaco` objects: everyone's edits live, each person's cursor and selection drawn in their color (and each agent's,
from its presence's `selection`), and remote edits applied outside the person's undo.

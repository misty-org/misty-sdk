---
title: Editor bindings
order: 4
---

# Editor bindings

A room bound to the editor an app is built on takes a few lines. Each binding:

- keeps the editor and the room's document in step, through the editor's own Yjs binding;
- draws everyone else's cursor and selection by Misty's identity (their name and avatar color), whatever their own
  awareness says;
- undoes only this person's own changes, so one person's undo never takes back another's work.

Each editor's Yjs binding is an optional peer dependency: install the one for your editor.

| Entry point | Editor | Install |
| --- | --- | --- |
| `@misty/sdk/codemirror` | CodeMirror 6 | `y-codemirror.next @codemirror/state @codemirror/view` |
| `@misty/sdk/monaco` | Monaco | `y-monaco monaco-editor` |
| `@misty/sdk/prosemirror` | ProseMirror | `y-prosemirror prosemirror-state prosemirror-view prosemirror-model` |
| `@misty/sdk/tiptap` | TipTap 3 | `@tiptap/extension-collaboration @tiptap/extension-collaboration-caret` |
| `@misty/sdk/store` | Anything with objects by id (shapes, cards, rows) | nothing |

Bind a [file's live document](live-rooms.md#a-file-as-a-live-document) the same way: a plain text file is
`room.text`, which every text binding takes by default.

## CodeMirror

```ts
import { bindCodemirror } from "@misty/sdk/codemirror";

const room = misty.room.forFile(fileId);
await room.ready;
const collab = bindCodemirror(room); // room.doc.getText("text"), or { text } / { name }
const view = new EditorView({ parent, extensions: [basicSetup, collab.extension] });
// on close: collab.destroy(); view.destroy(); room.destroy();
```

`collab.extension` carries the sync, remote cursors and the undo keys (Mod-z, Mod-y, Mod-Shift-z), bound to
`collab.undoManager`.

## Monaco

```ts
import { bindMonaco } from "@misty/sdk/monaco";

const editor = monaco.editor.create(parent, { value: "", language: "markdown" });
const collab = bindMonaco(room, editor);
```

Undo and redo in the editor go to `collab.undoManager`. Remote cursors are styled for you, with each person's
name over their caret.

## ProseMirror

```ts
import { bindProsemirror } from "@misty/sdk/prosemirror";
import { keymap } from "prosemirror-keymap";

const collab = bindProsemirror(room); // room.doc.getXmlFragment("prosemirror"), or { fragment } / { name }
const state = EditorState.create({
  schema,
  plugins: [...collab.plugins, keymap({ "Mod-z": collab.undo, "Mod-y": collab.redo, "Mod-Shift-z": collab.redo })],
});
```

## TipTap

```ts
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { bindTiptap } from "@misty/sdk/tiptap";

const collab = bindTiptap(room);
const editor = new Editor({
  extensions: [
    StarterKit.configure({ undoRedo: false }),
    Collaboration.configure(collab.collaboration),
    CollaborationCaret.configure(collab.caret),
  ],
});
```

TipTap's Collaboration extension brings its own undo, which already undoes only this person's changes; turn
StarterKit's off as shown.

## A plain object store

For an app whose model is objects by id (a diagram's shapes, a board's cards), `bindStore` gives a store on one
`Y.Map`, one entry per key, each value plain JSON. The last write of a key wins.

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

shapes.undo(); // this person's own writes only
shapes.setPresence({ cursor: { x, y }, selected: [shape.id] });
shapes.onPeers((peers) => {
  // { clientId, user_id, name, tone, color, colorLight, state }, state.presence being what each one set
});
```

`peersOf(room)` and `colorsOf(tone)` are exported too, for an app that draws people itself.

## With no build step

`@misty/sdk/misty-sdk.js` (`dist/misty-sdk.js`) is one script that sets `window.MistySDK`: everything the package
exports, `MistySDK.Y` (Yjs, bundled, so make every Yjs type from it), `MistySDK.bindStore`, `MistySDK.peersOf` and
`MistySDK.colorsOf`. It is for pages without a bundler and for the adapters Misty's registry reviews.

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

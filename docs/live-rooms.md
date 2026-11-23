---
title: Live rooms
order: 3
---

# Live rooms

`room(id)` joins one of the app's shared Yjs documents in the Space, with everyone's awareness: cursors,
selections, whatever the app puts there. Everyone who opens the same room id edits the same document, so there is
no session to start. It needs the `rooms` permission.

```ts
const room = misty.room("deck-1");
await room.synced; // the room's current state has arrived

room.doc.getText("title").insert(0, "Launch");
room.awareness.setLocalStateField("cursor", { x: 0.4, y: 0.2 });

room.onLost((error) => {
  // "not_found": the room was deleted; "permission_denied": this person can no longer reach it.
});

room.destroy(); // leave, and free the document
```

Pass `{ gc: false }` to keep deleted content in the document, on the app's side and Misty's, for an app that
undoes its own history or shows who deleted what.

Each person works on their own copy and the changes merge. Nothing of one person's screen goes to another.

## Staying in step

The room and Misty compare what each has (Yjs state vectors) when it opens and whenever Misty's own connection to
the server comes back, so nothing is missed across a reload or a dropped connection. If an update can't be
delivered, the room compares again and sends what is missing, rather than dropping it. `room.onError(listener)`
hears each such problem; `onLost` is only for a room that has stopped for good.

## Who is who

Each person's awareness state carries Misty's own field, `misty`: `{ user_id, name, tone }`, with `tone` their
avatar color (`red`, `orange`, `yellow`, `green`, `blue`, `purple` or `gray`). Misty fills it in and the server
refuses any state that names someone else, so a cursor's name can be trusted. The app's own fields are its own.

```ts
for (const [client, state] of room.awareness.getStates()) {
  const who = room.identity(client); // { user_id, name, tone } or null
  drawCursor(state.cursor, who?.name, who?.tone);
}
```

`room.identity(room.doc.clientID)` is the person using the app.

## A file as a live document

`room.forFile(fileId)` opens a Space file as a live document, after VS Code's custom editors: Misty opens the file,
keeps everyone's copies in step and saves it, and the app only turns the document into bytes and back.

```ts
const room = misty.room.forFile(file.id, {
  load: (data, doc) => {
    // the room is new: fill `doc` from the file's bytes
    importScene(doc, new TextDecoder().decode(data));
  },
  serialize: (doc) => exportScene(doc), // Uint8Array, ArrayBuffer, Blob or string
});
await room.ready; // synced, and Misty has said what the file is

room.format; // "text" or "app"
room.writer; // whether this copy saves the file
room.onWriter((writer) => {});
```

- **Plain text** (Markdown, code, CSV and the like) is `format: "text"`: the document is `room.text`, a `Y.Text`,
  and the server saves it into the file itself. Bind an editor to it; no `load` or `serialize` is needed.
- **Anything else** is `format: "app"`: the document is the app's own, in a room of its own for this app and file.
  One open copy holds the writer's lease, held on the server by its connection and passed on to another open copy
  when it closes, with no timer and no election among apps. Misty calls `load` on that copy when the room is new,
  and `serialize` when the room has changed, and saves what it returns. Nothing unsaved is lost in between: it
  lives in the room on the server until a writer saves it.
- The file is marked in use by this person while the room is open.

`forFile` needs a Misty that has it: check `misty.supports("room.sync")` first.

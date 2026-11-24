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

One app holds one copy of a room: opening a room id that is already open throws a `MistyError` with code
`conflict`. Use the open one, or destroy it first.

Pass `{ gc: false }` to keep deleted content in the document, for an app that undoes its own history or shows who
deleted what. Misty keeps it on the app's side and in its own copy of the room. A Space's server that doesn't keep
deleted content yet still collects it there, so content deleted before everyone has closed the room may not come
back on a fresh load.

Each person works on their own copy and the changes merge. Nothing of one person's screen goes to another.

## Keys and options

`room(key, options)` is the one way to open a room; `room(key)` is the same call with no options. The key is the
app's own name for the room. Inside Misty, Misty keeps each app's keys apart; connected straight to a server
(see [Outside Misty](outside-misty.md)), the key is sent as given.

| Option | What it does |
| --- | --- |
| `gc` | `false` keeps deleted content |
| `history` | `true` keeps versions of the room, thinned over time, which `room.history` lists, reads and restores |
| `file` | binds the room to a Space file (below); `room.forFile(fileId, options)` is a short way to write `room(fileId, { file: fileId, ...options })` |
| `text` | with `file`: the name of the `Y.Text` the server saves into the file (`"text"`), or `null` when the app saves the whole document itself |

Whoever opens a room first fixes its options. Leaving an option out takes the room's; naming a different value
loses the room with code `conflict`.

## History

```ts
const board = misty.room("board", { history: true });
const versions = await board.history.list(); // [{ id, at, size, by }]
const then = await board.history.read(versions[1].id); // a Y.Doc of that version
await board.history.restore(versions[1].id); // needs edit access; the restore arrives as ordinary sync
```

On a room opened without `history`, the calls reject with `unsupported`. Inside Misty, history needs a Misty that
offers it (`misty.supports("room.option")`).

## Reading and changing without joining

`read` and `change` reach a room once, without staying in it: for a script, a bot or a webhook.

```ts
const doc = await misty.read("board"); // a Y.Doc of the room's content, or null for a room never opened
const json = await misty.read("board", { as: "json" }); // each shared value as JSON
await misty.change("board", (doc) => doc.getText("title").insert(0, "Q4 "));
```

`change` hands the edit a copy of the room's current content and sends only what the edit changed, so it merges
with everyone else's edits. Connected straight to a server they are one HTTP request each; where nothing can take a
one-off request, the SDK joins the room for a moment instead.

## Staying in step

The room and Misty compare what each has (Yjs state vectors) when it opens and whenever Misty's own connection to
the server comes back, so nothing is missed across a reload or a dropped connection. If an update can't be
delivered, the room compares again and sends what is missing, rather than dropping it, waiting a little longer
after each failure in a row (up to half a minute). If Misty stops the room for a passing reason, the room opens
again on its own with the same document, a few times before it gives up.

`room.onError(listener)` hears each such problem; `onLost` is only for a room that has stopped for good. Besides
the error codes every call has, a room can say:

| Code | What it means |
| --- | --- |
| `too_large` | The room reached the server's size limit: edits are not being saved |
| `too_large_warning` | The room is close to that limit |
| `stalled` | The room hasn't come into step in a while; Misty is still trying |
| `read_only` | This person can't edit here |
| `save_failed` | A file room couldn't save the file; the message says why |
| `reloaded` | The room was replaced on the server. The room stops (`onLost` hears `reloaded`) so its old content isn't pushed into the new one: open it again |

`room.synced` waits until the room is in step. While it can't be, `onError` says why, and every call to Misty
gives up after a while with an error rather than waiting forever.

`room.connected` says whether Misty's link to the server for this room is up, and `room.onConnection(listener)`
hears it change. Edits made while it's down are kept and sent when it comes back. Misty sends `connection` events
only where `misty.supports("room.connection")`; on an older Misty, `connected` stays `true`. Problems other than
failed calls need `misty.supports("room.problem")`.

## Who is who

Each person's awareness state carries Misty's own field, `misty`: `{ user_id, name, tone }`, with `tone` their
avatar color (`red`, `orange`, `yellow`, `green`, `blue`, `purple` or `gray`). Misty fills it in and the server
refuses any state that names someone else, so trust a name only when it comes from this field, through
`room.identity(client)`. Every other field is whatever that person's copy of the app wrote, a name included.

```ts
for (const [client, state] of room.awareness.getStates()) {
  const who = room.identity(client); // { user_id, name, tone } or null
  if (who) drawCursor(state.cursor, who.name, who.tone);
}
```

`room.identity(room.doc.clientID)` is the person using the app. A state with no `misty` field is nobody Misty
vouches for: the editor bindings don't draw it.

Someone's awareness lasts as long as their connection: it isn't timed out while they sit still, and it goes when
they leave.

## A file as a live document

`room(key, { file })`, or `room.forFile(fileId)` for short, opens a Space file as a live document, after VS Code's custom editors: Misty opens the file,
keeps everyone's copies in step and saves it, and the app only turns the document into bytes and back.

```ts
const room = misty.room.forFile(file.id, {
  load: (data, doc) => {
    // the room is new: fill `doc`, the document handed in, from the file's bytes
    importScene(doc, new TextDecoder().decode(data));
  },
  serialize: (doc) => exportScene(doc), // Uint8Array, ArrayBuffer, Blob or string
});
await room.ready; // synced, Misty has said what the file is, and its content is in the room

room.format; // "text" or "app"
room.writer; // whether this copy saves the file
room.loaded; // whether the file's content is in the room
room.editable; // whether this person can edit it
room.onWriter((writer) => {});
```

- **Text** is `format: "text"`: the document is `room.text`, a `Y.Text` (named by the `text` option, `"text"` by
  default), and the server saves it into the file itself. Bind an editor to it; no `load` or `serialize` is needed.
- **Anything else** is `format: "app"`: the document is the app's own, and the app must give both `load` and
  `serialize`. An app that gives both asks for this format (`text: null`) when it opens the room first. Without
  them the room stops as soon as it learns the file's format, with code `unsupported`, rather than open a file it
  could never save.
- One open copy holds the writer's lease, held on the server by its connection and passed on to another open copy
  when it closes, with no timer and no election among apps. Misty calls `load` on that copy when the room is new,
  and `serialize` when the room has changed, and saves what it returns. Nothing unsaved is lost in between: it
  lives in the room on the server until a writer saves it.
- `load` fills a fresh document of its own, which may take as long as it needs; the room then takes it in one
  change, together with the mark that says the room is loaded, so a room is never half loaded or loaded twice.
  Fill the `doc` it's given, not `room.doc`. If `load` throws, or takes more than 100 seconds, `onError` hears it
  and the room stays open; Misty asks once more, and a second failure rejects `ready`. A load that finishes after
  this copy stopped being the writer is dropped, since the new writer loads the file itself.
- `serialize` is only asked once the room is in step and loaded. If it throws, or the save fails, `onError` hears
  it; the room stays open.
- `ready` rejects with `read_only` when nobody who can edit the file has it open, so its content isn't in the room
  and can't be shown live. Fall back to `misty.files.download`. It rejects with `stalled` when the content
  hasn't arrived five minutes after the room is in step.
- A `problem` with code `reloaded` ends the room: the file changed somewhere else while nothing here was unsaved,
  so the room was opened afresh from it. Open the file again.
- The file is marked in use by this person while the room is open.

Inside Misty, Misty runs the file's side itself (who writes, saving, versions, conflicted copies, renames, changes
made elsewhere); connected straight to a server, the SDK runs that same code, reading and saving through the
Space's drive. Either way the app sees the same `FileRoom`.

`forFile` needs a Misty that has it: check `misty.supports("room.sync")` first. On a Misty that doesn't say
whether the file is loaded, `ready` waits only for the room to be in step.

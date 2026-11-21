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

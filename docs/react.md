---
title: React
order: 4
---

# React

```bash
npm install @misty/sdk @misty/sdk-react
```

```tsx
import { MistyProvider, useMembers, useSpace } from "@misty/sdk-react";

function Members() {
  const space = useSpace();
  const members = useMembers();
  return (
    <ul aria-label={space.name}>
      {members.value?.map((member) => <li key={member.user_id}>{member.name}</li>)}
    </ul>
  );
}

export function App() {
  return (
    <MistyProvider pending={<p>Connecting</p>} failed={(error) => <p>{error.message}</p>}>
      <Members />
    </MistyProvider>
  );
}
```

`MistyProvider` connects once. Pass `client` to give it an already connected client, for tests and previews.

## Hooks

| Hook | Returns |
| --- | --- |
| `useSpace()`, `useMe()` | The Space and the person |
| `useTheme()`, `useRoute()` | The theme and route, re-rendering on change |
| `useMembers()` | `{ value, loading, error, reload }` |
| `usePresence()` | `{ value, loading, error }`, kept current |
| `useFiles({ folder, accept, limit })` | The folder's files, refreshed as they change |
| `useRoom(id, options)` | `{ room, synced, error }`, left when the id changes or the view goes |

`loading` is true until the first value arrives or it fails.

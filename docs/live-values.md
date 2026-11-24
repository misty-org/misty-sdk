---
title: Live values
order: 8
---

# Live values

Everything that changes while the app runs (who is online, the voice channels, this window's call, a folder's
files, an agent driving the app) is a live value: `get()` gives what it is now, and `subscribe()` calls back with
each change. The shape is the one Svelte's stores, React's `useSyncExternalStore` and Vue's refs take, so no
framework package is needed.

```ts
const presence = misty.live.presence();

const stop = presence.subscribe(({ status, value, error }) => {
  if (status === "waiting") return; // nothing has arrived yet
  if (status === "failed") return console.warn(error?.code);
  console.log(value); // Presence[]
});
```

| Value | What it holds | Needs |
| --- | --- | --- |
| `misty.live.presence()` | `Presence[]`: everyone's state, status and the app they have open | `members` |
| `misty.live.voiceChannels()` | `VoiceChannel[]` | `calls` |
| `misty.live.call()` | `CallState`: this window's call in the Space | `calls` |
| `misty.live.files({ folder, accept })` | `FileRef[]` in a folder (the app's own by default), sorted by name, with who has each open | `files` |
| `misty.live.agent()` | `AgentControl`: an agent driving the app in this window, and who has control | |

Each state is `{ status, value, error }`: `status` is `waiting` until the first value arrives, `ready` once it
has, and `failed` if it stopped, keeping the last value. The same state object is returned by `get()` until the
next change, so it can be compared by identity.

A value starts listening when its first subscriber comes and stops when its last one leaves; asking for the same
value twice gives the same one. `subscribe()` calls back once at once with the current state.

## In a framework

React:

```tsx
import { useSyncExternalStore } from "react";

const presence = misty.live.presence();
const state = useSyncExternalStore(presence.subscribe, presence.get);
```

Svelte (a live value is a store as it is):

```svelte
<script>
  const presence = misty.live.presence();
</script>

{#if $presence.status === "ready"}{$presence.value.length} here{/if}
```

Vue:

```ts
import { onScopeDispose, shallowRef } from "vue";

const presence = misty.live.presence();
const state = shallowRef(presence.get());
onScopeDispose(presence.subscribe((next) => (state.value = next)));
```

## Your own

`live(source)` from `@misty/sdk` makes a value from anything that pushes: `source(set, fail)` starts listening and
returns how to stop.

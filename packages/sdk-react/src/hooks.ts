import type {
  CallState,
  FileRef,
  ListFilesOptions,
  Me,
  Member,
  Presence,
  Room,
  RoomOptions,
  Route,
  Space,
  Theme,
  VoiceChannel,
} from "@misty/sdk";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useMisty } from "./context.js";
import { useLive, useLoaded } from "./useLive.js";
import type { Loaded } from "./useLive.js";

export const useSpace = (): Space => useMisty().space();
export const useMe = (): Me => useMisty().me();

export function useTheme(): Theme {
  const misty = useMisty();
  return useSyncExternalStore(
    (notify) => misty.onTheme(notify),
    () => misty.theme(),
  );
}

export function useRoute(): Route {
  const misty = useMisty();
  return useSyncExternalStore(
    (notify) => misty.onRoute(notify),
    () => misty.route(),
  );
}

export function useMembers(): Loaded<Member[]> & { reload: () => void } {
  const misty = useMisty();
  return useLoaded("members", () => misty.members.list());
}

export function usePresence(): Loaded<Presence[]> {
  const misty = useMisty();
  return useLive("presence", (listener) => misty.members.presence(listener));
}

/** The Space's voice channels and who is in each, live. Needs the `calls` permission. */
export function useVoiceChannels(): Loaded<VoiceChannel[]> {
  const misty = useMisty();
  return useLive<VoiceChannel[]>("calls.channels", (listener) => misty.calls.channels(listener));
}

/** This window's call (its voice channel and microphone), live, with join, leave and mute. */
export function useCall(): Loaded<CallState> & Pick<ReturnType<typeof useMisty>["calls"], "join" | "leave" | "setMuted"> {
  const misty = useMisty();
  const state = useLive<CallState>("calls.current", (listener) => misty.calls.current(listener));
  return { ...state, join: misty.calls.join, leave: misty.calls.leave, setMuted: misty.calls.setMuted };
}

/** The Space's files in a folder, refreshed when any of them is added, changed or removed. */
export function useFiles(options: ListFilesOptions = {}): Loaded<FileRef[]> & { reload: () => void } {
  const misty = useMisty();
  const { folder, accept, limit } = options;
  const key = JSON.stringify([folder ?? null, accept ?? null, limit ?? null]);
  const files = useLoaded(`files:${key}`, async () => (await misty.files.list({ folder, accept, limit })).files);
  const { reload } = files;

  useEffect(
    () => misty.files.watch(() => reload(), { folder, accept }),
    // `key` stands for folder and accept, so the subscription restarts only when they change.
    [misty, key, reload],
  );
  return files;
}

export interface RoomState {
  room: Room | undefined;
  /** True once the room's current state has arrived. */
  synced: boolean;
  /** Why it couldn't open, or why it stopped after opening (deleted, access lost). */
  error: Error | undefined;
}

/** A live room: its Yjs document and awareness. Left and freed when the id changes or the view goes. */
export function useRoom(id: string, options?: RoomOptions): RoomState {
  const misty = useMisty();
  const [state, setState] = useState<RoomState>({ room: undefined, synced: false, error: undefined });
  const gc = options?.gc;

  useEffect(() => {
    const room = misty.room(id, gc === undefined ? undefined : { gc });
    setState({ room, synced: false, error: undefined });
    let active = true;
    room.synced.then(
      () => {
        if (active) setState({ room, synced: true, error: undefined });
      },
      (error: unknown) => {
        if (active) setState({ room, synced: false, error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    // A room lost after it synced says so too; one lost before is the rejection above.
    const stopLost = room.onLost((error) => {
      if (active) setState((current) => (current.synced ? { room, synced: true, error } : current));
    });
    return () => {
      active = false;
      stopLost();
      room.destroy();
    };
  }, [misty, id, gc]);

  return state;
}

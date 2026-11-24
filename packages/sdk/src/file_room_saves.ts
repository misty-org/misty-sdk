import { sha256Hex } from "./base64.js";
import type { FileEntry, FileStore } from "./file_store.js";
import { settledOnServer } from "./file_room_renames.js";
import { sleep, withTimeout } from "./timing.js";

const WRITE_RETRY_MS = 2_000;
export const WRITE_BOUND_MS = 120_000;

export async function contentSha(data: Uint8Array): Promise<string | undefined> {
  try {
    return await sha256Hex(data);
  } catch {
    return undefined;
  }
}

export const matchesSave = (pending: { version?: number; mtime?: number; sha?: string }, next: FileEntry): boolean => {
  if (pending.version !== undefined && (next.version ?? 0) !== pending.version) return false;
  if (pending.sha !== undefined && next.sha !== undefined) return next.sha === pending.sha;
  return pending.mtime === undefined || typeof next.mtime_ms !== "number" || next.mtime_ms === pending.mtime;
};

interface WriteWindow {
  from: number;
  to: number;
}

async function landed(store: FileStore, id: string, size: number, base: number, during: WriteWindow, sha?: string) {
  const now = await store.entry(id).catch(() => null);
  if (!now || (now.version ?? 0) <= base || now.size !== size || !settledOnServer(now.state)) return null;
  if (sha !== undefined && now.sha !== undefined) return now.sha === sha ? now : null;
  return typeof now.mtime_ms !== "number" || (now.mtime_ms >= during.from && now.mtime_ms <= during.to) ? now : null;
}

export interface SaveWrite {
  store: FileStore;
  entry: () => FileEntry;
  base: () => number;
  known?: () => number;
  still: () => boolean;
  writing: (busy: boolean) => void;
}

export interface SaveWritten {
  written: FileEntry;
  base: number;
  sha?: string;
}

export async function writeSave(save: SaveWrite, data: Uint8Array): Promise<SaveWritten | null> {
  let since: number | undefined;
  let base = save.base();
  const hashing = contentSha(data);
  let sha: string | undefined;
  void hashing.then((value) => {
    sha = value;
  });
  for (let attempt = 0; ; attempt += 1) {
    if (!save.still()) return null;
    try {
      const now = (await save.store.entry(save.entry().id)) ?? save.entry();
      if (!save.still()) return null;
      base = save.base();
      save.writing(true);
      since ??= Date.now();
      try {
        const written = await withTimeout(save.store.write(now, data, base), WRITE_BOUND_MS, "The save didn't finish in time.");
        return { written, base, sha: await hashing };
      } finally {
        save.writing(false);
      }
    } catch (cause) {
      const floor = Math.max(base, save.known?.() ?? 0);
      const during: WriteWindow = { from: since ?? 0, to: Date.now() };
      const ours = since === undefined ? null : await landed(save.store, save.entry().id, data.byteLength, floor, during, sha);
      if (ours) return { written: ours, base, sha };
      if (attempt >= 1) throw cause;
      await sleep(WRITE_RETRY_MS);
    }
  }
}

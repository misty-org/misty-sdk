import type { FileEntry, FileStore, FileStoreChange, FileStoreItem } from "./file_store.js";
import { withTimeout } from "./timing.js";

export const SERVER_CONTENT_BOUND_MS = 5_000;
export const SERVER_CONTENT_RETRY_MS = 60_000;

interface ServerVersions {
  version: number;
  content: number;
}

export interface ServerContents {
  entry(entry: FileEntry): Promise<FileEntry>;
  events(listener: (changed: FileStoreChange) => void): (changed: FileStoreChange) => void;
}

const positive = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);

export function serverContents(store: FileStore, itemId: string): ServerContents {
  let known: ServerVersions | null = null;
  let unsupported = !store.versions;
  let queue: Promise<void> | null = null;
  let failed: { at: number; version: number } | null = null;
  const resting = (entry: FileEntry) =>
    failed !== null && Date.now() - failed.at < SERVER_CONTENT_RETRY_MS && (entry.version ?? 0) < failed.version + 2;
  const fill = (entry: FileEntry): FileEntry | null => {
    if (typeof entry.content_version === "number") return entry;
    const version = entry.version ?? 0;
    return known && known.content <= version && version <= known.version ? { ...entry, content_version: known.content } : null;
  };
  const read = async (entry: FileEntry): Promise<FileEntry> => {
    const filled = fill(entry);
    if (filled || unsupported || !entry.version || resting(entry) || !store.versions) return filled ?? entry;
    const asked = entry.version;
    try {
      const answer = await withTimeout(
        store.versions(itemId),
        SERVER_CONTENT_BOUND_MS,
        "The drive's versions didn't arrive in time.",
      );
      const version = positive(answer?.version);
      const content = positive(answer?.content_version);
      if (version !== undefined && content === undefined) unsupported = true;
      if (version !== undefined && content !== undefined && content <= version && version >= (known?.version ?? 0))
        known = { version, content };
      failed = null;
    } catch {
      failed = { at: Date.now(), version: asked };
      return entry;
    }
    return fill(entry) ?? entry;
  };
  const withItem = (changed: FileStoreChange, item: FileStoreItem): FileStoreChange => ({
    ...changed,
    items: changed.items.map((each) => (each.id === itemId ? item : each)),
  });
  return {
    entry: read,
    events(listener) {
      return (changed) => {
        const mine = changed.items.find((item) => item.id === itemId);
        const live = mine && !mine.removed && !mine.trashed ? mine : undefined;
        const filled = live ? fill(live) : null;
        if (!queue && (!live || filled || unsupported || resting(live))) {
          listener(live && filled && filled !== live ? withItem(changed, { ...live, ...filled }) : changed);
          return;
        }
        const next = (queue ?? Promise.resolve())
          .then(async () => {
            const item = live ? await read(live) : undefined;
            listener(live && item && item !== live ? withItem(changed, { ...live, ...item }) : changed);
          })
          .catch(() => undefined);
        queue = next;
        void next.then(() => {
          if (queue === next) queue = null;
        });
      };
    },
  };
}

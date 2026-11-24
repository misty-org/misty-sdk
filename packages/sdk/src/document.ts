import type * as Y from "yjs";
import type { Misty } from "./client.js";
import type { Unsubscribe } from "./connection.js";
import { FILE_META, type FileData, type FileRoom } from "./room.js";
import type { FileRef } from "./types.js";

const MAX_LISTED_PAGES = 20;

export interface DocumentOptions {
  extension: string;
  mime: string;
  name: string;
  load(data: ArrayBuffer, doc: Y.Doc): void | Promise<void>;
  serialize(doc: Y.Doc): FileData | Promise<FileData>;
  current(): FileData | Promise<FileData>;
  show(data: ArrayBuffer, file: FileRef): void | Promise<void>;
  live(room: FileRoom): void | Promise<void>;
  opening?(room: FileRoom): void;
  saveAfterMs?: number;
  liveRooms?: boolean;
}

export interface OpenedDocument {
  readonly room: FileRoom | null;
  readonly file: FileRef | null;
  readonly live: boolean;
  readonly ready: Promise<void>;
  changed(): void;
  onFile(listener: (file: FileRef) => void): Unsubscribe;
  destroy(): void;
}

const bytesOf = async (data: FileData): Promise<Uint8Array | ArrayBuffer | Blob> =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;

export async function freeFileName(misty: Misty, base: string, extension: string, folder?: string): Promise<string> {
  const taken = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LISTED_PAGES; page += 1) {
    const result = await misty.files.list({ accept: [extension], cursor, ...(folder ? { folder } : {}) });
    for (const file of result.files) taken.add(file.name.toLowerCase());
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  for (let number = 1; ; number += 1) {
    const name = `${number === 1 ? base : `${base} ${number}`}${extension}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function openDocument(misty: Misty, options: DocumentOptions): OpenedDocument {
  const saveAfter = options.saveAfterMs ?? 1000;
  const live = options.liveRooms !== false && misty.supports("room.sync") && misty.permissions.includes("rooms");
  const fileListeners = new Set<(file: FileRef) => void>();
  const stops: Unsubscribe[] = [];
  let room: FileRoom | null = null;
  let file: FileRef | null = null;
  let destroyed = false;
  let onChange: (() => void) | null = null;

  const setFile = (next: FileRef) => {
    file = next;
    for (const listener of [...fileListeners]) listener(next);
  };

  const openLive = async (fileId: string) => {
    const opened = misty.room.forFile(fileId, { load: options.load, serialize: options.serialize });
    room = opened;
    options.opening?.(opened);
    stops.push(opened.onFile(setFile));
    await opened.ready;
    if (opened.file) setFile(opened.file);
    const meta = opened.doc.getMap(FILE_META);
    if (meta.get("loaded") === undefined) {
      await new Promise<void>((resolve) => {
        const loaded = () => {
          if (meta.get("loaded") === undefined) return;
          meta.unobserve(loaded);
          resolve();
        };
        meta.observe(loaded);
      });
    }
    if (!destroyed) await options.live(opened);
  };

  const openPlain = async (fileId: string) => {
    const got = await misty.files.download(fileId);
    setFile(got.file);
    await options.show(got.data, got.file);
    let savedAt = got.file.updated_at;
    let saving = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const at = file;
        if (!at || destroyed) return;
        saving = true;
        void Promise.resolve(options.current())
          .then(bytesOf)
          .then((data) => misty.files.save({ name: at.name, mime: at.mime || options.mime, folder: at.folder, data }))
          .then((saved) => {
            savedAt = saved.updated_at;
            setFile(saved);
          })
          .catch(() => undefined)
          .finally(() => {
            saving = false;
          });
      }, saveAfter);
    };
    stops.push(() => clearTimeout(timer));
    stops.push(
      misty.files.watch(
        (change) => {
          if (change.kind !== "changed" || !file || change.file.id !== file.id) return;
          if (change.file.updated_at === savedAt || timer || saving) return;
          savedAt = change.file.updated_at;
          void misty.files
            .download(change.file.id)
            .then((fresh) => {
              if (timer || destroyed) return;
              setFile(fresh.file);
              return options.show(fresh.data, fresh.file);
            })
            .catch(() => undefined);
        },
        got.file.folder ? { folder: got.file.folder } : undefined,
      ),
    );
  };

  const openBlank = () => {
    let started = false;
    onChange = () => {
      if (started) return;
      started = true;
      void freeFileName(misty, options.name, options.extension)
        .then(async (name) => {
          const data = await bytesOf(await options.current());
          return misty.files.save({ name, mime: options.mime, data });
        })
        .then((saved) => {
          if (destroyed) return;
          onChange = null;
          setFile(saved);
          return live ? openLive(saved.id) : openPlain(saved.id);
        })
        .catch(() => {
          started = false;
        });
    };
  };

  const fileId = misty.route().params.file;
  const ready =
    typeof fileId === "string" && fileId
      ? live
        ? openLive(fileId)
        : openPlain(fileId)
      : Promise.resolve(openBlank());
  ready.catch(() => undefined);

  return {
    get room() {
      return room;
    },
    get file() {
      return file;
    },
    live,
    ready,
    changed() {
      if (!destroyed) onChange?.();
    },
    onFile(listener) {
      fileListeners.add(listener);
      return () => fileListeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const stop of stops.splice(0)) stop();
      fileListeners.clear();
      room?.destroy();
    },
  };
}

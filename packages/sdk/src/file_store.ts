import type { Unsubscribe } from "./connection.js";
import type { FileRef } from "./types.js";

export type FileEntryState = "online" | "downloaded" | "downloading" | "uploading" | "conflict" | "not_synced";

export interface FileEntryUse {
  user_id?: string;
  name: string;
  editing: boolean;
  you?: boolean;
}

export interface FileEntry {
  id: string;
  path: string;
  name: string;
  kind: "file" | "folder";
  size: number;
  mtime_ms: number;
  state: FileEntryState;
  version?: number;
  content_version?: number;
  sha?: string;
  modified_by_name?: string;
  in_use?: FileEntryUse[];
}

export type FileStoreItem = FileEntry & { removed?: boolean; trashed?: boolean };

export interface FileStoreChange {
  items: FileStoreItem[];
  removed?: string[];
}

export interface FileVersions {
  version?: number;
  content_version?: number;
}

export interface FileStore {
  entry(fileId: string): Promise<FileEntry | null>;
  read(entry: FileEntry): Promise<ArrayBuffer>;
  write(entry: FileEntry, data: Uint8Array, base: number): Promise<FileEntry>;
  copy(entry: FileEntry, name: string, data: Uint8Array): Promise<FileEntry>;
  watch(listener: (change: FileStoreChange) => void): Unsubscribe;
  hold?(entry: FileEntry): Promise<() => void>;
  versions?(fileId: string): Promise<FileVersions | undefined>;
  ref?(entry: FileEntry): FileRef;
}

const MIME_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  json: "application/json",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  zip: "application/zip",
};

export function mimeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

export function folderOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return `/${parts.slice(0, -1).join("/")}`;
}

export function fileRefOf(entry: FileEntry, store?: FileStore): FileRef {
  if (store?.ref) return store.ref(entry);
  return {
    id: entry.id,
    name: entry.name,
    mime: mimeOf(entry.name),
    size: Number.isFinite(entry.size) ? entry.size : 0,
    folder: folderOf(entry.path),
    updated_at: new Date(Number.isFinite(entry.mtime_ms) ? entry.mtime_ms : 0).toISOString(),
    in_use: (entry.in_use ?? []).map((use) => ({
      user_id: use.user_id ?? "",
      name: use.name,
      editing: use.editing,
      you: use.you === true,
    })),
  };
}

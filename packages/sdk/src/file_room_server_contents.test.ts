import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry, FileStore, FileStoreChange } from "./file_store.js";
import { SERVER_CONTENT_RETRY_MS, serverContents } from "./file_room_server_contents.js";

const api = vi.hoisted(() => ({
  answer: null as (() => Promise<unknown>) | null,
  asked: [] as string[],
}));

const store = {
  versions: (fileId: string) => {
    api.asked.push(`/spaces/space-1/drive/items/${fileId}`);
    return api.answer ? api.answer() : Promise.reject(new Error("offline"));
  },
} as unknown as FileStore;

const at = (version: number, content?: number) =>
  ({ id: "file-1", space_id: "space-1", name: "a.bin", path: "/a.bin", kind: "file", version, size: 3, mtime_ms: 1,
    state: "downloaded", ...(content === undefined ? {} : { content_version: content }) }) as FileEntry;

const change = (...items: FileEntry[]): FileStoreChange => ({ items });

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  api.answer = null;
  api.asked = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server content versions", () => {
  it("fills an entry's content version from the server once, and from what it said while the version stays in range", async () => {
    api.answer = async () => ({ version: 6, content_version: 4 });
    const server = serverContents(store, "file-1");
    expect((await server.entry(at(5))).content_version).toBe(4);
    expect(api.asked).toEqual(["/spaces/space-1/drive/items/file-1"]);
    const seen: FileStoreChange[] = [];
    server.events((changed) => seen.push(changed))(change(at(6)));
    expect(seen.at(-1)!.items[0]!.content_version).toBe(4);
    expect(api.asked).toHaveLength(1);
  });

  it("passes events through at once when they carry content versions or aren't about the file", () => {
    const server = serverContents(store, "file-1");
    const seen: FileStoreChange[] = [];
    const listener = server.events((changed) => seen.push(changed));
    const own = change(at(7, 7));
    const other = change({ ...at(3), id: "file-2" });
    listener(own);
    listener(other);
    expect(seen).toEqual([own, other]);
    expect(api.asked).toHaveLength(0);
  });

  it("keeps events in order behind a read, and hands them on as they were when the server can't say", async () => {
    let answer!: (value: unknown) => void;
    api.answer = () => new Promise((resolve) => (answer = resolve));
    const server = serverContents(store, "file-1");
    const seen: FileStoreChange[] = [];
    const listener = server.events((changed) => seen.push(changed));
    listener(change(at(6)));
    const later = change(at(7, 7));
    listener(later);
    await flush();
    expect(seen).toHaveLength(0);
    answer({ version: 6, content_version: 6 });
    await flush();
    expect(seen.map((changed) => changed.items[0]!.content_version)).toEqual([6, 7]);
    api.answer = null;
    listener(change(at(9)));
    await flush();
    expect(seen.at(-1)!.items[0]!.content_version).toBeUndefined();
  });

  it("stops asking a server that names no content versions", async () => {
    api.answer = async () => ({ version: 5 });
    const server = serverContents(store, "file-1");
    expect((await server.entry(at(5))).content_version).toBeUndefined();
    const seen: FileStoreChange[] = [];
    server.events((changed) => seen.push(changed))(change(at(6)));
    expect(seen).toHaveLength(1);
    expect(api.asked).toHaveLength(1);
  });

  it("never takes a content version for a version the server's answer doesn't cover", async () => {
    api.answer = async () => ({ version: 8, content_version: 7 });
    const server = serverContents(store, "file-1");
    expect((await server.entry(at(5))).content_version).toBeUndefined();
  });

  it("rests after a failed read, passing events on unfilled, until the version moves two past it or a minute goes by", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const server = serverContents(store, "file-1");
    const seen: FileStoreChange[] = [];
    const listener = server.events((changed) => seen.push(changed));
    listener(change(at(6)));
    await flush();
    expect(seen).toHaveLength(1);
    expect(api.asked).toHaveLength(1);
    listener(change(at(7)));
    expect(seen).toHaveLength(2);
    expect(seen.at(-1)!.items[0]!.content_version).toBeUndefined();
    expect((await server.entry(at(7))).content_version).toBeUndefined();
    expect(api.asked).toHaveLength(1);
    listener(change(at(8)));
    await flush();
    expect(seen).toHaveLength(3);
    expect(api.asked).toHaveLength(2);
    listener(change(at(9)));
    expect(seen).toHaveLength(4);
    expect(api.asked).toHaveLength(2);
    now += SERVER_CONTENT_RETRY_MS;
    api.answer = async () => ({ version: 9, content_version: 8 });
    listener(change(at(9)));
    await flush();
    expect(api.asked).toHaveLength(3);
    expect(seen.at(-1)!.items[0]!.content_version).toBe(8);
  });
});

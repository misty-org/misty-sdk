import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { connect } from "./client.js";
import type { MistyError } from "./errors.js";
import { memoryServer } from "./memory_server.fixture.js";
import { openRoomClient } from "./room_client.js";
import { CLOSE_CODES } from "./transport.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

afterEach(() => {
  vi.useRealTimers();
});

describe("the room client", () => {
  it("syncs two clients through the server and shares their presence", async () => {
    const server = memoryServer();
    const one = openRoomClient({ transport: server.transport, space: "sp_1", key: "board" });
    const two = openRoomClient({ transport: server.transport, space: "sp_1", key: "board" });
    await Promise.all([one.synced, two.synced]);
    one.doc.getText("title").insert(0, "Launch");
    await vi.waitFor(() => expect(two.doc.getText("title").toString()).toBe("Launch"));
    one.awareness.setLocalStateField("cursor", 3);
    await vi.waitFor(() => expect(two.awareness.getStates().get(one.doc.clientID)).toEqual({ cursor: 3 }));
    expect(server.opens[0]!.request).toMatchObject({ space: "sp_1", key: "board", options: {} });
    one.close();
    await vi.waitFor(() => expect(two.awareness.getStates().has(one.doc.clientID)).toBe(false));
    two.close();
  });

  it("sends its own changes made while the link was down once it is back", async () => {
    const server = memoryServer();
    const client = openRoomClient({ transport: server.transport, space: "sp_1", key: "notes" });
    await client.synced;
    const changes: boolean[] = [];
    client.onConnection((connected) => changes.push(connected));
    server.opens[0]!.close(CLOSE_CODES.internal);
    await vi.waitFor(() => expect(client.connected).toBe(false));
    client.doc.getText("t").insert(0, "offline");
    await vi.waitFor(() => expect(server.opens).toHaveLength(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(server.rooms.get("notes")!.doc.getText("t").toString()).toBe("offline"));
    expect(changes).toEqual([false, true]);
    client.close();
  });

  it("gives up on a final close code and says why", async () => {
    const server = memoryServer({ admit: () => CLOSE_CODES.forbidden });
    const client = openRoomClient({ transport: server.transport, space: "sp_1", key: "secret" });
    const lost = await new Promise<MistyError>((resolve) => client.onLost(resolve));
    expect(lost.code).toBe("permission_denied");
    await expect(client.synced).rejects.toMatchObject({ code: "permission_denied" });
    await settle();
    expect(server.opens).toHaveLength(1);
    client.close();
  });

  it("reconnects at once to the address a moved message names", async () => {
    let first = true;
    const server = memoryServer({
      admit: (peer) => {
        if (!first) return;
        first = false;
        peer.open({
          room: "rm_1",
          role: "edit",
          options: {},
          seats: 40,
          max_bytes: 1,
          identity: { kind: "person", id: "ana", name: "Ana" },
        });
        peer.sendText({ type: "moved", url: "wss://owner.example.com" });
        peer.close(CLOSE_CODES.moved);
        return CLOSE_CODES.moved;
      },
    });
    const client = openRoomClient({ transport: server.transport, space: "sp_1", key: "deck" });
    await client.synced;
    expect(server.opens[1]!.request.url).toBe("wss://owner.example.com");
    client.close();
  });

  it("asks for a fresh sign-in and reconnects at once after a reauth close", async () => {
    let count = 0;
    const server = memoryServer({ admit: () => (count++ === 0 ? CLOSE_CODES.reauth : undefined) });
    const client = openRoomClient({ transport: server.transport, space: "sp_1", key: "deck" });
    await client.synced;
    expect(server.opens[0]!.request.fresh).toBeUndefined();
    expect(server.opens[1]!.request.fresh).toBe(true);
    client.close();
  });

  it("lists a room's history over option messages", async () => {
    const server = memoryServer({
      onText: (peer, message) => {
        if (message.option !== "history") return;
        if (message.type === "list")
          peer.sendText({
            option: "history",
            type: "list",
            request: message.request,
            versions: [{ id: "v1", at: "2026-11-23T10:00:00Z", size: 12, by: "ana" }],
          });
        if (message.type === "read") {
          const doc = new Y.Doc();
          doc.getText("t").insert(0, "then");
          peer.sendText({
            option: "history",
            type: "read",
            request: message.request,
            version: message.version,
            update: btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc))),
          });
        }
        if (message.type === "restore")
          peer.sendText({ option: "history", type: "error", request: message.request, code: "read_only" });
      },
    });
    const client = openRoomClient({ transport: server.transport, space: "sp_1", key: "deck", options: { history: true } });
    await client.synced;
    await expect(client.history.list()).resolves.toEqual([{ id: "v1", at: "2026-11-23T10:00:00Z", size: 12, by: "ana" }]);
    expect((await client.history.read("v1")).getText("t").toString()).toBe("then");
    await expect(client.history.restore("v1")).rejects.toMatchObject({ code: "permission_denied" });
    client.close();
  });

  it("says a room without history keeps none", async () => {
    const server = memoryServer();
    const client = openRoomClient({ transport: server.transport, space: "sp_1", key: "deck" });
    await client.synced;
    await expect(client.history.list()).rejects.toMatchObject({ code: "unsupported" });
    client.close();
  });

  it("reads the identity the server puts in presence", async () => {
    const server = memoryServer();
    const client = openRoomClient({ transport: server.transport, space: "sp_1", key: "deck" });
    await client.synced;
    expect(client.identity(client.doc.clientID)).toEqual({ user_id: "ana", name: "Ana", tone: null });
    client.close();
  });
});

describe("connect with a transport", () => {
  it("opens rooms, reads them and changes them", async () => {
    const server = memoryServer();
    const misty = await connect({ transport: server.transport, space: "sp_1" });
    const room = misty.room("board", { history: false });
    await room.synced;
    room.doc.getText("title").insert(0, "Q4");
    await vi.waitFor(() => expect(server.rooms.get("board")!.doc.getText("title").toString()).toBe("Q4"));
    expect(() => misty.room("board")).toThrow(/already open/);
    await misty.change("board", (doc) => doc.getText("title").insert(0, "Plan "));
    await vi.waitFor(() => expect(room.doc.getText("title").toString()).toBe("Plan Q4"));
    const copy = await misty.read("board");
    expect(copy?.getText("title").toString()).toBe("Plan Q4");
    room.destroy();
    const again = misty.room("board");
    await again.synced;
    misty.close();
    await vi.waitFor(() => expect(server.opens.at(-1)!.closed).toBe(true));
  });

  it("uses the request transport for read and change when it has one", async () => {
    const stored = new Y.Doc();
    stored.getText("t").insert(0, "kept");
    const written: { update: Uint8Array; options?: unknown }[] = [];
    const server = memoryServer({
      request: {
        read: async ({ as }) => (as === "json" ? { t: "kept" } : Y.encodeStateAsUpdate(stored)),
        write: async ({ update, options }) => {
          written.push({ update, options });
          Y.applyUpdate(stored, update);
        },
      },
    });
    const misty = await connect({ transport: server.transport, space: "sp_1" });
    expect(await misty.read("notes", { as: "json" })).toEqual({ t: "kept" });
    await misty.change("notes", (doc) => doc.getText("t").insert(4, "!"), { history: true });
    expect(stored.getText("t").toString()).toBe("kept!");
    expect(written[0]!.options).toEqual({ history: true });
    await misty.change("notes", () => undefined);
    expect(written).toHaveLength(1);
    expect(server.opens).toHaveLength(0);
    misty.close();
  });
});

describe("a file room over a direct connection", () => {
  it("loads the file's text as the writer and shows it to the app", async () => {
    const server = memoryServer({
      afterOpen: (peer) => {
        if (!peer.request.options.file) return;
        peer.sendText({
          option: "file",
          type: "file_writer",
          writer: true,
          dirty: false,
          read_only: false,
          loaded: false,
          generation: "g1",
          base: 0,
          has_writer: true,
        });
      },
    });
    const entry = {
      id: "file-1",
      name: "a.txt",
      path: "/a.txt",
      kind: "file" as const,
      version: 3,
      size: 5,
      mtime_ms: 1,
      state: "downloaded" as const,
    };
    const store = {
      entry: async () => entry,
      read: async () => new TextEncoder().encode("hello").buffer as ArrayBuffer,
      write: vi.fn(async () => entry),
      copy: vi.fn(async () => entry),
      watch: () => () => undefined,
    };
    const misty = await connect({ transport: server.transport, space: "sp_1", files: store });
    const room = misty.room.forFile("file-1");
    await room.ready;
    expect(room.text.toString()).toBe("hello");
    expect(room.writer).toBe(true);
    expect(room.file?.name).toBe("a.txt");
    expect(server.opens[0]!.request).toMatchObject({ key: "file-1", options: { file: "file-1" } });
    await vi.waitFor(() => expect(server.rooms.get("file-1")!.doc.getText("text").toString()).toBe("hello"));
    misty.close();
  });
});

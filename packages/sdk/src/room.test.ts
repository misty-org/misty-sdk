import { afterEach, describe, expect, it, vi } from "vitest";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { Connection } from "./connection.js";
import type { MistyError } from "./errors.js";
import type { Frame } from "./protocol.js";
import { openFileRoom, openRoom } from "./room.js";
import type { RoomHost } from "./room.js";

const me = { user_id: "ana", name: "Ana", tone: "blue" as const };
const plain: RoomHost = { syncs: false, me };
const syncing: RoomHost = { syncs: true, me };

const requests = (received: Frame[], method: string) =>
  received.filter(
    (frame): frame is Extract<Frame, { t: "req" }> => frame.t === "req" && frame.method === method,
  );

function pair() {
  const { port1, port2 } = new MessageChannel();
  const connection = new Connection(port1);
  const received: Frame[] = [];
  port2.onmessage = (event) => received.push(event.data as Frame);
  const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
  return { connection, host: port2, received, wait };
}

const answered = new WeakMap<Frame[], Set<number>>();

function reply(host: MessagePort, received: Frame[], method: string, result: unknown) {
  const done = answered.get(received) ?? new Set<number>();
  answered.set(received, done);
  for (const request of requests(received, method)) {
    if (done.has(request.id)) continue;
    done.add(request.id);
    host.postMessage({ t: "res", id: request.id, ok: true, result });
  }
}

const sketch = { id: "f1", name: "a.sketch", mime: "application/octet-stream", size: 0, updated_at: "" };

const subscription = (received: Frame[]) =>
  received.find((frame): frame is Extract<Frame, { t: "sub" }> => frame.t === "sub")!;

describe("openRoom", () => {
  it("asks the host to keep deleted content when the app does", async () => {
    const { connection, received, wait } = pair();
    const kept = openRoom(connection, "deck", { gc: false }, plain);
    const collected = openRoom(connection, "notes", {}, plain);
    await wait();
    const subs = received.filter((frame) => frame.t === "sub");
    expect(subs.map((frame) => (frame as { params: unknown }).params)).toEqual([
      { id: "deck", gc: false },
      { id: "notes" },
    ]);
    expect(kept.doc.gc).toBe(false);
    expect(collected.doc.gc).toBe(true);
    kept.destroy();
    collected.destroy();
    connection.close();
  });

  it("syncs, then says once when the host ends the room", async () => {
    const { connection, host, received, wait } = pair();
    const room = openRoom(connection, "deck", {}, plain);
    await wait();
    const { id } = subscription(received);
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "hi");
    host.postMessage({ t: "evt", id, data: { type: "sync", update: Y.encodeStateAsUpdate(remote) } });
    await room.synced;
    expect(room.doc.getText("t").toString()).toBe("hi");
    expect(room.lost).toBeNull();

    const heard: MistyError[] = [];
    room.onLost((error) => heard.push(error));
    host.postMessage({ t: "end", id, error: { code: "not_found", message: "The room was deleted." } });
    await wait();
    expect(heard.map((error) => error.code)).toEqual(["not_found"]);
    expect(room.lost?.code).toBe("not_found");

    const late: string[] = [];
    room.onLost((error) => late.push(error.code));
    expect(late).toEqual(["not_found"]);
    room.destroy();
    connection.close();
  });

  it("rejects `synced` when the room is lost before it syncs", async () => {
    const { connection, host, received, wait } = pair();
    const room = openRoom(connection, "deck", {}, plain);
    await wait();
    host.postMessage({
      t: "end",
      id: subscription(received).id,
      error: { code: "permission_denied", message: "no" },
    });
    await expect(room.synced).rejects.toMatchObject({ code: "permission_denied" });
    expect(room.lost?.code).toBe("permission_denied");
    room.destroy();
    connection.close();
  });

  it("is not lost when the app leaves it", async () => {
    const { connection, wait } = pair();
    const room = openRoom(connection, "deck", {}, plain);
    const heard: string[] = [];
    room.onLost((error) => heard.push(error.code));
    await wait();
    room.destroy();
    await expect(room.synced).rejects.toMatchObject({ code: "cancelled" });
    expect(heard).toEqual([]);
    expect(room.lost).toBeNull();
    connection.close();
  });

  it("keeps the room's own identity for this person and reads others' from Misty's field", async () => {
    const { connection, wait } = pair();
    const room = openRoom(connection, "deck", {}, plain);
    await wait();
    expect(room.identity(room.doc.clientID)).toEqual(me);
    expect(room.identity(12345)).toBeNull();
    room.destroy();
    connection.close();
  });

  it("syncs by state vector and resends what the host refused", async () => {
    const { connection, host, received, wait } = pair();
    const room = openRoom(connection, "deck", {}, syncing);
    await wait();
    expect(subscription(received).params).toEqual({ id: "deck", sync: true });
    const [first] = requests(received, "room.sync");
    const hostDoc = new Y.Doc();
    hostDoc.getText("t").insert(0, "hi");
    const answer = encoding.createEncoder();
    syncProtocol.readSyncMessage(
      decoding.createDecoder((first.params as { message: Uint8Array }).message),
      answer,
      hostDoc,
      null,
    );
    const step1 = encoding.createEncoder();
    syncProtocol.writeSyncStep1(step1, hostDoc);
    host.postMessage({
      t: "res",
      id: first.id,
      ok: true,
      result: { messages: [encoding.toUint8Array(answer), encoding.toUint8Array(step1)] },
    });
    await wait();
    const [, second] = requests(received, "room.sync");
    host.postMessage({ t: "res", id: second.id, ok: true, result: { messages: [] } });
    await room.synced;
    expect(room.doc.getText("t").toString()).toBe("hi");

    room.doc.getText("t").insert(2, "!");
    await wait();
    const [update] = requests(received, "room.update");
    host.postMessage({ t: "res", id: update.id, ok: false, error: { code: "internal", message: "dropped" } });
    await wait();
    expect(requests(received, "room.sync").length).toBe(2);
    await wait(600);
    expect(requests(received, "room.sync").length).toBeGreaterThan(2);
    room.destroy();
    connection.close();
  });

  it("refuses the same room twice on one connection", async () => {
    const { connection } = pair();
    const room = openRoom(connection, "deck", {}, plain);
    let refused: unknown;
    try {
      openRoom(connection, "deck", {}, plain);
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ code: "conflict" });
    room.destroy();
    const again = openRoom(connection, "deck", {}, plain);
    again.destroy();
    connection.close();
  });

  it("keeps others' presence while they're connected, with no timeout", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { connection, host, received, wait } = pair();
    const room = openRoom(connection, "deck", {}, plain);
    await wait();
    const other = new Awareness(new Y.Doc());
    other.setLocalState({ misty: { user_id: "sam", name: "Sam" }, cursor: 3 });
    host.postMessage({
      t: "evt",
      id: subscription(received).id,
      data: { type: "awareness", update: encodeAwarenessUpdate(other, [other.clientID]) },
    });
    await wait();
    expect(room.awareness.getStates().has(other.clientID)).toBe(true);
    const sent = requests(received, "room.awareness").length;
    vi.advanceTimersByTime(120_000);
    await wait();
    expect(room.awareness.getStates().has(other.clientID)).toBe(true);
    expect(requests(received, "room.awareness").length).toBe(sent);
    other.destroy();
    room.destroy();
    connection.close();
  });

  it("follows the host's link to the server and sends its presence again when it's back", async () => {
    const { connection, host, received, wait } = pair();
    const room = openRoom(connection, "deck", {}, syncing);
    await wait();
    const { id } = subscription(received);
    const heard: boolean[] = [];
    room.onConnection((connected) => heard.push(connected));
    room.awareness.setLocalStateField("cursor", 1);
    await wait();
    const before = requests(received, "room.awareness").length;
    host.postMessage({ t: "evt", id, data: { type: "connection", connected: false } });
    await wait();
    expect(room.connected).toBe(false);
    host.postMessage({ t: "evt", id, data: { type: "connection", connected: true } });
    await wait();
    expect(room.connected).toBe(true);
    expect(heard).toEqual([false, true]);
    expect(requests(received, "room.awareness").length).toBe(before + 1);
    room.destroy();
    connection.close();
  });

  it("tells the app about a problem without stopping the room", async () => {
    const { connection, host, received, wait } = pair();
    const room = openRoom(connection, "deck", {}, syncing);
    await wait();
    const heard: string[] = [];
    room.onError((error) => heard.push(error.code));
    host.postMessage({
      t: "evt",
      id: subscription(received).id,
      data: { type: "problem", code: "too_large", message: "This room is full." },
    });
    await wait();
    expect(heard).toEqual(["too_large"]);
    expect(room.lost).toBeNull();
    room.destroy();
    connection.close();
  });

  it("opens the room again after a passing failure, keeping the same document", async () => {
    const { connection, host, received, wait } = pair();
    const room = openRoom(connection, "deck", {}, syncing);
    await wait();
    const { id } = subscription(received);
    room.doc.getText("t").insert(0, "kept");
    const heard: string[] = [];
    room.onError((error) => heard.push(error.code));
    host.postMessage({ t: "end", id, error: { code: "internal", message: "offline" } });
    await wait();
    expect(room.lost).toBeNull();
    expect(room.connected).toBe(false);
    expect(heard).toContain("internal");
    await wait(600);
    const subs = received.filter((frame) => frame.t === "sub");
    expect(subs.length).toBe(2);
    expect(room.doc.getText("t").toString()).toBe("kept");
    reply(host, received, "room.sync", { messages: [] });
    await wait();
    expect(room.connected).toBe(true);
    room.destroy();
    connection.close();
  });

  it("opens a file room, learns whether it writes, and serializes when asked", async () => {
    const { connection, host, received, wait } = pair();
    const room = openFileRoom(
      connection,
      "f1",
      { load: () => {}, serialize: (doc) => doc.getText("t").toString() },
      syncing,
    );
    await wait();
    const { id } = subscription(received);
    expect(subscription(received).params).toEqual({ file: "f1", sync: true });
    reply(host, received, "room.sync", { messages: [] });
    const writes: boolean[] = [];
    room.onWriter((writer) => writes.push(writer));
    host.postMessage({ t: "evt", id, data: { type: "file", file: sketch, format: "app", writer: true, loaded: true } });
    await room.ready;
    expect(room.writer).toBe(true);
    expect(room.format).toBe("app");
    expect(room.loaded).toBe(true);
    expect(writes).toEqual([true]);
    host.postMessage({ t: "evt", id, data: { type: "serialize", request: 7 } });
    await wait();
    const [serialized] = requests(received, "room.serialized");
    expect(serialized.params).toMatchObject({ id: "file/f1", request: 7 });
    room.destroy();
    connection.close();
  });

  it("is ready only once the file's content is in the room", async () => {
    const { connection, host, received, wait } = pair();
    const room = openFileRoom(connection, "f1", {}, syncing);
    await wait();
    const { id } = subscription(received);
    reply(host, received, "room.sync", { messages: [] });
    let ready = false;
    void room.ready.then(() => {
      ready = true;
    });
    const text = { ...sketch, name: "a.md", mime: "text/markdown" };
    host.postMessage({ t: "evt", id, data: { type: "file", file: text, format: "text", writer: false, loaded: false } });
    await wait();
    expect(ready).toBe(false);
    expect(room.loaded).toBe(false);
    host.postMessage({ t: "evt", id, data: { type: "file", file: text, format: "text", writer: false, loaded: true } });
    await wait();
    expect(ready).toBe(true);
    room.destroy();
    connection.close();
  });

  it("says when nobody who can edit the file has it open", async () => {
    const { connection, host, received, wait } = pair();
    const room = openFileRoom(connection, "f1", {}, syncing);
    await wait();
    reply(host, received, "room.sync", { messages: [] });
    host.postMessage({
      t: "evt",
      id: subscription(received).id,
      data: { type: "file", file: sketch, format: "text", writer: false, loaded: false, editable: false },
    });
    await expect(room.ready).rejects.toMatchObject({ code: "read_only" });
    expect(room.editable).toBe(false);
    room.destroy();
    connection.close();
  });

  it("waits for an editor's load instead of saying read only while someone who can edit holds the file", async () => {
    const { connection, host, received, wait } = pair();
    const room = openFileRoom(connection, "f1", {}, syncing);
    await wait();
    reply(host, received, "room.sync", { messages: [] });
    const { id } = subscription(received);
    let settled: string | null = null;
    room.ready.then(
      () => {
        settled = "ready";
      },
      (error: { code: string }) => {
        settled = error.code;
      },
    );
    const file = { type: "file", file: sketch, format: "text", writer: false, editable: false };
    host.postMessage({ t: "evt", id, data: { ...file, loaded: false, has_writer: true } });
    await wait();
    expect(settled).toBeNull();
    host.postMessage({ t: "evt", id, data: { ...file, loaded: true, has_writer: true } });
    await wait();
    expect(settled).toBe("ready");
    room.destroy();
    connection.close();
  });

  it("says read only once the editor who held the file has gone", async () => {
    const { connection, host, received, wait } = pair();
    const room = openFileRoom(connection, "f1", {}, syncing);
    await wait();
    reply(host, received, "room.sync", { messages: [] });
    const { id } = subscription(received);
    const file = { type: "file", file: sketch, format: "text", writer: false, editable: false, loaded: false };
    host.postMessage({ t: "evt", id, data: { ...file, has_writer: true } });
    await wait();
    host.postMessage({ t: "evt", id, data: { ...file, has_writer: false } });
    await expect(room.ready).rejects.toMatchObject({ code: "read_only" });
    room.destroy();
    connection.close();
  });

  it("stops at once when an app file is opened without load and serialize", async () => {
    const { connection, host, received, wait } = pair();
    const room = openFileRoom(connection, "f1", {}, syncing);
    await wait();
    host.postMessage({
      t: "evt",
      id: subscription(received).id,
      data: { type: "file", file: sketch, format: "app", writer: true },
    });
    await expect(room.ready).rejects.toMatchObject({ code: "unsupported" });
    expect(room.lost?.code).toBe("unsupported");
    room.destroy();
    connection.close();
  });

  it("loads once, in one change with its loaded mark", async () => {
    const { connection, host, received, wait } = pair();
    let calls = 0;
    let finish!: () => void;
    const room = openFileRoom(
      connection,
      "f1",
      {
        load: async (data, doc) => {
          calls += 1;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          doc.getText("t").insert(0, new TextDecoder().decode(data));
        },
        serialize: (doc) => doc.getText("t").toString(),
      },
      syncing,
    );
    await wait();
    const { id } = subscription(received);
    reply(host, received, "room.sync", { messages: [] });
    host.postMessage({ t: "evt", id, data: { type: "file", file: sketch, format: "app", writer: true, loaded: false } });
    const bytes = new TextEncoder().encode("scene").buffer;
    host.postMessage({ t: "evt", id, data: { type: "load", request: 1, version: 3, data: bytes } });
    host.postMessage({ t: "evt", id, data: { type: "load", request: 2, version: 3, data: bytes } });
    await wait();
    expect(calls).toBe(1);
    const updatesBefore = requests(received, "room.update").length;
    finish();
    await room.ready;
    expect(room.doc.getText("t").toString()).toBe("scene");
    expect(room.doc.getMap("misty:file").get("loaded")).toBe(3);
    await wait();
    expect(requests(received, "room.update").length).toBe(updatesBefore + 1);
    room.destroy();
    connection.close();
  });

  it("doesn't put a load into the room once it's no longer the writer", async () => {
    const { connection, host, received, wait } = pair();
    let finish!: () => void;
    const room = openFileRoom(
      connection,
      "f1",
      {
        load: async (data, doc) => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          doc.getText("t").insert(0, new TextDecoder().decode(data));
        },
        serialize: (doc) => doc.getText("t").toString(),
      },
      syncing,
    );
    await wait();
    const { id } = subscription(received);
    reply(host, received, "room.sync", { messages: [] });
    host.postMessage({ t: "evt", id, data: { type: "file", file: sketch, format: "app", writer: true, loaded: false } });
    host.postMessage({
      t: "evt",
      id,
      data: { type: "load", request: 1, version: 3, data: new TextEncoder().encode("scene").buffer },
    });
    await wait();
    host.postMessage({ t: "evt", id, data: { type: "file", file: sketch, format: "app", writer: false, loaded: false } });
    await wait();
    const updatesBefore = requests(received, "room.update").length;
    finish();
    await wait();
    expect(room.doc.getText("t").toString()).toBe("");
    expect(room.doc.getMap("misty:file").get("loaded")).toBeUndefined();
    expect(requests(received, "room.update").length).toBe(updatesBefore);
    room.destroy();
    connection.close();
  });

  it("rejects `ready` once the app has failed to load the file twice", async () => {
    const { connection, host, received, wait } = pair();
    let calls = 0;
    const room = openFileRoom(
      connection,
      "f1",
      {
        load: () => {
          calls += 1;
          throw new Error("Not a sketch");
        },
        serialize: (doc) => doc.getText("t").toString(),
      },
      syncing,
    );
    await wait();
    const { id } = subscription(received);
    reply(host, received, "room.sync", { messages: [] });
    const heard: string[] = [];
    room.onError((error) => heard.push(error.code));
    host.postMessage({ t: "evt", id, data: { type: "file", file: sketch, format: "app", writer: true, loaded: false } });
    const bytes = new TextEncoder().encode("scene").buffer;
    host.postMessage({ t: "evt", id, data: { type: "load", request: 1, version: 3, data: bytes } });
    await wait();
    host.postMessage({ t: "evt", id, data: { type: "load", request: 2, version: 3, data: bytes } });
    await expect(room.ready).rejects.toMatchObject({ code: "internal" });
    expect(calls).toBe(2);
    expect(heard).toEqual(["internal", "internal"]);
    room.destroy();
    connection.close();
  });

  it("keeps the room when a save fails", async () => {
    const { connection, host, received, wait } = pair();
    const room = openFileRoom(
      connection,
      "f1",
      { load: () => {}, serialize: (doc) => doc.getText("t").toString() },
      syncing,
    );
    await wait();
    const { id } = subscription(received);
    reply(host, received, "room.sync", { messages: [] });
    host.postMessage({ t: "evt", id, data: { type: "file", file: sketch, format: "app", writer: true, loaded: true } });
    await room.ready;
    const heard: string[] = [];
    room.onError((error) => heard.push(error.code));
    host.postMessage({ t: "evt", id, data: { type: "serialize", request: 9 } });
    await wait();
    const [serialized] = requests(received, "room.serialized");
    host.postMessage({
      t: "res",
      id: serialized.id,
      ok: false,
      error: { code: "permission_denied", message: "Not allowed" },
    });
    await wait();
    expect(heard).toEqual(["permission_denied"]);
    expect(room.lost).toBeNull();
    room.destroy();
    connection.close();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

import { describe, expect, it } from "vitest";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
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
  const wait = () => new Promise((resolve) => setTimeout(resolve, 25));
  return { connection, host: port2, received, wait };
}

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
    const reply = encoding.createEncoder();
    syncProtocol.readSyncMessage(
      decoding.createDecoder((first.params as { message: Uint8Array }).message),
      reply,
      hostDoc,
      null,
    );
    const step1 = encoding.createEncoder();
    syncProtocol.writeSyncStep1(step1, hostDoc);
    host.postMessage({
      t: "res",
      id: first.id,
      ok: true,
      result: { messages: [encoding.toUint8Array(reply), encoding.toUint8Array(step1)] },
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
    expect(requests(received, "room.sync").length).toBeGreaterThan(2);
    room.destroy();
    connection.close();
  });

  it("opens a file room, learns whether it writes, and serializes when asked", async () => {
    const { connection, host, received, wait } = pair();
    const room = openFileRoom(connection, "f1", { serialize: (doc) => doc.getText("t").toString() }, syncing);
    await wait();
    const { id } = subscription(received);
    expect(subscription(received).params).toEqual({ file: "f1", sync: true });
    const writes: boolean[] = [];
    room.onWriter((writer) => writes.push(writer));
    host.postMessage({
      t: "evt",
      id,
      data: {
        type: "file",
        file: { id: "f1", name: "a.sketch", mime: "application/octet-stream", size: 0, updated_at: "" },
        format: "app",
        writer: true,
      },
    });
    await wait();
    expect(room.writer).toBe(true);
    expect(room.format).toBe("app");
    expect(writes).toEqual([true]);
    host.postMessage({ t: "evt", id, data: { type: "serialize", request: 7 } });
    await wait();
    const [serialized] = requests(received, "room.serialized");
    expect(serialized.params).toMatchObject({ id: "file/f1", request: 7 });
    room.destroy();
    connection.close();
  });
});

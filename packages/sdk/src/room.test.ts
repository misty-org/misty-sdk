import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Connection } from "./connection.js";
import type { MistyError } from "./errors.js";
import type { Frame } from "./protocol.js";
import { openRoom } from "./room.js";

/** A host end that answers frames by hand, over a real MessageChannel. */
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
    const kept = openRoom(connection, "deck", { gc: false });
    const collected = openRoom(connection, "notes");
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
    const room = openRoom(connection, "deck");
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

    // A listener added after the loss hears it at once.
    const late: string[] = [];
    room.onLost((error) => late.push(error.code));
    expect(late).toEqual(["not_found"]);
    room.destroy();
    connection.close();
  });

  it("rejects `synced` when the room is lost before it syncs", async () => {
    const { connection, host, received, wait } = pair();
    const room = openRoom(connection, "deck");
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
    const room = openRoom(connection, "deck");
    const heard: string[] = [];
    room.onLost((error) => heard.push(error.code));
    await wait();
    room.destroy();
    await expect(room.synced).rejects.toMatchObject({ code: "cancelled" });
    expect(heard).toEqual([]);
    expect(room.lost).toBeNull();
    connection.close();
  });
});

import { describe, expect, it } from "vitest";
import { Connection } from "./connection.js";
import { MistyError } from "./errors.js";
import type { Frame } from "./protocol.js";

function pair(timeoutMs?: number) {
  const { port1, port2 } = new MessageChannel();
  const connection = new Connection(port1, { timeoutMs });
  const received: Frame[] = [];
  port2.onmessage = (event) => received.push(event.data as Frame);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 25));
  return { connection, host: port2, received, wait };
}

describe("Connection", () => {
  it("resolves a call with the host's result", async () => {
    const { connection, host, received, wait } = pair();
    const call = connection.call("members.list");
    await wait();
    const req = received[0];
    expect(req).toMatchObject({ t: "req", method: "members.list" });
    host.postMessage({ t: "res", id: (req as { id: number }).id, ok: true, result: [] });
    await expect(call).resolves.toEqual([]);
    connection.close();
  });

  it("rejects a call with the host's error code", async () => {
    const { connection, host, received, wait } = pair();
    const call = connection.call("files.list");
    await wait();
    host.postMessage({
      t: "res",
      id: (received[0] as { id: number }).id,
      ok: false,
      error: { code: "permission_denied", message: "no" },
    });
    await expect(call).rejects.toMatchObject({ code: "permission_denied" });
    connection.close();
  });

  it("delivers subscription events until unsubscribed", async () => {
    const { connection, host, received, wait } = pair();
    const seen: unknown[] = [];
    const stop = connection.subscribe("members.presence", undefined, (data) => seen.push(data));
    await wait();
    const id = (received[0] as { id: number }).id;
    host.postMessage({ t: "evt", id, data: [] });
    await wait();
    stop();
    await wait();
    host.postMessage({ t: "evt", id, data: [{ agent_id: "x" }] });
    await wait();
    expect(seen).toEqual([[]]);
    expect(received[1]).toMatchObject({ t: "unsub", id });
    connection.close();
  });

  it("fails pending calls and ends subscriptions when closed", async () => {
    const { connection, wait } = pair();
    const ended: Array<MistyError | undefined> = [];
    connection.subscribe("theme", undefined, () => {}, (error) => ended.push(error));
    const call = connection.call("sources.list");
    await wait();
    connection.close();
    await expect(call).rejects.toMatchObject({ code: "closed" });
    expect(ended[0]).toMatchObject({ code: "closed" });
    await expect(connection.call("sources.list")).rejects.toMatchObject({ code: "closed" });
  });

  it("fails a call Misty doesn't answer in time", async () => {
    const { connection } = pair(20);
    await expect(connection.call("members.list")).rejects.toMatchObject({ code: "internal" });
    connection.close();
  });

  it("stops its subscriptions with Misty when it closes", async () => {
    const { connection, received, wait } = pair();
    connection.subscribe("theme", undefined, () => {});
    await wait();
    const id = (received[0] as { id: number }).id;
    connection.close();
    await wait();
    expect(received[1]).toMatchObject({ t: "unsub", id });
  });

  it("moves to a new port when Misty restarts, then subscribes again and sends what waited", async () => {
    const { connection, received, wait } = pair();
    const seen: unknown[] = [];
    connection.subscribe("theme", undefined, (theme) => seen.push(theme));
    const lost = connection.call("members.list");
    await wait();
    const { port1, port2 } = new MessageChannel();
    const next: Frame[] = [];
    port2.onmessage = (event) => next.push(event.data as Frame);
    const resets: number[] = [];
    connection.onReset(() => resets.push(1));
    connection.replace(port1);
    await expect(lost).rejects.toMatchObject({ code: "internal" });
    const waiting = connection.call("members.list");
    const hello = connection.call("hello", { sdk: "test", protocol: 1 });
    await wait();
    expect(next.map((frame) => frame.t === "req" && frame.method)).toEqual(["hello"]);
    port2.postMessage({ t: "res", id: (next[0] as { id: number }).id, ok: true, result: {} });
    await hello;
    connection.resume();
    await wait();
    expect(next.slice(1)).toMatchObject([
      { t: "sub", topic: "theme", id: (received[0] as { id: number }).id },
      { t: "req", method: "members.list" },
    ]);
    expect(resets).toEqual([1]);
    port2.postMessage({ t: "res", id: (next[2] as { id: number }).id, ok: true, result: [] });
    await expect(waiting).resolves.toEqual([]);
    connection.close();
  });

  it("passes MCP messages both ways", async () => {
    const { connection, host, received, wait } = pair();
    const seen: unknown[] = [];
    connection.onMcp((message) => seen.push(message));
    connection.sendMcp({ jsonrpc: "2.0", id: 1, method: "ping" });
    host.postMessage({ t: "mcp", message: { jsonrpc: "2.0", id: 1, result: {} } });
    await wait();
    expect(received[0]).toMatchObject({ t: "mcp" });
    expect(seen).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    connection.close();
  });
});

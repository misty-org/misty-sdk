import { describe, expect, it, vi } from "vitest";
import { toBase64 } from "./base64.js";
import { requestTransport } from "./transport_request.js";
import { streamTransport } from "./transport_stream.js";
import type { TransportEvents } from "./transport.js";

const token = async () => "tok";

function eventStream() {
  let push!: (text: string) => void;
  let end!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      push = (text) => controller.enqueue(encoder.encode(text));
      end = () => controller.close();
    },
  });
  return { body, push: (text: string) => push(text), end: () => end() };
}

function recorder() {
  const seen: unknown[] = [];
  const events: TransportEvents = {
    opened: (opened) => seen.push(["opened", opened.room, opened.conn]),
    binary: (frame) => seen.push(["binary", [...frame]]),
    text: (message) => seen.push(["text", message]),
    closed: (code, reason) => seen.push(["closed", code, reason]),
  };
  return { seen, events };
}

describe("the stream transport", () => {
  it("opens with the open message, reads events, and posts frames in order with the sign-in", async () => {
    const stream = eventStream();
    const posts: { url: string; type: string | null; body: unknown; auth: string | null }[] = [];
    const run = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (String(url).endsWith("/v1/collab/stream"))
        return new Response(stream.body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      posts.push({ url: String(url), type: headers.get("Content-Type"), body: init?.body, auth: headers.get("Authorization") });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const { seen, events } = recorder();
    const connection = streamTransport({ url: "https://api.example.com/v1", token, fetch: run }).open(
      { space: "sp_1", key: "board", options: { history: true } },
      events,
    );
    await vi.waitFor(() => expect(vi.mocked(run).mock.calls.length).toBeGreaterThan(0));
    const [, init] = vi.mocked(run).mock.calls[0]!;
    expect(JSON.parse(String(init!.body))).toMatchObject({ type: "open", v: 1, space: "sp_1", key: "board", options: { history: true } });
    expect(JSON.parse(String(init!.body)).token).toBeUndefined();
    expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer tok");
    stream.push(': keep\n\nevent: opened\ndata: {"type":"opened","room":"rm_1","role":"edit","options":{},"seats":40,"max_bytes":8,"identity":{"kind":"person","id":"a","name":"A"},"conn":"c1"}\n\n');
    stream.push(`event: b\ndata: ${toBase64(new Uint8Array([0, 1, 2]))}\n\nevent: t\ndata: {"type":"error","code":"read_only"}\r\n\r\n`);
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    connection.sendBinary(new Uint8Array([9]));
    connection.sendText({ option: "history", type: "list", request: 1 });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.map((post) => [post.url, post.type, post.auth])).toEqual([
      ["https://api.example.com/v1/collab/stream/c1", "application/octet-stream", "Bearer tok"],
      ["https://api.example.com/v1/collab/stream/c1", "application/json", "Bearer tok"],
    ]);
    stream.push('event: close\ndata: {"code":4012,"reason":"access_changed"}\n\n');
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["closed", 4012, "access_changed"]));
    expect(seen.slice(0, 3)).toEqual([
      ["opened", "rm_1", "c1"],
      ["binary", [0, 1, 2]],
      ["text", { type: "error", code: "read_only" }],
    ]);
  });

  it("turns a refused open into its close code", async () => {
    const run = (async () => new Response(JSON.stringify({ code: "options_conflict" }), { status: 409 })) as typeof fetch;
    const { seen, events } = recorder();
    streamTransport({ url: "https://api.example.com", token, fetch: run }).open({ space: "s", key: "k", options: {} }, events);
    await vi.waitFor(() => expect(seen).toEqual([["closed", 4006, ""]]));
  });

  it("follows a redirect to the room's owner and keeps posting there", async () => {
    const stream = eventStream();
    const urls: string[] = [];
    const run = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url) === "https://api.example.com/v1/collab/stream")
        return new Response(null, { status: 307, headers: { Location: "https://owner.example.com/v1/collab/stream" } });
      if (String(url).endsWith("/v1/collab/stream")) {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
        return new Response(stream.body, { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const { seen, events } = recorder();
    const connection = streamTransport({ url: "https://api.example.com", token, fetch: run }).open(
      { space: "s", key: "k", options: {} },
      events,
    );
    stream.push('event: opened\ndata: {"room":"rm_1","conn":"c9"}\n\n');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    connection.sendBinary(new Uint8Array([1]));
    await vi.waitFor(() => expect(urls.at(-1)).toBe("https://owner.example.com/v1/collab/stream/c9"));
    connection.close();
  });
});

describe("the request transport", () => {
  it("reads a room as an update or JSON, says when it was never opened, and writes with options", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const run = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body });
      const at = String(url);
      if (at.includes("missing")) return new Response(null, { status: 404 });
      if (at.endsWith("as=json")) return new Response(JSON.stringify({ title: "Q4" }), { status: 200 });
      if (init?.method === "POST") return new Response(null, { status: 204 });
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    }) as typeof fetch;
    const request = requestTransport({ url: "https://api.example.com/v1", token, fetch: run });
    expect([...((await request.read({ space: "sp 1", key: "a/b", as: "update" })) as Uint8Array)]).toEqual([1, 2]);
    expect(calls[0]!.url).toBe("https://api.example.com/v1/collab/rooms/sp%201/a%2Fb?as=update");
    expect(await request.read({ space: "s", key: "k", as: "json" })).toEqual({ title: "Q4" });
    expect(await request.read({ space: "s", key: "missing", as: "update" })).toBeNull();
    await request.write({ space: "s", key: "k", update: new Uint8Array([3]), options: { history: true } });
    expect(calls.at(-1)!.url).toBe(
      `https://api.example.com/v1/collab/rooms/s/k?options=${encodeURIComponent('{"history":true}')}`,
    );
    const refusing = requestTransport({
      url: "https://api.example.com",
      token,
      fetch: (async () => new Response(null, { status: 403 })) as typeof fetch,
    });
    await expect(refusing.write({ space: "s", key: "k", update: new Uint8Array() })).rejects.toMatchObject({
      code: "permission_denied",
    });
  });
});

import { MistyError } from "./errors.js";
import type { RoomOpened, RoomWireOptions } from "./protocol.js";
import { SDK_CLIENT } from "./version.js";

export type TokenSource = (options?: { fresh?: boolean }) => Promise<string>;

export interface OpenRequest {
  space: string;
  key: string;
  options: RoomWireOptions;
  url?: string;
  fresh?: boolean;
}

export interface TransportEvents {
  opened(opened: RoomOpened): void;
  binary(frame: Uint8Array): void;
  text(message: Record<string, unknown>): void;
  closed(code: number, reason: string): void;
}

export interface TransportConnection {
  sendBinary(frame: Uint8Array): void;
  sendText(message: Record<string, unknown>): void;
  close(): void;
}

export interface ReadRequest {
  space: string;
  key: string;
  as: "update" | "json";
}

export interface WriteRequest {
  space: string;
  key: string;
  update: Uint8Array;
  options?: RoomWireOptions;
}

export interface RequestTransport {
  read(request: ReadRequest): Promise<Uint8Array | Record<string, unknown> | null>;
  write(request: WriteRequest): Promise<void>;
}

export interface Transport {
  open(request: OpenRequest, events: TransportEvents): TransportConnection;
  request?: RequestTransport;
}

export const CLOSE_CODES = {
  normal: 1000,
  internal: 1011,
  bad_open: 4000,
  unauthorized: 4001,
  forbidden: 4003,
  not_found: 4004,
  bad_frame: 4005,
  options_conflict: 4006,
  too_large: 4008,
  full: 4009,
  moved: 4010,
  gone: 4011,
  access_changed: 4012,
  signed_out: 4013,
  reauth: 4014,
} as const;

export type CloseName = keyof typeof CLOSE_CODES;

export const LOST_LINK = 1006;

export const FINAL_CLOSES: ReadonlySet<number> = new Set([
  CLOSE_CODES.unauthorized,
  CLOSE_CODES.forbidden,
  CLOSE_CODES.not_found,
  CLOSE_CODES.options_conflict,
  CLOSE_CODES.gone,
  CLOSE_CODES.access_changed,
  CLOSE_CODES.signed_out,
]);

export function closeCodeOf(name: unknown): number | undefined {
  return typeof name === "string" && name in CLOSE_CODES ? CLOSE_CODES[name as CloseName] : undefined;
}

export function closeError(code: number): MistyError {
  switch (code) {
    case CLOSE_CODES.unauthorized:
      return new MistyError("permission_denied", "The server didn't accept this sign-in for the room.");
    case CLOSE_CODES.forbidden:
      return new MistyError("permission_denied", "You don't have access to this room.");
    case CLOSE_CODES.not_found:
      return new MistyError("not_found", "This room's Space or file doesn't exist.");
    case CLOSE_CODES.options_conflict:
      return new MistyError("conflict", "This room was first opened with other options.");
    case CLOSE_CODES.gone:
      return new MistyError("not_found", "The room was deleted.");
    case CLOSE_CODES.access_changed:
      return new MistyError("permission_denied", "You no longer have access to this room.");
    case CLOSE_CODES.signed_out:
      return new MistyError("permission_denied", "This sign-in was signed out, so the room closed.");
    default:
      return new MistyError("internal", "The room's connection closed.");
  }
}

export function statusClose(status: number, code?: unknown): number {
  const named = closeCodeOf(code);
  if (named !== undefined) return named;
  if (status === 400) return CLOSE_CODES.bad_open;
  if (status === 401) return CLOSE_CODES.unauthorized;
  if (status === 403) return CLOSE_CODES.forbidden;
  if (status === 404) return CLOSE_CODES.not_found;
  if (status === 409) return CLOSE_CODES.options_conflict;
  if (status === 410) return CLOSE_CODES.gone;
  if (status === 413) return CLOSE_CODES.too_large;
  return CLOSE_CODES.internal;
}

export function statusError(status: number, what: string): MistyError {
  if (status === 401) return new MistyError("permission_denied", `The server didn't accept this sign-in for ${what}.`);
  if (status === 403) return new MistyError("permission_denied", `You don't have access to ${what}.`);
  if (status === 404) return new MistyError("not_found", `The server couldn't find ${what}.`);
  if (status === 409) return new MistyError("conflict", `The server refused the change to ${what} because it changed first.`);
  if (status === 413) return new MistyError("too_large", `The server refused ${what} for being too large.`);
  return new MistyError("internal", `The server couldn't answer for ${what} (${status}).`);
}

const trimmed = (url: string) => url.trim().replace(/\/+$/, "");

export function roomOrigin(url: string): string {
  const parsed = new URL(trimmed(url));
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1(\/collab.*)?$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

export function httpBase(url: string): string {
  return roomOrigin(url).replace(/^ws(s?):/, "http$1:");
}

export function socketBase(url: string): string {
  return roomOrigin(url).replace(/^http(s?):/, "ws$1:");
}

export function openMessage(request: OpenRequest, token?: string): Record<string, unknown> {
  return {
    type: "open",
    v: 1,
    space: request.space,
    key: request.key,
    options: request.options,
    ...(token === undefined ? {} : { token }),
    client: SDK_CLIENT,
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readOpened(value: unknown): RoomOpened | null {
  if (!isObject(value) || typeof value.room !== "string") return null;
  const identity = isObject(value.identity) ? value.identity : {};
  const options = isObject(value.options) ? value.options : {};
  return {
    type: "opened",
    room: value.room,
    role: value.role === "view" ? "view" : "edit",
    options: {
      ...(typeof options.file === "string" ? { file: options.file } : {}),
      ...(typeof options.text === "string" || options.text === null ? { text: options.text } : {}),
      ...(typeof options.history === "boolean" ? { history: options.history } : {}),
      ...(typeof options.gc === "boolean" ? { gc: options.gc } : {}),
    },
    seats: typeof value.seats === "number" ? value.seats : 0,
    max_bytes: typeof value.max_bytes === "number" ? value.max_bytes : 0,
    identity: {
      kind: identity.kind === "integration" ? "integration" : "person",
      id: typeof identity.id === "string" ? identity.id : "",
      name: typeof identity.name === "string" ? identity.name : "",
    },
    ...(typeof value.conn === "string" ? { conn: value.conn } : {}),
  };
}

export function readJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 4;

export async function fetchFollowing(
  run: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ response: Response; url: string }> {
  let at = url;
  for (let hop = 0; ; hop += 1) {
    const response = await run(at, { ...init, redirect: "manual" });
    if (response.type === "opaqueredirect") {
      return { response: await run(at, { ...init, redirect: "follow" }), url: at };
    }
    const location = response.headers.get("location");
    if (!REDIRECTS.has(response.status) || !location || hop >= MAX_REDIRECTS) return { response, url: at };
    await response.body?.cancel().catch(() => undefined);
    at = new URL(location, at).toString();
  }
}

export interface ServerSentEvent {
  event: string;
  data: string;
}

export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ServerSentEvent) => boolean | void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  const line = (text: string): boolean => {
    if (text === "") {
      if (data.length === 0 && event === "") return false;
      const done = onEvent({ event: event || "message", data: data.join("\n") }) === true;
      event = "";
      data = [];
      return done;
    }
    if (text.startsWith(":")) return false;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return false;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.search(/\r\n|\r|\n/); end >= 0; end = buffer.search(/\r\n|\r|\n/)) {
        if (buffer[end] === "\r" && end === buffer.length - 1) break;
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));
        if (line(text)) return;
      }
    }
    buffer += decoder.decode();
    if (buffer) line(buffer);
    line("");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

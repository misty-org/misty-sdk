import type {
  AppContext,
  CallState,
  Card,
  ChatTarget,
  FileChange,
  FilePage,
  FileRef,
  ListFilesOptions,
  Member,
  Mentionable,
  PickOptions,
  Presence,
  Route,
  SaveOptions,
  Span,
  Theme,
  UploadOptions,
  VoiceChannel,
} from "./types.js";

/** Bumped when a frame or a call changes in a way an older app can't follow. */
export const PROTOCOL_VERSION = 1;

/** The one `window.postMessage` the host sends a new frame; its `ports[0]` is the SDK channel. */
export const INIT_MESSAGE = "misty:init";

export interface InitMessage {
  type: typeof INIT_MESSAGE;
  version: number;
}

/** Everything that crosses the channel is one of these frames. */
export type Frame =
  | { t: "req"; id: number; method: string; params?: unknown }
  | { t: "res"; id: number; ok: true; result?: unknown }
  | { t: "res"; id: number; ok: false; error: WireError }
  | { t: "sub"; id: number; topic: string; params?: unknown }
  | { t: "unsub"; id: number }
  | { t: "evt"; id: number; data: unknown }
  /** The host ended a subscription, with an error when it failed. */
  | { t: "end"; id: number; error?: WireError }
  /** One JSON-RPC message of the app's MCP stream (`mcp: frame`). */
  | { t: "mcp"; message: unknown };

export type ErrorCode =
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "invalid"
  | "unsupported"
  | "cancelled"
  | "closed"
  | "internal";

export interface WireError {
  code: ErrorCode;
  message: string;
}

export interface Hello {
  sdk: string;
  protocol: number;
}

/** One-shot calls: `[params, result]` for each method. */
export interface Methods {
  hello: [Hello, AppContext];
  "members.list": [void, Member[]];
  "members.mentionables": [{ query: string }, Mentionable[]];
  "chat.post": [{ target: ChatTarget; spans: Span[]; card?: Card }, { message_id: string }];
  "chat.open": [ChatTarget, void];
  "chat.notify": [{ user_id: string; text: string; route?: Route }, void];
  "files.pick": [PickOptions | void, FileRef[]];
  "files.open": [{ file_id: string; app_id?: string }, void];
  "files.save": [SaveOptions, FileRef];
  "files.list": [ListFilesOptions | void, FilePage];
  "files.upload": [UploadOptions, FileRef];
  "files.download": [{ file_id: string }, { file: FileRef; data: ArrayBuffer }];
  "route.navigate": [{ route: Route; replace?: boolean }, void];
  "room.update": [{ id: string; update: Uint8Array }, void];
  "room.awareness": [{ id: string; update: Uint8Array }, void];
  "calls.join": [{ channel_id: string }, void];
  "calls.leave": [void, void];
  "calls.mute": [{ muted: boolean }, void];
}

export type RoomEvent = { type: "sync"; update: Uint8Array } | { type: "awareness"; update: Uint8Array };

/** Subscriptions: `[params, event]` for each topic. The host sends the current value first. */
export interface Topics {
  theme: [void, Theme];
  route: [void, Route];
  "members.presence": [void, Presence[]];
  "files.watch": [{ folder?: string; accept?: string[] } | void, FileChange];
  room: [{ id: string; gc?: boolean }, RoomEvent];
  "calls.channels": [void, VoiceChannel[]];
  "calls.current": [void, CallState];
}

export type MethodName = keyof Methods;
export type TopicName = keyof Topics;

export const isFrame = (value: unknown): value is Frame =>
  typeof value === "object" && value !== null && typeof (value as { t?: unknown }).t === "string";

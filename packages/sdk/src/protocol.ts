import type {
  AgentControl,
  AppContext,
  CallState,
  Card,
  ChatTarget,
  FileChange,
  FileFormat,
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

export const PROTOCOL_VERSION = 1;

export const PROTOCOL_VERSIONS: readonly number[] = [1];

export const INIT_MESSAGE = "misty:init";

export interface InitMessage {
  type: typeof INIT_MESSAGE;
  version: number;
  versions?: number[];
}

export type Frame =
  | { t: "req"; id: number; method: string; params?: unknown }
  | { t: "res"; id: number; ok: true; result?: unknown }
  | { t: "res"; id: number; ok: false; error: WireError }
  | { t: "sub"; id: number; topic: string; params?: unknown }
  | { t: "unsub"; id: number }
  | { t: "evt"; id: number; data: unknown }
  | { t: "end"; id: number; error?: WireError }
  | { t: "mcp"; message: unknown };

export type ErrorCode =
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "invalid"
  | "unsupported"
  | "cancelled"
  | "closed"
  | "internal"
  | RoomProblemCode;

export type RoomProblemCode =
  | "too_large"
  | "too_large_warning"
  | "stalled"
  | "read_only"
  | "save_failed"
  | "reloaded";

export interface WireError {
  code: ErrorCode;
  message: string;
}

export interface Hello {
  sdk: string;
  protocol: number;
  versions?: number[];
}

export interface Offers {
  calls: string[];
  topics: string[];
}

export interface HelloResult extends AppContext {
  protocol?: number;
  versions?: number[];
  offers?: Offers;
}

export interface RoomParamOptions {
  key?: string;
  text?: string | null;
  history?: boolean;
}

export type RoomParams =
  | { id: string; gc?: boolean; sync?: boolean; options?: RoomParamOptions }
  | { file: string; gc?: boolean; sync?: boolean; options?: RoomParamOptions };

export interface RoomWireOptions {
  file?: string;
  text?: string | null;
  history?: boolean;
  gc?: boolean;
}

export interface RoomPerson {
  kind: "person" | "integration";
  id: string;
  name: string;
}

export interface RoomOpened {
  type?: "opened";
  room: string;
  role: "edit" | "view";
  options: RoomWireOptions;
  seats: number;
  max_bytes: number;
  identity: RoomPerson;
  conn?: string;
}

export type FrameEvent =
  | { type: "opened"; conn: string; opened: RoomOpened }
  | { type: "binary"; frame: Uint8Array }
  | { type: "text"; message: Record<string, unknown> }
  | { type: "closed"; code: number; reason: string };

export interface Methods {
  hello: [Hello, HelloResult];
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
  "room.sync": [{ id: string; message: Uint8Array }, { messages: Uint8Array[] }];
  "room.serialized": [{ id: string; request: number; data?: Uint8Array; error?: string }, void];
  "room.option": [{ id: string; message: Record<string, unknown> }, void];
  "room.frame": [{ conn: string; frame?: Uint8Array; message?: Record<string, unknown> }, void];
  "room.read": [{ key: string; as?: "update" | "json" }, { update?: Uint8Array; json?: Record<string, unknown> } | null];
  "room.change": [{ key: string; update: Uint8Array; options?: RoomWireOptions }, void];
  "calls.join": [{ channel_id: string }, void];
  "calls.leave": [void, void];
  "calls.mute": [{ muted: boolean }, void];
}

export type RoomEvent =
  | { type: "sync"; update: Uint8Array }
  | { type: "awareness"; update: Uint8Array }
  | { type: "message"; message: Uint8Array }
  | {
      type: "file";
      file: FileRef;
      format: FileFormat;
      writer: boolean;
      loaded?: boolean;
      editable?: boolean;
      has_writer?: boolean;
    }
  | { type: "connection"; connected: boolean }
  | { type: "problem"; code: RoomProblemCode; message: string }
  | { type: "load"; request: number; version: number; data: ArrayBuffer }
  | { type: "serialize"; request: number }
  | { type: "option"; message: Record<string, unknown> };

export interface WatchOptions {
  folder?: string;
  accept?: string[];
  default_folder?: boolean;
}

export interface Topics {
  theme: [void, Theme];
  route: [void, Route];
  "members.presence": [void, Presence[]];
  "files.watch": [WatchOptions | void, FileChange];
  room: [RoomParams, RoomEvent];
  "room.frames": [{ key: string; options?: RoomWireOptions }, FrameEvent];
  "calls.channels": [void, VoiceChannel[]];
  "calls.current": [void, CallState];
  "agents.control": [void, AgentControl];
}

export type MethodName = keyof Methods;
export type TopicName = keyof Topics;

export const FIRST_OFFERS: Offers = {
  calls: [
    "hello",
    "members.list",
    "members.mentionables",
    "chat.post",
    "chat.open",
    "chat.notify",
    "files.pick",
    "files.open",
    "files.save",
    "files.list",
    "files.upload",
    "files.download",
    "route.navigate",
    "room.update",
    "room.awareness",
    "calls.join",
    "calls.leave",
    "calls.mute",
  ],
  topics: ["theme", "route", "members.presence", "files.watch", "room", "calls.channels", "calls.current"],
};

export const ROOM_OPTIONS_FEATURE = "room.options";

export const isFrame = (value: unknown): value is Frame =>
  typeof value === "object" && value !== null && typeof (value as { t?: unknown }).t === "string";

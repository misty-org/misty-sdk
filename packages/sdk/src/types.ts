/** Shapes the SDK hands to apps. Records keep the server's own field names (snake_case). */

export type SpaceRole = "owner" | "member";

export interface Space {
  id: string;
  name: string;
  description?: string;
  /** Whether the person is a mod of this Space (may install apps). */
  is_mod: boolean;
}

export interface Me {
  user_id: string;
  name: string;
  role: SpaceRole;
  /** Names the person's picture; 0 or missing when there is none. */
  avatar_version?: number;
}

export interface Member {
  user_id: string;
  name: string;
  role: SpaceRole;
  avatar_version?: number;
  joined_at: string;
}

export type PresenceState = "online" | "offline";

export interface Presence {
  user_id: string;
  state: PresenceState;
  /** True while one of the member's agents is working in the Space. */
  working: boolean;
}

export interface Mentionable {
  kind: "member" | "role";
  id: string;
  name: string;
}

export interface Theme {
  mode: "light" | "dark";
  /** CSS custom properties, such as `--misty-theme-bg`, to set on the document root. */
  tokens: Record<string, string>;
  fonts: { sans: string; mono: string; /** `@font-face` rules the host serves, if any. */ css?: string };
}

export interface Route {
  path: string;
  params: Record<string, string>;
}

/** A piece of message text. */
export type Span =
  | { kind: "text"; text: string }
  | { kind: "mention"; mention: Pick<Mentionable, "kind" | "id"> }
  | { kind: "link"; url: string; text?: string };

/** The Open card an APP message carries. */
export interface Card {
  title: string;
  /** One short line under the title. */
  detail?: string;
  /** Where Open leads, inside this app. */
  route?: Route;
  file_id?: string;
}

export type ChatTarget = { channel: string } | { dm: string };

export interface FileRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** The id of the app that made or last saved it, when one did. */
  app_id?: string;
  folder?: string;
  updated_at: string;
}

export interface PickOptions {
  /** Kinds to offer, such as `image/*` or `.psd`. Defaults to the app's manifest kinds. */
  accept?: string[];
  multiple?: boolean;
}

export interface SaveOptions {
  name: string;
  mime: string;
  /** Where to save in the Space's drive. The app's own folder (`/<App name>/`) when left out. */
  folder?: string;
  data: ArrayBuffer | Uint8Array | Blob;
}

export interface ListFilesOptions {
  folder?: string;
  accept?: string[];
  limit?: number;
  cursor?: string;
}

export interface FilePage {
  files: FileRef[];
  next_cursor?: string;
}

export type FileChange = { kind: "added" | "changed"; file: FileRef } | { kind: "removed"; id: string };

export interface UploadOptions {
  name: string;
  mime: string;
  folder?: string;
  data: ArrayBuffer | Uint8Array | Blob;
}

/** What an app can ask for in `misty-app.json`. The mod approves these once, at install. */
export type Permission = "files" | "chat.post" | "rooms" | "members" | "calls";

/** One of the Space's voice channels, and who is in it now. */
export interface VoiceChannel {
  channel_id: string;
  name: string;
  /** The user ids of the people in it, each once. */
  people: string[];
}

/** This window's call: the voice channel it is in (null when none) and whether its microphone is on. */
export interface CallState {
  channel_id: string | null;
  mic_on: boolean;
}

export type McpKind = "frame" | "binary";

export interface AppManifest {
  id: string;
  name: string;
  version: string;
  /** A 64×64 SVG on the app's tile color. */
  logo: string;
  entry: string;
  /** Kinds of Space file the app opens, such as `image/*` or `.psd`. */
  opens?: string[];
  permissions: Permission[];
  mcp?: McpKind;
  /** The app needs its own webview instead of a sandboxed frame. */
  webview?: boolean;
}

/** What the host sends when the app starts. */
export interface AppContext {
  app_id: string;
  space: Space;
  me: Me;
  theme: Theme;
  route: Route;
  permissions: Permission[];
}

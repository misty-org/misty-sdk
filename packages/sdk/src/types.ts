export type SpaceRole = "owner" | "member";

export interface Space {
  id: string;
  name: string;
  description?: string;
  is_mod: boolean;
}

export type AvatarTone = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export interface Me {
  user_id: string;
  name: string;
  role: SpaceRole;
  avatar_version?: number;
  tone?: AvatarTone;
}

export interface Member {
  user_id: string;
  name: string;
  role: SpaceRole;
  avatar_version?: number;
  joined_at: string;
  tone?: AvatarTone;
}

export type PresenceState = "online" | "offline";

export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

export interface Presence {
  user_id: string;
  state: PresenceState;
  working: boolean;
  status?: PresenceStatus;
  app_id?: string;
}

export interface AgentCaller {
  id: string;
  name: string;
}

export interface Identity {
  user_id: string;
  name: string;
  tone: AvatarTone | null;
  agent?: AgentCaller;
}

export interface AgentControl {
  agent: { id: string; name: string; user_id: string } | null;
  driver: "person" | "agent";
}

export interface Mentionable {
  kind: "member" | "role";
  id: string;
  name: string;
}

export interface Theme {
  mode: "light" | "dark";
  tokens: Record<string, string>;
  fonts: { sans: string; mono: string; css?: string };
}

export interface Route {
  path: string;
  params: Record<string, string>;
}

export type Span =
  | { kind: "text"; text: string }
  | { kind: "mention"; mention: Pick<Mentionable, "kind" | "id"> }
  | { kind: "link"; url: string; text?: string };

export interface Card {
  title: string;
  detail?: string;
  route?: Route;
  file_id?: string;
}

export type ChatTarget = { channel: string } | { dm: string };

export interface FileUse {
  user_id: string;
  name: string;
  editing: boolean;
  you: boolean;
}

export interface FileRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  app_id?: string;
  folder?: string;
  updated_at: string;
  in_use?: FileUse[];
}

export type FileFormat = "text" | "app";

export interface PickOptions {
  accept?: string[];
  multiple?: boolean;
}

export interface SaveOptions {
  name: string;
  mime: string;
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

export type Permission = "files" | "chat.post" | "rooms" | "members" | "calls";

export interface VoiceChannel {
  channel_id: string;
  name: string;
  people: string[];
}

export interface CallState {
  channel_id: string | null;
  mic_on: boolean;
}

export type McpKind = "frame" | "binary";

export interface AppManifest {
  id: string;
  name: string;
  version: string;
  logo: string;
  entry: string;
  opens?: string[];
  permissions: Permission[];
  mcp?: McpKind;
  webview?: boolean;
}

export interface AppContext {
  app_id: string;
  space: Space;
  me: Me;
  theme: Theme;
  route: Route;
  permissions: Permission[];
}

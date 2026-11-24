import * as decoding from "lib0/decoding";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { fileRoomOpener } from "./file_room_session.js";
import type { FileEntry, FileStore } from "./file_store.js";
import { folderOf } from "./file_store.js";
import type { RoomOpened } from "./protocol.js";
import type { RoomClient, RoomStatus, SyncTap } from "./room_client.js";

export { FILE_META, FILE_TEXT, fingerprintOf, liveText, snapshotOf } from "./file_room_marks.js";

const OPEN = 1;

type Listener<T extends unknown[]> = (...args: T) => void;

export class FakeProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly origin = {};
  readonly key = "file-1";
  readonly space = "space-1";
  sent: Record<string, unknown>[] = [];
  synced = false;
  wsconnected = false;
  ws: { readyState: number; send: (data: unknown) => void } | null = null;
  tap: SyncTap | null = null;
  readonly opened: Promise<RoomOpened>;
  readonly said: RoomOpened;
  readonly messageHandlers: ((...args: unknown[]) => void)[];
  private readonly closes = new Set<Listener<[number, string]>>();
  private readonly statuses = new Set<Listener<[RoomStatus]>>();
  private readonly syncs = new Set<Listener<[boolean]>>();
  private readonly messages = new Set<Listener<[Record<string, unknown>]>>();

  constructor(format: "app" | "text", gc: boolean) {
    this.doc = new Y.Doc({ gc });
    this.awareness = new Awareness(this.doc);
    clearInterval((this.awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
    this.said = {
      type: "opened",
      room: "rm_test",
      role: "edit",
      options: { file: "file-1", text: format === "app" ? null : "text" },
      seats: 40,
      max_bytes: 8 * 1024 * 1024,
      identity: { kind: "person", id: "ana", name: "Ana" },
    };
    this.opened = Promise.resolve(this.said);
    this.messageHandlers = [
      (_encoder: unknown, decoder: unknown) => {
        const message = decoding.readTailAsUint8Array(decoder as decoding.Decoder);
        if (!this.tap?.incoming(message)) this.applySync();
      },
    ];
  }

  get admitted() {
    return this.wsconnected ? this.said : null;
  }

  get latest() {
    return this.said;
  }

  get linked() {
    return this.wsconnected;
  }

  get connected() {
    return this.wsconnected && this.synced;
  }

  get lost() {
    return null;
  }

  identity() {
    return null;
  }

  onLost() {
    return () => undefined;
  }

  onConnection() {
    return () => undefined;
  }

  onProblem() {
    return () => undefined;
  }

  onClose(listener: Listener<[number, string]>) {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  onStatus(listener: Listener<[RoomStatus]>) {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }

  onSync(listener: Listener<[boolean]>) {
    this.syncs.add(listener);
    return () => this.syncs.delete(listener);
  }

  onMessage(listener: Listener<[Record<string, unknown>]>) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  send(message: Record<string, unknown>) {
    if (!this.wsconnected) return false;
    const rest = { ...message };
    delete rest.option;
    this.sent.push(rest);
    return true;
  }

  sendUpdate(update: Uint8Array) {
    if (this.ws?.readyState !== OPEN) return false;
    this.ws.send(update);
    return true;
  }

  applySync() {
    return undefined;
  }

  tapSync(tap: SyncTap) {
    this.tap = tap;
    return () => {
      if (this.tap === tap) this.tap = null;
    };
  }

  resend() {
    return undefined;
  }

  disconnect() {
    this.down();
  }

  close() {
    this.doc.destroy();
  }

  up() {
    this.wsconnected = true;
    this.ws = { readyState: OPEN, send: () => undefined };
    for (const listener of [...this.statuses]) listener("connected");
    this.synced = true;
    for (const listener of [...this.syncs]) listener(true);
  }

  down() {
    for (const listener of [...this.closes]) listener(1006, "");
    this.wsconnected = false;
    this.ws = null;
    this.synced = false;
    for (const listener of [...this.syncs]) listener(false);
    for (const listener of [...this.statuses]) listener("disconnected");
  }

  say(message: Record<string, unknown>) {
    for (const listener of [...this.messages]) listener({ option: "file", ...message });
  }
}

export interface FakeDrive {
  entry: Record<string, unknown> | null;
  lookup?: (() => Promise<void>) | undefined;
  read: (...args: unknown[]) => Promise<ArrayBuffer>;
  write: (...args: unknown[]) => Promise<unknown>;
  changed: Set<(changed: unknown) => void>;
}

export interface FakeApi {
  versions: Record<string, unknown> | null;
  asked: string[];
}

export interface FakeOpenerOptions {
  drive: FakeDrive;
  providers: FakeProvider[];
  format?: () => "app" | "text";
  api?: FakeApi;
  notice?: (message: string) => void;
}

export function fakeStore(drive: FakeDrive, api?: FakeApi): FileStore {
  return {
    entry: async () => {
      if (drive.lookup) await drive.lookup();
      return drive.entry as unknown as FileEntry | null;
    },
    read: (entry) => drive.read("space-1", entry.path),
    write: (entry, data, base) =>
      drive.write("space-1", folderOf(entry.path), entry.name, data, { item_id: entry.id, version: base }) as Promise<FileEntry>,
    copy: (entry, _name, data) =>
      drive.write("space-1", folderOf(entry.path), `${entry.name} (conflicted copy)`, data) as Promise<FileEntry>,
    watch: (listener) => {
      const each = listener as (changed: unknown) => void;
      drive.changed.add(each);
      return () => drive.changed.delete(each);
    },
    ref: (entry) => ({ id: entry.id, name: entry.name }) as ReturnType<NonNullable<FileStore["ref"]>>,
    ...(api
      ? {
          versions: async (fileId: string) => {
            api.asked.push(`/spaces/space-1/drive/items/${fileId}`);
            if (!api.versions) throw new Error("offline");
            return { ...api.versions };
          },
        }
      : {}),
  };
}

export function fakeOpener(options: FakeOpenerOptions) {
  return fileRoomOpener({
    store: fakeStore(options.drive, options.api),
    open: ({ gc }) => {
      const provider = new FakeProvider(options.format?.() ?? "app", gc);
      options.providers.push(provider);
      return provider as unknown as RoomClient;
    },
    ...(options.notice ? { notice: options.notice } : {}),
  });
}

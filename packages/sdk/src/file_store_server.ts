import { sha256Hex } from "./base64.js";
import { MistyError } from "./errors.js";
import type { FileEntry, FileStore, FileStoreChange, FileStoreItem } from "./file_store.js";
import { retryDelay } from "./timing.js";
import { readJson, statusError, type TokenSource } from "./transport.js";
import { socketConstructor, type WebSocketConstructor } from "./transport_websocket.js";

export interface ServerFileStoreOptions {
  api: string;
  space: string;
  token: TokenSource;
  name?: string;
  fetch?: typeof fetch;
  WebSocket?: WebSocketConstructor;
}

const DEVICE_NAME = "misty-sdk";

interface DriveItem {
  id: string;
  parent_id?: string | null;
  name: string;
  kind: string;
  sha256?: string | null;
  size: number;
  mtime_ms: number;
  version: number;
  modified_by_name?: string;
  trashed?: boolean;
  deleted?: boolean;
  content_version?: number;
}

const itemOf = (value: unknown): DriveItem | null => {
  if (typeof value !== "object" || value === null) return null;
  const said = value as Record<string, unknown>;
  if (typeof said.id !== "string" || typeof said.name !== "string") return null;
  return said as unknown as DriveItem;
};

export function entryOf(item: DriveItem): FileStoreItem {
  return {
    id: item.id,
    path: `${item.parent_id ?? ""}/${item.name}`,
    name: item.name,
    kind: item.kind === "folder" ? "folder" : "file",
    size: typeof item.size === "number" ? item.size : 0,
    mtime_ms: typeof item.mtime_ms === "number" ? item.mtime_ms : 0,
    state: "downloaded",
    ...(typeof item.version === "number" && item.version > 0 ? { version: item.version } : {}),
    ...(typeof item.content_version === "number" && item.content_version > 0
      ? { content_version: item.content_version }
      : {}),
    ...(typeof item.sha256 === "string" && item.sha256 ? { sha: item.sha256.toLowerCase() } : {}),
    ...(item.modified_by_name ? { modified_by_name: item.modified_by_name } : {}),
    ...(item.trashed ? { trashed: true } : {}),
    ...(item.deleted ? { removed: true } : {}),
  };
}

interface Uploaded {
  upload_id: string;
  sha256: string;
  size: number;
}

export function serverFileStore(options: ServerFileStoreOptions): FileStore {
  const run: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const api = options.api.replace(/\/+$/, "");
  const drive = `${api}/spaces/${encodeURIComponent(options.space)}/drive`;
  const device = `dev_${crypto.randomUUID().toLowerCase()}`;
  const deviceName = (options.name?.trim() || DEVICE_NAME).slice(0, 64);
  const parents = new Map<string, string | null>();
  const watched = new Set<string>();
  const listeners = new Set<(change: FileStoreChange) => void>();
  const holds = new Map<string, number>();
  let socket: WebSocket | null = null;
  let connecting = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const call = async (path: string, init: RequestInit = {}, what = "the Space's drive"): Promise<Response> => {
    const token = await options.token();
    const response = await run(`${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Misty-Device": device,
        "X-Misty-Device-Name": encodeURIComponent(deviceName),
        ...(init.body !== undefined && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw statusError(response.status, what);
    }
    return response;
  };
  const json = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> =>
    readJson(await (await call(path, init)).text()) ?? {};
  const remember = (item: DriveItem) => {
    parents.set(item.id, item.parent_id ?? null);
    return entryOf(item);
  };
  const fetchItem = async (id: string): Promise<FileStoreItem | null> => {
    try {
      const item = itemOf(await json(`${drive}/items/${encodeURIComponent(id)}`));
      return item ? remember(item) : null;
    } catch (error) {
      if (error instanceof MistyError && error.code === "not_found") return null;
      throw error;
    }
  };

  const upload = async (data: Uint8Array): Promise<Uploaded> => {
    const sha256 = await sha256Hex(data);
    const size = data.byteLength;
    const started = await json(`${drive}/uploads`, { method: "POST", body: JSON.stringify({ sha256, size }) });
    const id = typeof started.upload_id === "string" ? started.upload_id : "";
    if (!id) throw new MistyError("internal", "The drive didn't start the upload.");
    if (started.present === true) return { upload_id: id, sha256, size };
    const single = started.single as { url?: string; method?: string; headers?: Record<string, string> } | undefined;
    const multipart = started.multipart as
      | { part_size?: number; parts?: { number: number; url: string }[] }
      | undefined;
    let parts: { number: number; etag: string }[] | undefined;
    if (single?.url) {
      const put = await run(single.url, { method: single.method || "PUT", headers: single.headers ?? {}, body: new Uint8Array(data) });
      await put.body?.cancel().catch(() => undefined);
      if (!put.ok) throw statusError(put.status, "the upload");
    } else if (multipart?.parts?.length && multipart.part_size) {
      const partSize = multipart.part_size;
      parts = [];
      for (const part of multipart.parts) {
        const from = (part.number - 1) * partSize;
        const put = await run(part.url, { method: "PUT", body: data.slice(from, from + partSize) });
        await put.body?.cancel().catch(() => undefined);
        if (!put.ok) throw statusError(put.status, "the upload");
        const etag = put.headers.get("ETag");
        if (!etag) throw new MistyError("internal", "The upload's storage didn't name a part.");
        parts.push({ number: part.number, etag });
      }
    } else throw new MistyError("unsupported", "The drive didn't say where to upload the file.");
    await call(`${drive}/uploads/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      body: JSON.stringify(parts ? { parts } : {}),
    });
    return { upload_id: id, sha256, size };
  };

  const deliver = (change: FileStoreChange) => {
    for (const listener of [...listeners]) listener(change);
  };
  const refetch = (id: string) => {
    fetchItem(id).then(
      (item) => deliver(item ? { items: [item] } : { items: [], removed: [id] }),
      () => undefined,
    );
  };
  const needed = () => listeners.size > 0 || holds.size > 0;
  const sendHold = (itemId: string, active: boolean) => {
    if (socket?.readyState !== 1) return;
    socket.send(
      JSON.stringify({
        type: "drive.hold",
        space_id: options.space,
        item_id: itemId,
        active,
        editing: true,
        device_id: device,
        device_name: deviceName,
      }),
    );
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, retryDelay(attempts));
    attempts += 1;
  };
  const connect = async () => {
    if (socket || connecting || !needed()) return;
    const Socket = socketConstructor(options.WebSocket);
    if (!Socket) return;
    connecting = true;
    try {
      const { ticket } = (await json(`${api}/realtime/tickets`, { method: "POST", body: "{}" })) as { ticket?: unknown };
      if (typeof ticket !== "string" || !needed()) return;
      const url = `${api.replace(/^http(s?):/, "ws$1:")}/realtime?ticket=${encodeURIComponent(ticket)}&only=drive.&live=1`;
      const opened = new Socket(url);
      socket = opened;
      opened.onopen = () => {
        attempts = 0;
        for (const itemId of holds.keys()) sendHold(itemId, true);
        for (const id of watched) refetch(id);
      };
      opened.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const said = readJson(event.data);
        if (!said) return;
        if (said.type === "replay") {
          if (said.resync_required === true) for (const id of watched) refetch(id);
          return;
        }
        if (said.type !== "event") return;
        const happened = said.event as Record<string, unknown> | undefined;
        if (!happened || happened.space_id !== options.space || happened.type !== "drive.changed") return;
        const id = happened.entity_id;
        if (typeof id === "string" && watched.has(id)) refetch(id);
      };
      opened.onclose = () => {
        if (socket === opened) socket = null;
        if (needed()) later();
      };
      opened.onerror = () => undefined;
    } catch {
      later();
    } finally {
      connecting = false;
    }
  };
  const disconnectIfIdle = () => {
    if (needed()) return;
    clearTimeout(timer);
    timer = undefined;
    const was = socket;
    socket = null;
    if (was) {
      was.onclose = null;
      was.close(1000);
    }
  };

  return {
    async entry(fileId) {
      watched.add(fileId);
      return fetchItem(fileId);
    },
    async read(entry) {
      const answer = await json(`${drive}/items/${encodeURIComponent(entry.id)}/content`);
      const url = typeof answer.url === "string" ? answer.url : "";
      if (!url) return new ArrayBuffer(0);
      const response = await run(url);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw statusError(response.status, "the file's content");
      }
      return response.arrayBuffer();
    },
    async write(entry, data, base) {
      const uploaded = await upload(data);
      const item = itemOf(
        await json(`${drive}/items/${encodeURIComponent(entry.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            sha256: uploaded.sha256,
            size: uploaded.size,
            upload_id: uploaded.upload_id,
            mtime_ms: Date.now(),
            ...(base > 0 ? { base_version: base } : {}),
          }),
        }),
      );
      if (!item) throw new MistyError("internal", "The drive didn't say what it saved.");
      return remember(item);
    },
    async copy(entry, name, data) {
      const uploaded = await upload(data);
      const parent = parents.has(entry.id) ? parents.get(entry.id) : (await fetchItem(entry.id), parents.get(entry.id));
      const item = itemOf(
        await json(`${drive}/items`, {
          method: "POST",
          body: JSON.stringify({
            parent_id: parent ?? null,
            name,
            kind: "file",
            sha256: uploaded.sha256,
            size: uploaded.size,
            mtime_ms: Date.now(),
            upload_id: uploaded.upload_id,
          }),
        }),
      );
      if (!item) throw new MistyError("internal", "The drive didn't say what it saved.");
      return remember(item);
    },
    watch(listener) {
      listeners.add(listener);
      void connect();
      return () => {
        listeners.delete(listener);
        disconnectIfIdle();
      };
    },
    async hold(entry: FileEntry) {
      holds.set(entry.id, (holds.get(entry.id) ?? 0) + 1);
      if (socket) sendHold(entry.id, true);
      else void connect();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (holds.get(entry.id) ?? 1) - 1;
        if (left > 0) {
          holds.set(entry.id, left);
          return;
        }
        holds.delete(entry.id);
        sendHold(entry.id, false);
        disconnectIfIdle();
      };
    },
  };
}

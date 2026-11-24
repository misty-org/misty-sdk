import {
  fetchFollowing,
  httpBase,
  readJson,
  statusError,
  type ReadRequest,
  type RequestTransport,
  type TokenSource,
  type WriteRequest,
} from "./transport.js";

export interface RequestTransportOptions {
  url: string;
  token: TokenSource;
  fetch?: typeof fetch;
}

const roomPath = (space: string, key: string) =>
  `/v1/collab/rooms/${encodeURIComponent(space)}/${encodeURIComponent(key)}`;

export function requestTransport(options: RequestTransportOptions): RequestTransport {
  const run: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const base = () => httpBase(options.url);
  return {
    async read({ space, key, as }: ReadRequest) {
      const token = await options.token();
      const { response } = await fetchFollowing(run, `${base()}${roomPath(space, key)}?as=${as}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw statusError(response.status, "this room");
      }
      if (as === "update") return new Uint8Array(await response.arrayBuffer());
      return readJson(await response.text()) ?? {};
    },
    async write({ space, key, update, options: roomOptions }: WriteRequest) {
      const token = await options.token();
      const query =
        roomOptions && Object.keys(roomOptions).length > 0
          ? `?options=${encodeURIComponent(JSON.stringify(roomOptions))}`
          : "";
      const { response } = await fetchFollowing(run, `${base()}${roomPath(space, key)}${query}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(update),
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw statusError(response.status, "this room");
    },
  };
}

import { fromBase64 } from "./base64.js";
import { MistyError, asMistyError } from "./errors.js";
import { forgetSession, inNode, loadSession, saveSession } from "./keychain.js";
import { retryDelay, sleep } from "./timing.js";
import { readEvents, readJson, statusError, type TokenSource } from "./transport.js";
import type { Identity } from "./types.js";

export interface DeviceCode {
  url: string;
  code: string;
  expiresIn: number;
}

export interface SignInOptions {
  server: string;
  token?: string;
  name?: string;
  onCode?: (code: DeviceCode) => void;
  keychain?: boolean;
  fetch?: typeof fetch;
}

export interface SignedIn {
  readonly server: string;
  readonly kind: "person" | "integration";
  readonly identity: Identity;
  readonly space?: string;
  readonly token: TokenSource;
  signOut(): Promise<void>;
}

const INTEGRATION_PREFIX = "misty_int_";
const ACCESS_MARGIN_MS = 30_000;
const INTEGRATION_MARGIN_MS = 60_000;
const DEFAULT_ACCESS_MS = 300_000;
const MAX_NAME = 64;

export function apiBase(server: string): string {
  const parsed = new URL(server.trim().replace(/\/+$/, ""));
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${parsed.protocol}//${parsed.host}${path}/v1`;
}

export function serverOrigin(server: string): string {
  const parsed = new URL(server.trim());
  return `${parsed.protocol}//${parsed.host}`;
}

export async function collabAddress(api: string, fetcher: typeof fetch = globalThis.fetch): Promise<string> {
  const fallback = serverOrigin(api);
  try {
    const answer = await fetcher(`${api}/health`, { headers: { accept: "application/json" } });
    if (!answer.ok) return fallback;
    const said: unknown = await answer.json();
    const value = typeof said === "object" && said !== null ? (said as Record<string, unknown>).collab_url : undefined;
    if (typeof value !== "string" || !value) return fallback;
    const parsed = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return fallback;
    return value.replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

export function expiryOf(token: string, fallbackMs = DEFAULT_ACCESS_MS): number {
  const payload = token.split(".")[1];
  if (payload) {
    try {
      const claims = readJson(new TextDecoder().decode(fromBase64(payload)));
      if (typeof claims?.exp === "number") return claims.exp * 1000;
    } catch {
      return Date.now() + fallbackMs;
    }
  }
  return Date.now() + fallbackMs;
}

const fetcher = (given?: typeof fetch): typeof fetch => given ?? ((input, init) => fetch(input, init));

async function deviceName(given?: string): Promise<string> {
  if (given?.trim()) return given.trim().slice(0, MAX_NAME);
  if (inNode()) {
    try {
      const os = "node:os";
      const { hostname } = (await import(/* @vite-ignore */ os)) as { hostname(): string };
      const host = hostname().replace(/\.local$/, "");
      if (host) return `misty-sdk on ${host}`.slice(0, MAX_NAME);
    } catch {
      return "misty-sdk";
    }
  }
  return "misty-sdk";
}

interface Session {
  sessionId: string;
  refresh: string;
  access: string;
  expiresAt: number;
}

const REFRESH_ATTEMPTS = 3;

async function refreshSession(run: typeof fetch, api: string, refresh: string): Promise<Omit<Session, "sessionId"> | null> {
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await run(`${api}/auth/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${refresh}`, "X-Misty-Token-Transport": "bearer" },
      });
      break;
    } catch (error) {
      if (attempt + 1 >= REFRESH_ATTEMPTS) throw error;
      await sleep(retryDelay(attempt));
    }
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw statusError(response.status, "signing in");
  const access = response.headers.get("X-Misty-Access-Token");
  const next = response.headers.get("X-Misty-Refresh-Token");
  if (!access || !next) throw new MistyError("unsupported", "The server didn't hand back a session this runtime can keep.");
  return { access, refresh: next, expiresAt: expiryOf(access) };
}

const announce = (code: DeviceCode) =>
  console.error(`To sign in to Misty, open ${code.url} and check that Misty shows the code ${code.code}.`);

async function deviceSignIn(run: typeof fetch, api: string, options: SignInOptions): Promise<Session> {
  const started = await run(`${api}/auth/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: await deviceName(options.name) }),
  });
  const asked = started.ok ? readJson(await started.text()) : null;
  if (!started.ok) {
    await started.body?.cancel().catch(() => undefined);
    throw statusError(started.status, "device sign-in");
  }
  const id = typeof asked?.id === "string" ? asked.id : "";
  const code = typeof asked?.user_code === "string" ? asked.user_code : "";
  const url = typeof asked?.verification_url === "string" ? asked.verification_url : "";
  const expiresIn = typeof asked?.expires_in === "number" ? asked.expires_in : 600;
  if (!id || !code) throw new MistyError("internal", "The server didn't start a device sign-in.");
  (options.onCode ?? announce)({ url, code, expiresIn });
  const deadline = Date.now() + expiresIn * 1000;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    let outcome: { event: string; data: Record<string, unknown> } | null = null;
    try {
      const waiting = await run(`${api}/auth/device/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
      });
      if (waiting.status === 404 || waiting.status === 410) {
        await waiting.body?.cancel().catch(() => undefined);
        throw new MistyError("cancelled", "The sign-in code expired. Start again for a new one.");
      }
      if (!waiting.ok || !waiting.body) {
        await waiting.body?.cancel().catch(() => undefined);
        if (waiting.status < 500) throw statusError(waiting.status, "device sign-in");
      } else {
        await readEvents(waiting.body, ({ event, data }) => {
          if (event !== "approved" && event !== "refused" && event !== "expired") return false;
          outcome = { event, data: readJson(data) ?? {} };
          return true;
        });
      }
    } catch (error) {
      if (error instanceof MistyError) throw error;
    }
    const said = outcome as { event: string; data: Record<string, unknown> } | null;
    if (said?.event === "refused") throw new MistyError("permission_denied", "The sign-in was refused in Misty.");
    if (said?.event === "expired") throw new MistyError("cancelled", "The sign-in code expired. Start again for a new one.");
    if (said?.event === "approved") {
      const access = typeof said.data.access_token === "string" ? said.data.access_token : "";
      const refresh = typeof said.data.refresh_token === "string" ? said.data.refresh_token : "";
      if (!access || !refresh) throw new MistyError("internal", "The approved sign-in came back without a session.");
      const expiresIn = typeof said.data.expires_in === "number" ? said.data.expires_in * 1000 : DEFAULT_ACCESS_MS;
      return {
        sessionId: typeof said.data.session_id === "string" ? said.data.session_id : "",
        refresh,
        access,
        expiresAt: Math.min(expiryOf(access, expiresIn), Date.now() + expiresIn),
      };
    }
    await sleep(Math.min(retryDelay(attempt), Math.max(0, deadline - Date.now())));
  }
  throw new MistyError("cancelled", "The sign-in code expired. Start again for a new one.");
}

async function personOf(run: typeof fetch, api: string, access: string): Promise<Identity> {
  try {
    const response = await run(`${api}/me`, { headers: { Authorization: `Bearer ${access}` } });
    const me = response.ok ? readJson(await response.text()) : null;
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    return {
      user_id: typeof me?.id === "string" ? me.id : "",
      name: typeof me?.username === "string" ? me.username : "",
      tone: null,
    };
  } catch {
    return { user_id: "", name: "", tone: null };
  }
}

async function integrationSignIn(run: typeof fetch, api: string, token: string): Promise<SignedIn> {
  let access = "";
  let expiresAt = 0;
  let pending: Promise<string> | null = null;
  const exchange = async (): Promise<Record<string, unknown>> => {
    const response = await run(`${api}/auth/integration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw statusError(response.status, "this integration");
    }
    const said = readJson(await response.text()) ?? {};
    if (typeof said.access_token !== "string" || !said.access_token)
      throw new MistyError("internal", "The server didn't hand back an access token for this integration.");
    access = said.access_token;
    const lasts = typeof said.expires_in === "number" ? said.expires_in * 1000 : DEFAULT_ACCESS_MS;
    expiresAt = Date.now() + lasts;
    return said;
  };
  const first = await exchange();
  const integration =
    typeof first.integration === "object" && first.integration !== null
      ? (first.integration as Record<string, unknown>)
      : {};
  const space = typeof integration.space_id === "string" && integration.space_id ? integration.space_id : undefined;
  return {
    server: api,
    kind: "integration",
    identity: {
      user_id: typeof integration.id === "string" ? integration.id : "",
      name: typeof integration.name === "string" ? integration.name : "",
      tone: null,
    },
    ...(space === undefined ? {} : { space }),
    token: (asked) => {
      if (!asked?.fresh && access && expiresAt - Date.now() > INTEGRATION_MARGIN_MS) return Promise.resolve(access);
      pending ??= exchange()
        .then(() => access)
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    signOut: async () => {
      access = "";
      expiresAt = 0;
    },
  };
}

async function personSignIn(run: typeof fetch, api: string, options: SignInOptions): Promise<SignedIn> {
  const origin = serverOrigin(api);
  const keep = options.keychain !== false;
  let session: Session | null = null;
  const stored = keep ? await loadSession(origin) : null;
  if (stored) {
    const renewed = await refreshSession(run, api, stored.refresh_token);
    if (renewed) session = { sessionId: stored.session_id, ...renewed };
    else await forgetSession(origin);
  }
  const remember = async (next: Session) => {
    if (keep) await saveSession(origin, { session_id: next.sessionId, refresh_token: next.refresh });
  };
  if (!session) {
    session = await deviceSignIn(run, api, options);
  }
  await remember(session);
  let current: Session = session;
  let pending: Promise<string> | null = null;
  const renew = async (): Promise<string> => {
    const renewed = await refreshSession(run, api, current.refresh);
    if (renewed) {
      current = { sessionId: current.sessionId, ...renewed };
      await remember(current);
      return current.access;
    }
    if (keep) await forgetSession(origin);
    current = await deviceSignIn(run, api, options);
    await remember(current);
    return current.access;
  };
  return {
    server: api,
    kind: "person",
    identity: await personOf(run, api, current.access),
    token: (asked) => {
      if (!asked?.fresh && current.access && current.expiresAt - Date.now() > ACCESS_MARGIN_MS)
        return Promise.resolve(current.access);
      pending ??= renew().finally(() => {
        pending = null;
      });
      return pending;
    },
    signOut: async () => {
      const ending = current;
      current = { ...current, access: "", expiresAt: 0 };
      if (keep) await forgetSession(origin);
      if (!ending.sessionId) return;
      try {
        const access =
          ending.access && ending.expiresAt - Date.now() > ACCESS_MARGIN_MS
            ? ending.access
            : (await refreshSession(run, api, ending.refresh))?.access;
        if (!access) return;
        const response = await run(`${api}/me/sessions/${encodeURIComponent(ending.sessionId)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${access}` },
        });
        await response.body?.cancel().catch(() => undefined);
      } catch {
        return;
      }
    },
  };
}

export async function signIn(options: SignInOptions): Promise<SignedIn> {
  const run = fetcher(options.fetch);
  const api = apiBase(options.server);
  const token = options.token?.trim();
  try {
    if (token?.startsWith(INTEGRATION_PREFIX)) return await integrationSignIn(run, api, token);
    if (token) {
      return {
        server: api,
        kind: "person",
        identity: await personOf(run, api, token),
        token: () => Promise.resolve(token),
        signOut: async () => undefined,
      };
    }
    if (!inNode() && options.onCode === undefined)
      throw new MistyError("unsupported", "Signing in a device needs Node, or an onCode callback to show the code.");
    return await personSignIn(run, api, options);
  } catch (error) {
    throw asMistyError(error);
  }
}

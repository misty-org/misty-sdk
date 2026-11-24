const SERVICE = "misty-session";
const SERVERS = "servers";
const KEYRING = "@napi-rs/keyring";

export interface StoredSession {
  session_id: string;
  refresh_token: string;
}

interface KeyEntry {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}

type KeyEntryConstructor = new (service: string, account: string) => KeyEntry;

export const inNode = (): boolean =>
  typeof (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions?.node === "string";

let loading: Promise<KeyEntryConstructor | null> | null = null;

function keyring(): Promise<KeyEntryConstructor | null> {
  if (!inNode()) return Promise.resolve(null);
  loading ??= import(/* @vite-ignore */ KEYRING).then(
    (module: { AsyncEntry?: KeyEntryConstructor }) => module.AsyncEntry ?? null,
    () => null,
  );
  return loading;
}

async function entry(account: string): Promise<KeyEntry | null> {
  const Entry = await keyring();
  if (!Entry) return null;
  try {
    return new Entry(SERVICE, account);
  } catch {
    return null;
  }
}

const readServers = async (servers: KeyEntry): Promise<string[]> => {
  try {
    const parsed: unknown = JSON.parse((await servers.getPassword()) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

export async function loadSession(origin: string): Promise<StoredSession | null> {
  const found = await entry(origin);
  if (!found) return null;
  try {
    const parsed: unknown = JSON.parse((await found.getPassword()) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return null;
    const { session_id: sessionId, refresh_token: refreshToken } = parsed as Record<string, unknown>;
    if (typeof refreshToken !== "string" || !refreshToken) return null;
    return { session_id: typeof sessionId === "string" ? sessionId : "", refresh_token: refreshToken };
  } catch {
    return null;
  }
}

export async function saveSession(origin: string, session: StoredSession): Promise<boolean> {
  const found = await entry(origin);
  const servers = await entry(SERVERS);
  if (!found || !servers) return false;
  try {
    await found.setPassword(JSON.stringify({ session_id: session.session_id, refresh_token: session.refresh_token }));
    const known = await readServers(servers);
    if (!known.includes(origin)) await servers.setPassword(JSON.stringify([...known, origin]));
    return true;
  } catch {
    return false;
  }
}

export async function forgetSession(origin: string): Promise<void> {
  const found = await entry(origin);
  const servers = await entry(SERVERS);
  if (!found || !servers) return;
  try {
    await found.deletePassword();
    const known = await readServers(servers);
    if (known.includes(origin)) await servers.setPassword(JSON.stringify(known.filter((each) => each !== origin)));
  } catch {
    return;
  }
}

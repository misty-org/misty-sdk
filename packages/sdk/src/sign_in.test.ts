import { describe, expect, it, vi } from "vitest";
import { apiBase, signIn } from "./sign_in.js";

const jwt = (exp: number) =>
  `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.y`;

function eventBody(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("signing in", () => {
  it("normalizes the server to its API base", () => {
    expect(apiBase("https://api.example.com")).toBe("https://api.example.com/v1");
    expect(apiBase("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });

  it("exchanges an integration token and exchanges it again before the access token runs out", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const run = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: `access-${vi.mocked(run).mock.calls.length}`,
          expires_in: 300,
          integration: { id: "int_1", space_id: "sp_1", name: "Bot" },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const signed = await signIn({ server: "https://api.example.com", token: "misty_int_abc", fetch: run });
    expect(signed.space).toBe("sp_1");
    expect(signed.identity).toEqual({ user_id: "int_1", name: "Bot", tone: null });
    expect(await signed.token()).toBe("access-1");
    now += 200_000;
    expect(await signed.token()).toBe("access-1");
    now += 50_000;
    expect(await signed.token()).toBe("access-2");
    expect(await signed.token({ fresh: true })).toBe("access-3");
    const [url, init] = vi.mocked(run).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/auth/integration");
    expect(JSON.parse(String(init.body))).toEqual({ token: "misty_int_abc" });
    vi.restoreAllMocks();
  });

  it("signs a device in through the held wait, then refreshes through the token headers", async () => {
    const codes: unknown[] = [];
    const first = jwt(Math.floor(Date.now() / 1000) + 300);
    const seen: { url: string; init?: RequestInit }[] = [];
    const run = (async (url: string | URL | Request, init?: RequestInit) => {
      const at = String(url);
      seen.push({ url: at, ...(init ? { init } : {}) });
      if (at.endsWith("/auth/device"))
        return new Response(
          JSON.stringify({ id: "dev1", user_code: "WDJB-MJHT", verification_url: "misty://device?code=WDJB-MJHT", expires_in: 600 }),
          { status: 200 },
        );
      if (at.endsWith("/auth/device/dev1"))
        return new Response(
          eventBody(
            `: keep\n\nevent: approved\ndata: ${JSON.stringify({ session_id: "s1", refresh_token: "r1", access_token: first, expires_in: 300 })}\n\n`,
          ),
          { status: 200 },
        );
      if (at.endsWith("/me")) return new Response(JSON.stringify({ id: "u1", username: "ana" }), { status: 200 });
      if (at.endsWith("/auth/refresh"))
        return new Response(null, {
          status: 204,
          headers: { "X-Misty-Access-Token": "access-2", "X-Misty-Refresh-Token": "r2" },
        });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const signed = await signIn({
      server: "https://api.example.com",
      fetch: run,
      keychain: false,
      name: "tests",
      onCode: (code) => codes.push(code),
    });
    expect(codes).toEqual([{ url: "misty://device?code=WDJB-MJHT", code: "WDJB-MJHT", expiresIn: 600 }]);
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ name: "tests" });
    expect(signed.identity).toEqual({ user_id: "u1", name: "ana", tone: null });
    expect(await signed.token()).toBe(first);
    expect(await signed.token({ fresh: true })).toBe("access-2");
    const refresh = seen.find((each) => each.url.endsWith("/auth/refresh"))!;
    const headers = new Headers(refresh.init!.headers);
    expect(headers.get("Authorization")).toBe("Bearer r1");
    expect(headers.get("X-Misty-Token-Transport")).toBe("bearer");
    expect(headers.has("Origin")).toBe(false);
  });

  it("says a refused device sign-in was refused", async () => {
    const run = (async (url: string | URL | Request) =>
      String(url).endsWith("/auth/device")
        ? new Response(JSON.stringify({ id: "d", user_code: "AAAA-BBBB", verification_url: "misty://device", expires_in: 600 }), {
            status: 200,
          })
        : new Response(eventBody("event: refused\ndata: {}\n\n"), { status: 200 })) as typeof fetch;
    await expect(
      signIn({ server: "https://api.example.com", fetch: run, keychain: false, onCode: () => undefined }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

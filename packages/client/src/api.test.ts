import { describe, expect, it } from "vitest";
import { ApiError, createApi, type RefreshTokenStore } from "./api";

function memoryStore(initial: string | null): RefreshTokenStore & { value: string | null } {
  return {
    value: initial,
    async load() {
      return this.value;
    },
    async save(t) {
      this.value = t;
    },
  };
}

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createApi", () => {
  it("refreshes once for concurrent requests and retries with the new token", async () => {
    const store = memoryStore("r1");
    let refreshCalls = 0;
    const fetchMock: typeof fetch = async (url, init) => {
      const path = String(url).replace("http://api", "");
      if (path === "/api/auth/refresh") {
        refreshCalls++;
        expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "r1" });
        return json(200, { accessToken: "a2", refreshToken: "r2", user: { id: "u", displayName: "U" } });
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === "Bearer a2" ? json(200, []) : json(401);
    };
    const api = createApi({ baseUrl: "http://api", store, fetch: fetchMock });

    await Promise.all([api.friends(), api.friends(), api.blocked()]);
    expect(refreshCalls).toBe(1);
    expect(store.value).toBe("r2");
  });

  it("signs in with a Mirattic account by redeeming the handoff code with its verifier", async () => {
    const store = memoryStore(null);
    const fetchMock: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("http://api/api/auth/handoff");
      expect(JSON.parse(String(init?.body))).toEqual({ code: "h1", verifier: "v1" });
      return json(200, { accessToken: "a1", refreshToken: "r1", user: { id: "u", displayName: "U" } });
    };
    const api = createApi({ baseUrl: "http://api", store, fetch: fetchMock, authorize: async () => ({ code: "h1", verifier: "v1" }) });

    await expect(api.loginWithMirattic()).resolves.toEqual({ id: "u", displayName: "U" });
    expect(store.value).toBe("r1");
  });

  it("clears the stored token when refresh is rejected", async () => {
    const store = memoryStore("stale");
    const api = createApi({ baseUrl: "http://api", store, fetch: async () => json(401) });

    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(store.value).toBeNull();
  });

  it("surfaces problem detail on errors", async () => {
    const api = createApi({
      baseUrl: "http://api",
      store: memoryStore(null),
      fetch: async () => json(401, { detail: "invalid handoff" }),
      authorize: async () => ({ code: "h", verifier: "v" }),
    });
    await expect(api.loginWithMirattic()).rejects.toMatchObject({ status: 401, message: "invalid handoff" });
  });

  it("deletes the account with a fresh re-auth handoff", async () => {
    const asked: unknown[] = [];
    let sent: unknown;
    const api = createApi({
      baseUrl: "http://api",
      store: memoryStore("r1"),
      fetch: async (url, init) => {
        const path = String(url).replace("http://api", "");
        if (path === "/api/auth/refresh") return json(200, { accessToken: "a1", refreshToken: "r2", user: { id: "u", displayName: "U" } });
        sent = { method: init?.method, path, body: JSON.parse(String(init?.body)) };
        return json(204);
      },
      authorize: async (o) => (asked.push(o), { code: "h2", verifier: "v2" }),
    });
    await api.deleteAccount();
    expect(asked).toEqual([{ reauth: true }]);
    expect(sent).toEqual({ method: "DELETE", path: "/api/me", body: { code: "h2", verifier: "v2" } });
  });

  it("a refresh answering after logout doesn't bring the session back", async () => {
    const store = memoryStore("r1");
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    const loggedOut: string[] = [];
    const fetchMock: typeof fetch = async (url, init) => {
      const path = String(url).replace("http://api", "");
      if (path === "/api/auth/refresh") {
        await held;
        return json(200, { accessToken: "a2", refreshToken: "r2", user: { id: "u", displayName: "U" } });
      }
      if (path === "/api/auth/logout") {
        loggedOut.push(JSON.parse(String(init?.body)).refreshToken);
        return json(204);
      }
      return json(200, []);
    };
    const api = createApi({ baseUrl: "http://api", store, fetch: fetchMock });

    const restoring = api.restore();
    await new Promise((r) => setTimeout(r, 0)); // the refresh is on its way
    await api.logout();
    answer();
    expect(await restoring).toBe(false);
    expect(store.value).toBeNull();
    expect(loggedOut).toEqual(["r1", "r2"]); // the late one is revoked too
    await expect(api.friends()).rejects.toMatchObject({ status: 401 }); // no access token left
  });

  it("a refresh still saving when logout comes doesn't leave its token behind", async () => {
    const store = memoryStore("r1");
    const save = store.save.bind(store);
    let saved!: () => void;
    const slowSave = new Promise<void>((r) => (saved = r));
    store.save = async (t) => {
      if (t === "r2") await slowSave; // the refresh's write is under way
      await save(t);
    };
    const loggedOut: string[] = [];
    const fetchMock: typeof fetch = async (url, init) => {
      const path = String(url).replace("http://api", "");
      if (path === "/api/auth/refresh") return json(200, { accessToken: "a2", refreshToken: "r2", user: { id: "u", displayName: "U" } });
      if (path === "/api/auth/logout") {
        loggedOut.push(JSON.parse(String(init?.body)).refreshToken);
        return json(204);
      }
      return json(200, []);
    };
    const api = createApi({ baseUrl: "http://api", store, fetch: fetchMock });

    const restoring = api.restore();
    await new Promise((r) => setTimeout(r, 0)); // the refresh answered and is saving r2
    const out = api.logout();
    saved();
    await out;
    expect(await restoring).toBe(false);
    expect(store.value).toBeNull();
    expect(loggedOut).toEqual(["r2"]);
    await expect(api.friends()).rejects.toMatchObject({ status: 401 });
  });
});

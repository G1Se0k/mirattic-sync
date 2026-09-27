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
      fetch: async () => json(409, { detail: "email already registered" }),
    });
    await expect(api.signup("a@b.c", "password123", "A")).rejects.toMatchObject({
      status: 409,
      message: "email already registered",
    });
  });
});

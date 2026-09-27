import type {
  AuthTokens,
  FriendRequests,
  FriendView,
  Me,
  RoomContent,
  RoomView,
  UserSummary,
  Visibility,
} from "@mirattic/types";

/** Where the refresh token lives: OS keychain on desktop, extension storage in the extension. */
export type RefreshTokenStore = {
  load(): Promise<string | null>;
  save(token: string | null): Promise<void>;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ApiClient = ReturnType<typeof createApi>;

export function createApi(opts: { baseUrl: string; store: RefreshTokenStore; fetch?: typeof fetch }) {
  const doFetch = opts.fetch ?? fetch.bind(globalThis);
  let accessToken: string | null = null;
  // Single in-flight refresh: two concurrent refreshes with one token would trip server reuse detection.
  let refreshing: Promise<boolean> | null = null;

  async function send(method: string, path: string, body: unknown, token: string | null) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return doFetch(opts.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function parse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const problem = await res.json().catch(() => null);
      throw new ApiError(res.status, problem?.detail ?? res.statusText);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async function adopt(tokens: AuthTokens) {
    accessToken = tokens.accessToken;
    await opts.store.save(tokens.refreshToken);
    return tokens.user;
  }

  function refresh(): Promise<boolean> {
    refreshing ??= (async () => {
      try {
        const stored = await opts.store.load();
        if (!stored) return false;
        const res = await send("POST", "/api/auth/refresh", { refreshToken: stored }, null);
        if (res.status === 401) {
          accessToken = null;
          await opts.store.save(null);
          return false;
        }
        await adopt(await parse<AuthTokens>(res));
        return true;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!accessToken && !(await refresh())) throw new ApiError(401, "not signed in");
    let res = await send(method, path, body, accessToken);
    if (res.status === 401 && (await refresh())) res = await send(method, path, body, accessToken);
    return parse<T>(res);
  }

  return {
    /** Resume a session from the stored refresh token. */
    restore: refresh,

    async signup(email: string, password: string, displayName: string): Promise<UserSummary> {
      return adopt(await parse<AuthTokens>(await send("POST", "/api/auth/signup", { email, password, displayName }, null)));
    },
    async login(email: string, password: string): Promise<UserSummary> {
      return adopt(await parse<AuthTokens>(await send("POST", "/api/auth/login", { email, password }, null)));
    },
    async logout(): Promise<void> {
      const stored = await opts.store.load();
      accessToken = null;
      await opts.store.save(null);
      if (stored) await send("POST", "/api/auth/logout", { refreshToken: stored }, null).catch(() => {});
    },

    me: () => authed<Me>("GET", "/api/me"),
    updatePrivacy: (presenceVisibility: Visibility, positionVisibility: Visibility) =>
      authed<Me>("PUT", "/api/me/privacy", { presenceVisibility, positionVisibility }),
    /** Invalidates the current friend code and returns the updated profile. */
    regenerateFriendCode: () => authed<Me>("POST", "/api/me/friend-code"),

    friends: () => authed<FriendView[]>("GET", "/api/friends"),
    friendRequests: () => authed<FriendRequests>("GET", "/api/friends/requests"),
    /** Accepts codes as typed ("k7qm-4xpr"). Resolves to the user the request went to; 404 if no such code. */
    sendFriendRequest: (friendCode: string) =>
      authed<UserSummary>("POST", "/api/friends/requests", { friendCode }),
    acceptFriendRequest: (id: string) => authed<void>("POST", `/api/friends/requests/${id}/accept`),
    deleteFriendRequest: (id: string) => authed<void>("DELETE", `/api/friends/requests/${id}`),
    removeFriend: (userId: string) => authed<void>("DELETE", `/api/friends/${userId}`),

    blocked: () => authed<UserSummary[]>("GET", "/api/blocks"),
    block: (userId: string) => authed<void>("PUT", `/api/blocks/${userId}`),
    unblock: (userId: string) => authed<void>("DELETE", `/api/blocks/${userId}`),

    /** Creates a room you host; invitees must be friends and get `room:invite`. */
    createRoom: (content: RoomContent, inviteIds: string[]) =>
      authed<RoomView>("POST", "/api/rooms", { content, inviteIds }),
    rooms: () => authed<RoomView[]>("GET", "/api/rooms"),
    /** 404 once the room is closed or you left it. */
    room: (id: string) => authed<RoomView>("GET", `/api/rooms/${id}`),
    /** Leave or decline. The host leaving closes the room. */
    leaveRoom: (id: string) => authed<void>("DELETE", `/api/rooms/${id}/members/me`),

    wsTicket: () => authed<{ ticket: string }>("POST", "/api/ws-ticket").then((r) => r.ticket),
  };
}

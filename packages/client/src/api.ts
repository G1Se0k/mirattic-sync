import type {
  AuthTokens,
  ChatMessage,
  FriendRequests,
  FriendView,
  Me,
  RoomContent,
  ReportReason,
  ReportTarget,
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
  // Bumped by sign-in, sign-up and sign-out: a refresh that answers after one of them belongs to an older
  // session and must not bring its tokens back.
  let session = 0;

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
    const text = await res.text(); // 202 / 204 have no body
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // Token writes run one after another and check the session when they run: a write of an older session that
  // was still waiting — or still saving — never lands after a newer session's (a sign-out's) write.
  let writes: Promise<unknown> = Promise.resolve();
  function write<T>(fn: () => Promise<T>): Promise<T> {
    const next = writes.then(fn, fn);
    writes = next.catch(() => {});
    return next;
  }
  const revoke = (refreshToken: string) =>
    send("POST", "/api/auth/logout", { refreshToken }, null).then(() => {}, () => {});

  async function adopt(tokens: AuthTokens) {
    const mine = ++session;
    refreshing = null; // a refresh of the previous session no longer counts
    const kept = await write(async () => {
      if (mine !== session) return false;
      accessToken = tokens.accessToken;
      await opts.store.save(tokens.refreshToken);
      return true;
    });
    if (!kept) await revoke(tokens.refreshToken); // signed out again before it was stored
    return tokens.user;
  }

  function refresh(): Promise<boolean> {
    if (refreshing) return refreshing;
    const mine = session;
    let run: Promise<boolean> | null = null;
    run = (async () => {
      try {
        const stored = await opts.store.load();
        if (!stored || mine !== session) return false;
        const res = await send("POST", "/api/auth/refresh", { refreshToken: stored }, null);
        if (mine !== session) {
          // Signed out (or in again) meanwhile: drop what this answer issued, on the server too.
          const late = res.ok ? await parse<AuthTokens>(res).catch(() => null) : null;
          if (late) await revoke(late.refreshToken);
          return false;
        }
        if (res.status === 401) {
          await write(async () => {
            if (mine !== session) return;
            accessToken = null;
            await opts.store.save(null);
          });
          return false;
        }
        const tokens = await parse<AuthTokens>(res);
        const kept = await write(async () => {
          if (mine !== session) return false;
          accessToken = tokens.accessToken;
          await opts.store.save(tokens.refreshToken);
          return true;
        });
        if (!kept) await revoke(tokens.refreshToken);
        // A sign-out queued behind this write clears (and revokes) it: not a live session any more.
        return kept && mine === session;
      } finally {
        if (refreshing === run) refreshing = null;
      }
    })();
    refreshing = run;
    return run;
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
      const mine = ++session;
      refreshing = null;
      accessToken = null;
      // Behind any write already under way: what it stored is read here, cleared and revoked.
      const stored = await write(async () => {
        const token = await opts.store.load();
        if (mine === session) await opts.store.save(null);
        return token;
      });
      if (stored) await revoke(stored);
    },

    me: () => authed<Me>("GET", "/api/me"),
    updatePrivacy: (presenceVisibility: Visibility, positionVisibility: Visibility) =>
      authed<Me>("PUT", "/api/me/privacy", { presenceVisibility, positionVisibility }),
    /** Deletes my account and all its data. 403 wrong password. Sign out locally afterwards. */
    deleteAccount: (password: string) => authed<void>("DELETE", "/api/me", { password }),
    /** Invalidates the current friend code and returns the updated profile. */

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
    /** Host only: adds friends to an existing room; they get `room:invite`. */
    inviteToRoom: (id: string, userIds: string[]) => authed<RoomView>("POST", `/api/rooms/${id}/invites`, { userIds }),
    /** Asks an online friend to watch together; they get `watch:request`. 409 offline, 429 asked recently. */
    requestWatch: (friendId: string) => authed<void>("POST", "/api/rooms/requests", { friendId }),
    rooms: () => authed<RoomView[]>("GET", "/api/rooms"),
    /** Joins by a room code, typed as-is ("abcd-2345"). 404 unknown, 409 full, 429 too many tries. */
    joinRoomByCode: (code: string) => authed<RoomView>("POST", "/api/rooms/join", { code }),
    /** 404 once the room is closed or you left it. */
    room: (id: string) => authed<RoomView>("GET", `/api/rooms/${id}`),
    /** Leave or decline. The host leaving closes the room. */
    leaveRoom: (id: string) => authed<void>("DELETE", `/api/rooms/${id}/members/me`),
    /** 100 chat messages, oldest first: the latest, or those before message `before`. New ones arrive as `chat:message`. */
    messages: (id: string, before?: string) =>
      authed<ChatMessage[]>("GET", `/api/rooms/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`),
    /** Author or host. Every member gets `chat:delete`. */
    deleteMessage: (roomId: string, messageId: string) => authed<void>("DELETE", `/api/rooms/${roomId}/messages/${messageId}`),
    /** A message, or a friend / room member / blocked user. 429 after 20 a day. */
    report: (target: ReportTarget, reason: ReportReason, detail?: string) =>
      authed<void>("POST", "/api/reports", { ...target, reason, detail }),
    /** My chat notifications for the room. */
    muteRoom: (id: string, muted: boolean) => authed<void>("PUT", `/api/rooms/${id}/members/me/muted`, { muted }),

    wsTicket: () => authed<{ ticket: string }>("POST", "/api/ws-ticket").then((r) => r.ticket),
  };
}

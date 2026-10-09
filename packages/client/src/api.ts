import type {
  AuthTokens,
  ChatMessage,
  FriendRequests,
  FriendView,
  Me,
  MediaProvider,
  RoomContent,
  ReportReason,
  ReportTarget,
  RoomView,
  UserSummary,
  IncomingRequest,
} from "@mirattic/types";

/** Where the refresh token lives (the extension's storage). */
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

const REQUEST_TIMEOUT_MS = 15_000;

export type ApiClient = ReturnType<typeof createApi>;

/**
 * The browser part of a Mirattic account sign-in (extension: chrome.identity.launchWebAuthFlow through the server's
 * /auth/start). Resolves to the one-time handoff code and the PKCE verifier of the challenge it sent. `reauth` asks
 * for the password again even inside a Mirattic session (before deleting the account).
 */
export type Authorize = (opts?: { reauth?: boolean }) => Promise<{ code: string; verifier: string }>;

export function createApi(opts: { baseUrl: string; store: RefreshTokenStore; fetch?: typeof fetch; authorize?: Authorize }) {
  const doFetch = opts.fetch ?? fetch.bind(globalThis);
  let accessToken: string | null = null;
  // Single in-flight refresh: two concurrent refreshes with one token would trip server reuse detection.
  let refreshing: Promise<boolean> | null = null;
  // Bumped by sign-in and sign-out: a refresh that answers after one of them belongs to an older
  // session and must not bring its tokens back.
  let session = 0;

  /** `timed`: given up after REQUEST_TIMEOUT_MS (a stalled server or network) instead of waiting minutes. */
  async function send(method: string, path: string, body: unknown, token: string | null, timed = false) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return doFetch(opts.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timed ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
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
  const authorize: Authorize = (o) => {
    if (!opts.authorize) throw new ApiError(400, "Mirattic sign-in is not available here");
    return opts.authorize(o);
  };
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

  /**
   * `timed`: given up after REQUEST_TIMEOUT_MS — reads only, which can be asked again. A change waits: given up after
   * the server made it, it would look failed and a retry would make it twice (a second room). Neither are a refresh or
   * sign-in (their tokens would be lost: a refresh rotates the stored one, so the next fails and signs out), nor `me`
   * (signing in waits on it: a timeout would show the sign-in screen and leave the worker without its socket).
   */
  async function authed<T>(method: string, path: string, body?: unknown, timed = method === "GET"): Promise<T> {
    if (!accessToken && !(await refresh())) throw new ApiError(401, "not signed in");
    let res = await send(method, path, body, accessToken, timed);
    if (res.status === 401 && (await refresh())) res = await send(method, path, body, accessToken, timed);
    return parse<T>(res);
  }

  return {
    /** Resume a session from the stored refresh token. */
    restore: refresh,

    /** Sign in (or sign up) with a Mirattic account. */
    async loginWithMirattic(): Promise<UserSummary> {
      const { code, verifier } = await authorize();
      return adopt(await parse<AuthTokens>(await send("POST", "/api/auth/handoff", { code, verifier }, null)));
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

    me: () => authed<Me>("GET", "/api/me", undefined, false),
    /** Only the settings given change (one at a time: two quick changes don't undo each other). */
    updatePrivacy: (changes: Partial<Pick<Me, "presenceVisibility" | "positionVisibility" | "friendCodeOnly">>) =>
      authed<Me>("PUT", "/api/me/privacy", changes),
    /**
     * Deletes my Sync profile and all its data after the Mirattic password is typed again (a re-auth window).
     * 403 if that sign-in isn't this account's or isn't fresh. Sign out locally afterwards.
     */
    async deleteAccount(): Promise<void> {
      const { code, verifier } = await authorize({ reauth: true });
      return authed<void>("DELETE", "/api/me", { code, verifier });
    },
    /** Invalidates the current friend code and returns the updated profile. */

    friends: () => authed<FriendView[]>("GET", "/api/friends"),
    friendRequests: () => authed<FriendRequests>("GET", "/api/friends/requests"),
    /** Accepts codes as typed ("k7qm-4xpr"). Resolves to the user the request went to; 404 if no such code. */
    sendFriendRequest: (friendCode: string) =>
      authed<UserSummary>("POST", "/api/friends/requests", { friendCode }),
    /** To a member of a room I'm in, no code needed; 404 for anyone else. */
    sendFriendRequestTo: (userId: string) => authed<UserSummary>("POST", `/api/friends/requests/users/${userId}`),
    acceptFriendRequest: (id: string) => authed<void>("POST", `/api/friends/requests/${id}/accept`),
    deleteFriendRequest: (id: string) => authed<void>("DELETE", `/api/friends/requests/${id}`),
    removeFriend: (userId: string) => authed<void>("DELETE", `/api/friends/${userId}`),

    blocked: () => authed<UserSummary[]>("GET", "/api/blocks"),
    block: (userId: string) => authed<void>("PUT", `/api/blocks/${userId}`),
    unblock: (userId: string) => authed<void>("DELETE", `/api/blocks/${userId}`),

    /** Host only: the room's type (decision 93); the members get `room:type`. */
    setRoomType: (id: string, type: MediaProvider) => authed<void>("PUT", `/api/rooms/${id}/type`, { type }),
    /** A member confirmed the room's type change up to `version`: not asked again. */
    seeRoomType: (id: string, version: number) => authed<void>("POST", `/api/rooms/${id}/type/seen`, { version }),
    /** Creates a room you host (`content` null: no video yet); invitees must be friends and get `room:invite`. */
    createRoom: (content: RoomContent | null, inviteIds: string[]) =>
      authed<RoomView>("POST", "/api/rooms", { content, inviteIds }),
    /** Host only: adds friends to an existing room; they get `room:invite`. */
    inviteToRoom: (id: string, userIds: string[]) => authed<RoomView>("POST", `/api/rooms/${id}/invites`, { userIds }),
    /** The rooms inviting me (decision 85): accepting makes me a member. */
    invitations: () => authed<RoomView[]>("GET", "/api/rooms/invitations"),
    /** 404 no invitation (withdrawn, room closed), 409 room full (still invited). */
    acceptInvitation: (id: string) => authed<RoomView>("POST", `/api/rooms/${id}/invitation`),
    declineInvitation: (id: string) => authed<void>("DELETE", `/api/rooms/${id}/invitation`),
    /** Host only (decision 79): removes a member, who can't come back by the room's code until invited. */
    kickMember: (id: string, userId: string) => authed<void>("DELETE", `/api/rooms/${id}/members/${encodeURIComponent(userId)}`),
    /** Host only (decision 79): makes another member the host. */
    makeHost: (id: string, userId: string) => authed<void>("POST", `/api/rooms/${id}/host`, { userId }),
    /** Asks an online friend to watch together; they get `watch:request`. 409 offline, 429 asked recently. */
    requestWatch: (friendId: string) =>
      authed<{ askedAt?: number } | undefined>("POST", "/api/rooms/requests", { friendId }), // older servers: no body
    /** The friends I asked to watch together and still wait for (closed by their invite or my cancel). */
    openWatchRequests: () => authed<string[]>("GET", "/api/rooms/requests"),
    /** The same, each with its time left (decision 87). */
    outgoingWatchRequests: () =>
      authed<{ friendId: string; expiresInMs: number; askedAt?: number }[]>("GET", "/api/rooms/requests/outgoing"),
    /** Takes a watch request back; the friend gets `watch:cancel`. 404 if not a friend. */
    cancelWatchRequest: (friendId: string) => authed<void>("DELETE", `/api/rooms/requests/${friendId}`),
    /** Friends' watch requests to me still open (a panel opened after the `watch:request` shows them). */
    incomingWatchRequests: () => authed<IncomingRequest[]>("GET", "/api/rooms/requests/incoming"),
    /** Dismisses a friend's watch request to me: it doesn't come back. The friend isn't told. */
    dismissWatchRequest: (friendId: string) => authed<void>("DELETE", `/api/rooms/requests/incoming/${friendId}`),
    rooms: () => authed<RoomView[]>("GET", "/api/rooms"),
    /** Joins by a room code, typed as-is ("abcd-2345"). 404 unknown, 409 full, 429 too many tries. */
    joinRoomByCode: (code: string) => authed<RoomView>("POST", "/api/rooms/join", { code }),
    /** 404 once the room is closed or you left it. */
    room: (id: string) => authed<RoomView>("GET", `/api/rooms/${id}`),
    /** Leave or decline. The host leaving closes the room. */
    /** `asMember`: only as a member — 409 if I host it by now (it isn't closed then). */
    leaveRoom: (id: string, asMember = false) => authed<void>("DELETE", `/api/rooms/${id}/members/me${asMember ? "?asMember=true" : ""}`),
    /**
     * Back from the room screen (decision 90): the host's closes the room (`closed`) once `confirmed` (409 before),
     * a member's does nothing.
     */
    backFromRoom: (id: string, confirmed: boolean) =>
      authed<{ closed: boolean }>("POST", `/api/rooms/${id}/back`, { confirmed }),
    /** 100 chat messages, oldest first: the latest, or those before message `before`. New ones arrive as `chat:message`. */
    messages: (id: string, before?: string) =>
      authed<ChatMessage[]>("GET", `/api/rooms/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`),
    /** Author or host. Every member gets `chat:delete`. */
    deleteMessage: (roomId: string, messageId: string) => authed<void>("DELETE", `/api/rooms/${roomId}/messages/${messageId}`),
    /** A message, or a friend / room member / blocked user. 429 after 20 a day. */
    report: (target: ReportTarget, reason: ReportReason, detail?: string) =>
      authed<void>("POST", "/api/reports", { ...target, reason, detail }),
    /** Feedback or a bug report (Settings), kept for operators. 429 after 10 a day. */
    feedback: (kind: "FEEDBACK" | "BUG", text: string) => authed<void>("POST", "/api/feedback", { kind, text }),
    /** My chat notifications for the room. */

    wsTicket: () => authed<{ ticket: string }>("POST", "/api/ws-ticket").then((r) => r.ticket),
  };
}

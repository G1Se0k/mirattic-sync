// Invitation links (plan.md decision 113): the server's page at /r/<code> hands the room code to the background
// (externally_connectable, that origin only), which opens the side panel — while the click still counts as the user's
// gesture — and, once it is open, leaves the code in storage.session. The panel takes it and joins as 코드로 입장
// does, once signed in. Each invitation has an id; a panel marks the one it took under a key of that id instead of
// removing the invitation, so a newer one stored meanwhile is never lost.

export const INVITE_KEY = 'mirattic.invite';
/** Prefix of the marker a panel leaves for the invitation it took: one key per invitation, so no take undoes another. */
export const INVITE_TAKEN_KEY = 'mirattic.inviteTaken';
export const takenKey = (id: string) => `${INVITE_TAKEN_KEY}:${id}`;
export const INVITE_MESSAGE = 'mirattic:invite';
/** The page asks whether this extension is here (an older one, without the link, doesn't answer). */
export const INVITE_PING = 'mirattic:ping';
/** A code left longer than this (the panel not opened, or not signed in meanwhile) isn't joined. */
export const INVITE_TTL_MS = 10 * 60_000;

/** A room code (FriendCode's alphabet: no 0, 1, I, L, O). */
const CODE = /^[2-9A-HJKMNP-Z]{8}$/;

/** `windowId`: the window it was accepted in — only that window's panel takes it (others may be closing). */
export type Invitation = { code: string; id: string; at: number; windowId: number };

/** The code of an invitation message from the page, or null. */
export function inviteCode(m: unknown): string | null {
  const code = (m as { type?: unknown; code?: unknown } | null)?.type === INVITE_MESSAGE ? (m as { code: unknown }).code : null;
  return typeof code === 'string' && CODE.test(code) ? code : null;
}

/** The invitation still waiting in storage, or null (none, taken, or left too long). `taken`: its marker's value. */
export function pendingInvite(stored: unknown, taken: unknown, now: number): Invitation | null {
  const s = stored as Partial<Invitation> | null | undefined;
  if (typeof s?.code !== 'string' || !CODE.test(s.code) || typeof s.id !== 'string' || typeof s.at !== 'number'
    || typeof s.windowId !== 'number') return null;
  return !taken && now - s.at < INVITE_TTL_MS ? { code: s.code, id: s.id, at: s.at, windowId: s.windowId } : null;
}

/**
 * Acceptances, in the order they arrive: each opens the panel, then stores its code — writes one at a time, each
 * checked as it starts, so only the last accepted is ever left (opens and writes can end in any order). An earlier
 * one passed over answers false, so its page offers to accept again.
 */
export function acceptances(): (open: () => Promise<unknown>, store: () => Promise<unknown>) => Promise<boolean> {
  let last = 0;
  let writes: Promise<unknown> = Promise.resolve();
  return async (open, store) => {
    const n = ++last;
    await open();
    const write = writes.then(async () => {
      if (n !== last) return false;
      await store();
      return true;
    });
    writes = write.catch(() => undefined);
    return write;
  };
}

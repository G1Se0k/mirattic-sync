import { describe, expect, it } from 'vitest';
import { INVITE_MESSAGE, INVITE_TTL_MS, acceptances, inviteCode, pendingInvite } from './invite';

describe('invitation links', () => {
  it('takes only a well-formed code from the page', () => {
    expect(inviteCode({ type: INVITE_MESSAGE, code: 'K7QM4XPR' })).toBe('K7QM4XPR');
    for (const bad of [null, {}, { type: 'other', code: 'K7QM4XPR' }, { type: INVITE_MESSAGE, code: 'k7qm4xpr' },
      { type: INVITE_MESSAGE, code: 'K7QM-4XPR' }, { type: INVITE_MESSAGE, code: 'K7QM4XP0' }, { type: INVITE_MESSAGE, code: 7 }]) {
      expect(inviteCode(bad)).toBeNull();
    }
  });

  it('joins a stored invitation only while it is fresh', () => {
    const stored = { code: 'K7QM4XPR', id: 'a', at: 1000, windowId: 7 };
    expect(pendingInvite(stored, undefined, 1000 + INVITE_TTL_MS - 1)).toEqual(stored);
    expect(pendingInvite(stored, undefined, 1000 + INVITE_TTL_MS)).toBeNull();
    expect(pendingInvite(undefined, undefined, 0)).toBeNull();
    expect(pendingInvite({ code: 'K7QM4XPR', at: 1000, windowId: 7 }, undefined, 1000)).toBeNull(); // no id
    expect(pendingInvite({ code: 'K7QM4XPR', id: 'a', at: 1000 }, undefined, 1000)).toBeNull(); // no window
  });

  it('a taken invitation is done, a newer one stored after it still waits', () => {
    const first = { code: 'K7QM4XPR', id: 'a', at: 1000, windowId: 7 };
    const second = { code: 'ZZZZ2222', id: 'b', at: 1001, windowId: 7 };
    expect(pendingInvite(first, true, 1001)).toBeNull();
    expect(pendingInvite(second, undefined, 1002)).toEqual(second); // its own marker: the older take doesn't hide it
  });

  it('leaves only the last accepted, whatever order opens and writes end in', async () => {
    const later = () => { let done!: () => void; const p = new Promise<void>((r) => (done = r)); return { p, done }; };
    const tick = () => new Promise((r) => setTimeout(r));
    const stored: string[] = [];

    // A's open ends after B's: A is passed over (false), B stored.
    let accept = acceptances();
    const openA = later(), openB = later();
    const a = accept(() => openA.p, async () => void stored.push('A'));
    const b = accept(() => openB.p, async () => void stored.push('B'));
    openB.done(); openA.done();
    expect(await Promise.all([a, b])).toEqual([false, true]);
    expect(stored).toEqual(['B']);

    // A's write still running when B is accepted: B's write waits for it, so B is left last.
    accept = acceptances(); stored.length = 0;
    const writeA = later();
    const c = accept(async () => {}, async () => { await writeA.p; stored.push('A'); });
    await tick();
    const d = accept(async () => {}, async () => void stored.push('B'));
    await tick();
    writeA.done();
    expect(await Promise.all([c, d])).toEqual([true, true]);
    expect(stored).toEqual(['A', 'B']);

    // B's open fails: B fails, and A (passed over) says so too, so both pages offer to accept again.
    accept = acceptances(); stored.length = 0;
    const openC = later();
    const e = accept(() => openC.p, async () => void stored.push('A'));
    const f = accept(() => Promise.reject(new Error('no gesture')), async () => void stored.push('B'));
    await expect(f).rejects.toThrow();
    openC.done();
    expect(await e).toBe(false);
    expect(stored).toEqual([]);
  });
});

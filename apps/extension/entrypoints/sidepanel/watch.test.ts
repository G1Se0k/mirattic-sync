import { beforeEach, describe, expect, it, vi } from 'vitest';

// A controllable stand-in for the Chrome APIs watch() uses: lookups can be held back to replay races.
type Tab = { id: number; url: string; active: boolean; windowId: number };
type Listener = (...args: any[]) => unknown;

const hold = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

let tabs: Tab[];
let granted: Set<string>; // optional host permissions the user gave
let connects: number[];
let listeners: Record<string, Listener[]>;
/** When set, the next matching call waits for this instead of answering at once. */
let heldQuery: ReturnType<typeof hold<void>> | null;
let heldGet: Map<number, ReturnType<typeof hold<void>>>;
let heldInject: ReturnType<typeof hold<void>> | null;

const on = (name: string) => ({ addListener: (l: Listener) => void (listeners[name] ??= []).push(l) });
const fire = (name: string, ...args: unknown[]) => Promise.all((listeners[name] ?? []).map((l) => l(...args)));
const settle = () => new Promise((r) => setTimeout(r, 0));

vi.mock('wxt/browser', () => ({
  browser: {
    windows: { getCurrent: async () => ({ id: 1 }) },
    permissions: {
      contains: async (q: { origins: string[] }) => q.origins.every((o) => granted.has(o)),
      onAdded: on('permissions.onAdded'),
      onRemoved: on('permissions.onRemoved'),
    },
    scripting: {
      executeScript: async () => {
        const h = heldInject;
        heldInject = null;
        await h?.promise;
        return [{}];
      },
    },
    tabs: {
      query: async (q: { active?: boolean; url?: string[] }) => {
        const matches = (t: Tab) =>
          q.active ? t.active : (q.url ?? []).some((u) => t.url.startsWith(u.replace('*', '')));
        const snapshot = tabs.filter(matches).map((t) => ({ ...t }));
        // Hold the second lookup of a pick(): it has already decided on the active tab by then.
        if (!q.active && heldQuery) {
          const h = heldQuery;
          heldQuery = null;
          await h.promise;
        }
        return snapshot;
      },
      get: async (id: number) => {
        const snapshot = { ...tabs.find((t) => t.id === id)! };
        await heldGet.get(id)?.promise;
        return snapshot;
      },
      connect: (id: number) => {
        connects.push(id);
        return {
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
          postMessage() {},
          disconnect() {},
        };
      },
      onActivated: on('tabs.onActivated'),
      onUpdated: on('tabs.onUpdated'),
      onRemoved: on('tabs.onRemoved'),
    },
  },
}));

const { watch } = await import('./watch');

const YT = (id: number, active = false): Tab => ({ id, url: `https://www.youtube.com/watch?v=${'a'.repeat(10)}${id}`, active, windowId: 1 });
const NF = (id: number, active = false): Tab => ({ id, url: `https://www.netflix.com/watch/8123456${id}`, active, windowId: 1 });
const LAFTEL = (id: number, active = false): Tab => ({ id, url: `https://laftel.net/player/40522/4052${id}`, active, windowId: 1 });
const OTHER = (id: number, active = false): Tab => ({ id, url: 'https://example.com/', active, windowId: 1 });
const activate = (id: number) => {
  for (const t of tabs) t.active = t.id === id;
};
const followed = () => connects.at(-1);

beforeEach(() => {
  tabs = [];
  granted = new Set(['https://www.netflix.com/*']);
  connects = [];
  listeners = {};
  heldQuery = null;
  heldGet = new Map();
  heldInject = null;
});

describe('watch: which tab the side panel follows', () => {
  it('a tab that finishes loading beats a slower pick() that started earlier', async () => {
    tabs = [YT(1, true), OTHER(2)];
    heldQuery = hold();
    const release = heldQuery;
    const started = watch();
    await settle(); // pick() saw YouTube tab 1 active and waits on its second lookup

    activate(2); // a non-video tab: not a choice
    await fire('tabs.onActivated', { tabId: 2, windowId: 1 });
    expect(connects).toEqual([]);
    tabs[1] = NF(2, true); // then the user opens Netflix in it
    await fire('tabs.onUpdated', 2, { status: 'complete' }, tabs[1]);
    await settle(); // the listener doesn't await its bind (the Netflix injection)
    expect(followed()).toBe(2);

    release.resolve();
    await started;
    await settle();
    expect(followed()).toBe(2);
  });

  it('a video tab activated during a slower pick() wins', async () => {
    tabs = [YT(1, true), YT(2)];
    heldQuery = hold();
    const release = heldQuery;
    const started = watch();
    await settle();

    activate(2);
    await fire('tabs.onActivated', { tabId: 2, windowId: 1 });
    release.resolve();
    await started;
    await settle();
    expect(followed()).toBe(2);
  });

  it('a late lookup for a tab the user already left does not take over', async () => {
    tabs = [OTHER(9, true), YT(1), YT(2)];
    await watch();
    connects = [];

    const slowA = hold<void>();
    heldGet.set(1, slowA);
    activate(1);
    const first = fire('tabs.onActivated', { tabId: 1, windowId: 1 });
    activate(2);
    await fire('tabs.onActivated', { tabId: 2, windowId: 1 });
    slowA.resolve();
    await first;
    expect(connects).toEqual([2]);
  });

  it.each([
    ['Netflix', NF, 'https://www.netflix.com/*'],
    ['Laftel', LAFTEL, 'https://laftel.net/*'],
  ] as const)('never connects to %s when it is turned off while the script is being injected', async (_, tab, origin) => {
    granted.add(origin);
    tabs = [tab(1, true)];
    heldInject = hold();
    const release = heldInject;
    const started = watch();
    await settle();

    granted.delete(origin);
    await fire('permissions.onRemoved');
    await settle();
    release.resolve();
    await started;
    await settle();
    expect(connects).toEqual([]);
  });

  it('closing the followed tab hands over even though Chrome activates a non-video neighbour', async () => {
    tabs = [YT(1, true), OTHER(2), YT(3)];
    await watch();
    expect(followed()).toBe(1);

    tabs = tabs.filter((t) => t.id !== 1);
    activate(2);
    await Promise.all([fire('tabs.onRemoved', 1), fire('tabs.onActivated', { tabId: 2, windowId: 1 })]);
    await settle();
    expect(followed()).toBe(3);
  });

  it('follows a Laftel tab only while Laftel is turned on, independently of Netflix', async () => {
    tabs = [LAFTEL(1, true), NF(2)];
    await watch();
    expect(followed()).toBe(2); // Netflix is on, Laftel isn't: the active Laftel tab is invisible

    granted.add('https://laftel.net/*');
    await fire('permissions.onAdded');
    await settle();
    expect(followed()).toBe(1);

    connects = [];
    granted.delete('https://www.netflix.com/*'); // turning Netflix off leaves the Laftel tab alone
    await fire('permissions.onRemoved');
    await settle();
    expect(connects).toEqual([]);
  });
});

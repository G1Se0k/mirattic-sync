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
let session: Record<string, unknown>; // storage.session: survives a worker restart, not the browser
let stored: Record<string, unknown>; // storage.local: which experimental controls are on, settings
let connects: number[];
let listeners: Record<string, Listener[]>;
/** When set, the next matching call waits for this instead of answering at once. */
let heldQuery: ReturnType<typeof hold<void>> | null;
let heldGet: Map<number, ReturnType<typeof hold<void>>>;
let heldInject: ReturnType<typeof hold<void>> | null;
let injected: string[][]; // files injected per call
let dropConnection: (() => void) | null; // closes the latest port, as a tab without a live script does

const on = (name: string) => ({ addListener: (l: Listener) => void (listeners[name] ??= []).push(l) });
const fire = (name: string, ...args: unknown[]) => Promise.all((listeners[name] ?? []).map((l) => l(...args)));
const settle = () => new Promise((r) => setTimeout(r, 0));

vi.mock('wxt/browser', () => ({
  browser: {
    windows: { getCurrent: async () => ({ id: 1 }) },
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
        set: async (values: Record<string, unknown>) => {
          const changes = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { oldValue: stored[k], newValue: v }]));
          Object.assign(stored, values);
          await fire('storage.onChanged', changes, 'local');
        },
      },
      onChanged: on('storage.onChanged'),
      session: {
        get: async (key: string) => (key in session ? { [key]: session[key] } : {}),
        set: async (values: Record<string, unknown>) => void Object.assign(session, values),
      },
    },
    scripting: {
      executeScript: async (q: { files?: string[] }) => {
        injected.push(q.files ?? []);
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
          onDisconnect: { addListener: (l: () => void) => void (dropConnection = l) },
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
  stored = { 'mirattic.experiment.netflix': true };
  session = {};
  connects = [];
  listeners = {};
  heldQuery = null;
  heldGet = new Map();
  heldInject = null;
  injected = [];
  dropConnection = null;
});

describe('watch: a YouTube tab without a live script', () => {
  it('gets the script again once, then is connected again', async () => {
    tabs = [YT(1, true)];
    await watch();
    expect(connects).toEqual([1]);
    dropConnection!(); // closed before saying anything: opened before the extension was updated
    await settle();
    expect(injected).toEqual([['/content-scripts/youtube.js']]);
    expect(connects).toEqual([1, 1]);
    dropConnection!(); // still nothing: not again until the page loads anew
    await settle();
    expect(injected).toHaveLength(1);
    await fire('tabs.onUpdated', 1, { status: 'complete' }, tabs[0]);
    await settle();
    expect(connects).toEqual([1, 1, 1]);
  });
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
    ['Netflix', NF, 'netflix'],
    ['Laftel', LAFTEL, 'laftel'],
  ] as const)('never connects to %s when it is turned off while the script is being injected', async (_, tab, provider) => {
    stored[`mirattic.experiment.${provider}`] = true;
    const platform = await watch();
    tabs = [tab(1, true)];
    heldInject = hold();
    const release = heldInject;
    const activated = fire('tabs.onActivated', { tabId: 1, windowId: 1 }); // waits on the held injection
    await settle();

    await platform.experimental!.setEnabled(provider, false);
    await settle();
    release.resolve();
    await activated;
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
    const platform = await watch();
    expect(followed()).toBe(2); // Netflix is on, Laftel isn't: the active Laftel tab isn't followed
    const first = platform.offSite?.();
    expect(first?.provider).toBe('laftel'); // but seen, to offer turning it on
    tabs.push(LAFTEL(3));
    activate(3); // another Laftel tab: a new arrival, asked about again
    await fire('tabs.onActivated', { tabId: 3, windowId: 1 });
    await settle();
    expect(platform.offSite?.()?.provider).toBe('laftel');
    expect(platform.offSite?.()?.visit).toBeGreaterThan(first!.visit);
    activate(1);
    await fire('tabs.onActivated', { tabId: 1, windowId: 1 });
    await settle();

    await platform.experimental!.setEnabled('laftel', true);
    await settle();
    expect(followed()).toBe(1);
    expect(stored['mirattic.experiment.laftel']).toBe(true); // kept for the next start

    connects = [];
    await platform.experimental!.setEnabled('netflix', false); // turning Netflix off leaves the Laftel tab alone
    await settle();
    expect(connects).toEqual([]);

    // Written by the side panel straight to storage: applied from storage.onChanged.
    stored['mirattic.experiment.netflix'] = true;
    await fire('storage.onChanged', { 'mirattic.experiment.netflix': { newValue: true } }, 'local');
    await settle();
    expect(platform.experimental!.enabled('netflix')).toBe(true);
    await fire('storage.onChanged', { 'mirattic.askOnSwitch': { newValue: false } }, 'local');
    expect(platform.preferences!.askOnSwitch()).toBe(false);
  });

  it('keeps an arrival across a service worker restart while the user stays on that tab', async () => {
    tabs = [LAFTEL(1, true)];
    const platform = await watch();
    const arrival = platform.offSite?.();
    expect(arrival?.provider).toBe('laftel');
    listeners = {};
    const restarted = await watch(); // storage.session survives; the panel's dismissal of this arrival holds
    expect(restarted.offSite?.()).toEqual(arrival);
  });
});

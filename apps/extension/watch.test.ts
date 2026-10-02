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
let injectFails = false; // a page we have no access to
let disconnects: number[]; // ports we closed, by tab

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
        if (injectFails) throw new Error('Cannot access contents of the page');
        injected.push(q.files ?? []);
        const h = heldInject;
        heldInject = null;
        await h?.promise;
        return [{}];
      },
    },
    tabs: {
      query: async (q: { active?: boolean; url?: string[]; windowId?: number }) => {
        const matches = (t: Tab) =>
          (q.windowId === undefined || t.windowId === q.windowId)
          && (q.active ? t.active : !q.url || q.url.some((u) => t.url.startsWith(u.replace('*', ''))));
        const snapshot = tabs.filter(matches).map((t) => ({ ...t }));
        // Hold the second lookup of a pick(): it has already decided on the active tab by then.
        if (!q.active && q.url && heldQuery) { // not the tab list (no URL filter)
          const h = heldQuery;
          heldQuery = null;
          await h.promise;
        }
        return snapshot;
      },
      get: async (id: number) => {
        const found = tabs.find((t) => t.id === id);
        if (!found) throw new Error(`No tab with id: ${id}.`);
        const snapshot = { ...found };
        await heldGet.get(id)?.promise;
        return snapshot;
      },
      connect: (id: number) => {
        connects.push(id);
        return {
          onMessage: { addListener() {} },
          onDisconnect: { addListener: (l: () => void) => void (dropConnection = l) },
          postMessage() {},
          disconnect() {
            disconnects.push(id);
          },
        };
      },
      onActivated: on('tabs.onActivated'),
      onUpdated: on('tabs.onUpdated'),
      onRemoved: on('tabs.onRemoved'),
      onAttached: on('tabs.onAttached'),
      onDetached: on('tabs.onDetached'),
      update: async () => { throw new Error('no such tab'); },
      create: async () => (globalThis as any).__created,
    },
  },
}));

const { watch, samePage } = await import('./watch');

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
  stored = { 'mirattic.experiment.netflix': true, 'mirattic.followActive': true }; // the active tab (fixed: below)
  session = {};
  connects = [];
  listeners = {};
  heldQuery = null;
  heldGet = new Map();
  heldInject = null;
  injected = [];
  dropConnection = null;
  injectFails = false;
  disconnects = [];
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

it("tells the same video page apart from another one", () => {
  const same = (a: string, b: string) => samePage(new URL(a), new URL(b));
  expect(same("https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=70s", "https://www.youtube.com/watch?v=aqz-KE-bpKQ")).toBe(true);
  expect(same("https://www.youtube.com/watch?v=aaaaaaaaaaa", "https://www.youtube.com/watch?v=aqz-KE-bpKQ")).toBe(false);
  expect(same("https://www.netflix.com/watch/81234567?trackId=1", "https://www.netflix.com/watch/81234567")).toBe(true);
  expect(same("https://www.netflix.com/watch/81234568", "https://www.netflix.com/watch/81234567")).toBe(false);
  expect(same("https://laftel.net/player/40123/40456/", "https://laftel.net/player/40123/40456")).toBe(true);
});

describe('watch: one chosen tab (follow-the-active-tab off)', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('keeps its tab when another video tab is activated, until the user chooses another', async () => {
    tabs = [YT(1, true), YT(2), OTHER(3)];
    const w = await watch();
    expect(followed()).toBe(1);
    activate(2);
    await fire('tabs.onActivated', { tabId: 2, windowId: 1 });
    await fire('tabs.onUpdated', 2, { status: 'complete' }, tabs[1]);
    expect(followed()).toBe(1);
    expect(w.tabs!.list().map((t) => t.id)).toEqual([1, 2]); // video tabs only

    await w.tabs!.choose(2);
    expect(followed()).toBe(2);
    expect(w.tabs!.followed()).toBe(2);

    await w.tabs!.choose(null); // follow the active one again
    activate(1);
    await fire('tabs.onActivated', { tabId: 1, windowId: 1 });
    expect(followed()).toBe(1);
    expect(stored['mirattic.followActive']).toBe(true);
  });

  it('another tab takes over when the chosen one closes; a worker restart keeps the chosen one', async () => {
    tabs = [YT(1, true), YT(2), YT(3)];
    const w = await watch();
    await w.tabs!.choose(3);
    connects = [];
    await watch(); // a restarted worker
    expect(followed()).toBe(3);

    tabs = tabs.filter((t) => t.id !== 3);
    await fire('tabs.onRemoved', 3);
    await settle();
    expect(followed()).toBe(1);
  });
});

it('fixed: a pick still looking up tabs does not replace a tab the room video was just opened in', async () => {
  delete stored['mirattic.followActive'];
  tabs = [YT(1, true), YT(2)];
  const w = await watch();
  heldQuery = hold();
  const release = heldQuery;
  tabs = tabs.filter((t) => t.id !== 1);
  const removed = fire('tabs.onRemoved', 1); // pick() waits on its lookup
  await settle();
  const opened = { id: 5, url: '', pendingUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaa5', active: true, windowId: 1, status: 'loading' };
  tabs.push(opened as Tab);
  (globalThis as any).__created = opened;
  w.open('https://www.youtube.com/watch?v=aaaaaaaaaa5', true);
  await settle();
  release.resolve();
  await removed;
  await settle();
  expect(w.tabs!.followed()).toBe(5);
  expect(session['mirattic.followedTab']).toBe(5); // kept for a restart while still loading
  opened.url = opened.pendingUrl; opened.status = 'complete';
  await fire('tabs.onUpdated', 5, { status: 'complete' }, opened);
  expect(followed()).toBe(5);
});

describe('watch: one chosen tab, races', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('the last choice wins even if an earlier one is looked up later', async () => {
    tabs = [YT(1, true), YT(2), YT(3)];
    const w = await watch();
    heldGet.set(2, hold());
    const slow = w.tabs!.choose(2);
    await w.tabs!.choose(3);
    heldGet.get(2)!.resolve();
    await slow;
    expect(w.tabs!.followed()).toBe(3);
    expect(followed()).toBe(3);
  });

  it('a chosen tab moving on to another enabled video site stays chosen', async () => {
    tabs = [YT(1), YT(2, true)];
    const w = await watch();
    await w.tabs!.choose(1); // not the active one
    const nf = NF(1);
    tabs[0] = nf;
    await fire('tabs.onUpdated', 1, { url: nf.url }, nf);
    await fire('tabs.onUpdated', 1, { status: 'complete' }, nf);
    await settle();
    expect(w.tabs!.followed()).toBe(1);
    expect(followed()).toBe(1);
  });

  it('turning a site off while its script goes into the chosen tab lets another tab take over', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [YT(1, true), LAFTEL(2)];
    const w = await watch();
    heldInject = hold();
    const injecting = heldInject;
    const choosing = w.tabs!.choose(2);
    await settle();
    await w.experimental!.setEnabled('laftel', false);
    injecting.resolve();
    await choosing;
    await settle();
    expect(w.tabs!.followed()).toBe(1);
    expect(followed()).toBe(1);
  });
});

describe('watch: one chosen tab, more races', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('a chosen tab stays chosen when its video is gone, and is followed again back on a video site', async () => {
    tabs = [YT(1), YT(2, true)];
    const w = await watch();
    await w.tabs!.choose(1);
    const other = OTHER(1);
    tabs[0] = other;
    await fire('tabs.onUpdated', 1, { url: other.url }, other);
    injectFails = true; // not a video site: no script there
    dropConnection!(); // the page's script went with it
    await settle();
    injectFails = false;
    await fire('tabs.onActivated', { tabId: 2, windowId: 1 });
    await fire('tabs.onUpdated', 2, { status: 'complete' }, tabs[1]);
    await settle();
    expect(w.tabs!.followed()).toBe(1);
    expect(followed()).toBe(1);
    connects = [];
    const back = YT(1);
    tabs[0] = back;
    await fire('tabs.onUpdated', 1, { url: back.url }, back);
    await fire('tabs.onUpdated', 1, { status: 'complete' }, back);
    expect(followed()).toBe(1);
  });

  it('a tab the room video opened in that finished loading before it was taken is bound', async () => {
    tabs = [YT(1, true)];
    const w = await watch();
    const opened = { ...YT(5, true), status: 'complete' };
    tabs.push(opened);
    (globalThis as any).__created = { ...opened, status: 'loading' }; // as create() reported it
    await fire('tabs.onUpdated', 5, { status: 'complete' }, opened); // before take(): another tab was chosen
    w.open(opened.url, true);
    await settle();
    await settle();
    expect(w.tabs!.followed()).toBe(5);
    expect(followed()).toBe(5);
  });

  it('an activation looked up while auto doesn\'t override a tab chosen meanwhile', async () => {
    stored['mirattic.followActive'] = true;
    tabs = [YT(1, true), YT(2), YT(3)];
    const w = await watch();
    heldGet.set(2, hold());
    activate(2);
    const activated = fire('tabs.onActivated', { tabId: 2, windowId: 1 });
    await settle();
    await w.tabs!.choose(3);
    heldGet.get(2)!.resolve();
    await activated;
    expect(followed()).toBe(3);
  });

  it('turning off another site while the chosen tab\'s script goes in keeps the choice', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [NF(1), LAFTEL(2), YT(3, true)];
    const w = await watch();
    await w.tabs!.choose(1);
    expect(followed()).toBe(1);
    heldInject = hold();
    const injecting = heldInject;
    const choosing = w.tabs!.choose(2);
    await settle();
    await w.experimental!.setEnabled('netflix', false);
    injecting.resolve();
    await choosing;
    await settle();
    expect(w.tabs!.followed()).toBe(2);
    expect(followed()).toBe(2);
  });
});

describe('watch: one chosen tab, the user\'s choice holds', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('the old tab reloading while a choice is looked up doesn\'t undo it', async () => {
    tabs = [YT(1, true), YT(2)];
    const w = await watch();
    heldGet.set(2, hold());
    const choosing = w.tabs!.choose(2);
    await settle();
    await fire('tabs.onUpdated', 1, { status: 'complete' }, tabs[0]);
    heldGet.get(2)!.resolve();
    await choosing;
    expect(w.tabs!.followed()).toBe(2);
    expect(followed()).toBe(2);
  });

  it('turning off a site the chosen tab has left keeps it chosen', async () => {
    tabs = [NF(1), YT(2, true)];
    const w = await watch();
    await w.tabs!.choose(1);
    const other = OTHER(1);
    tabs[0] = other;
    await fire('tabs.onUpdated', 1, { url: other.url }, other);
    dropConnection!(); // the page's script went with it
    await w.experimental!.setEnabled('netflix', false);
    await settle();
    expect(w.tabs!.followed()).toBe(1);
  });
});

describe('watch: the user\'s latest say on the tab wins', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('turning a site off forgets its chosen tab across a restart too', async () => {
    tabs = [NF(1), OTHER(2, true)];
    const w = await watch();
    await w.tabs!.choose(1);
    await w.experimental!.setEnabled('netflix', false);
    tabs.push(YT(3, true));
    tabs[1]!.active = false;
    connects = [];
    const again = await watch(); // a restarted worker
    expect(again.tabs!.followed()).toBe(3);
  });

  it('back to automatic while a choice is looked up: the active tab', async () => {
    tabs = [YT(1, true), YT(2)];
    const w = await watch();
    heldGet.set(2, hold());
    const choosing = w.tabs!.choose(2);
    await settle();
    heldQuery = hold(); // pick() of automatic waits on its lookup while the choice's lookup ends
    const release = heldQuery;
    const auto = w.tabs!.choose(null);
    await settle();
    heldGet.get(2)!.resolve();
    await choosing;
    release.resolve();
    await auto;
    await settle();
    expect(w.tabs!.followed()).toBe(1);
    expect(followed()).toBe(1);
  });

  it('a tab closed before the choice arrived: another takes over', async () => {
    tabs = [YT(1, true)];
    const w = await watch();
    await w.tabs!.choose(9); // gone already
    await settle();
    expect(w.tabs!.followed()).toBe(1);
  });

  it('a tab chosen while the room video was still opening stays chosen', async () => {
    tabs = [YT(1, true), YT(2)];
    const w = await watch();
    (globalThis as any).__created = { ...YT(5, true), status: 'complete' };
    tabs.push((globalThis as any).__created);
    w.open('https://www.youtube.com/watch?v=aaaaaaaaaa5', true); // looks up tabs, then creates one
    await w.tabs!.choose(2);
    await settle();
    await settle();
    expect(w.tabs!.followed()).toBe(2);
  });
});

it('back to automatic: the old fixed tab reloading meanwhile doesn\'t keep it', async () => {
  delete stored['mirattic.followActive'];
  tabs = [YT(1, true), YT(2)];
  const w = await watch();
  await w.tabs!.choose(2);
  heldQuery = hold(); // pick() waits on its lookup
  const release = heldQuery;
  const auto = w.tabs!.choose(null);
  await settle();
  injectFails = true; // the reload took its script (and the port) away
  dropConnection!();
  await settle();
  injectFails = false;
  await fire('tabs.onUpdated', 2, { status: 'complete' }, tabs[1]);
  release.resolve();
  await auto;
  await settle();
  expect(w.tabs!.followed()).toBe(1);
  expect(followed()).toBe(1);
});

describe('watch: a choice and its surroundings changing meanwhile', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('a chosen tab whose site is turned off while it is looked up: another takes over', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [YT(1, true), LAFTEL(2)];
    const w = await watch();
    heldGet.set(2, hold());
    const choosing = w.tabs!.choose(2);
    await settle();
    await w.experimental!.setEnabled('laftel', false);
    heldGet.get(2)!.resolve();
    await choosing;
    await settle();
    expect(w.tabs!.followed()).toBe(1);
    expect(session['mirattic.followedTab']).not.toBe(2);
  });

  it('a tab activated while a restarted worker reads its saved tab doesn\'t take its place', async () => {
    tabs = [YT(1), YT(2), YT(3, true)];
    session['mirattic.followedTab'] = 1;
    heldGet.set(1, hold());
    const started = watch();
    await settle();
    await fire('tabs.onActivated', { tabId: 2, windowId: 1 });
    heldGet.get(1)!.resolve();
    const w = await started;
    expect(w.tabs!.followed()).toBe(1);
    expect(followed()).toBe(1);
  });
});

describe('watch: windows and sites of the chosen tab', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('a choice from a panel of another window: that window\'s tabs', async () => {
    tabs = [YT(1, true), { ...YT(5, true), windowId: 2 }, { ...YT(6), windowId: 2 }];
    const w = await watch(); // window 1's panel connected last
    await w.tabs!.choose(null, 2); // window 2's panel: its active tab
    await settle();
    expect(followed()).toBe(5);
    await w.tabs!.choose(6, 2);
    w.follow(1); // window 1's panel opened again meanwhile
    tabs = tabs.filter((t) => t.id !== 6);
    await fire('tabs.onRemoved', 6, { windowId: 2 });
    await settle();
    expect(w.tabs!.followed()).toBe(5); // its own window's tab took over
  });

  it('turning off the site a chosen tab is leaving for another video site keeps it', async () => {
    tabs = [NF(1), YT(2, true)];
    const w = await watch();
    await w.tabs!.choose(1);
    const yt = YT(1);
    tabs[0] = yt;
    await fire('tabs.onUpdated', 1, { url: yt.url }, { ...yt, status: 'loading' }); // still loading
    await w.experimental!.setEnabled('netflix', false);
    await settle();
    expect(w.tabs!.followed()).toBe(1);
  });
});

it('the panel hears at once that the followed tab closed, even with none to take over', async () => {
  delete stored['mirattic.followActive'];
  tabs = [YT(1, true)];
  const w = await watch();
  const other = OTHER(1, true);
  tabs = [other]; // left the video sites first: off the list already
  await fire('tabs.onUpdated', 1, { url: other.url }, other);
  await settle();
  let heard = 0;
  w.subscribe!(() => heard++);
  tabs = [];
  await fire('tabs.onRemoved', 1, { windowId: 1 });
  await settle();
  expect(heard).toBeGreaterThan(0);
  expect(w.tabs!.followed()).toBe(null);
});

describe('watch: tabs across windows', () => {
  it('automatic: a followed tab of a window no longer followed closes: the window followed now takes over', async () => {
    tabs = [{ ...YT(1, true), windowId: 1 }, { ...YT(2), windowId: 1 }, { ...OTHER(3, true), windowId: 2 }];
    const w = await watch(); // automatic (followActive on), window 1
    w.follow(2); // a panel opened in window 2: no video there, tab 1 stays
    await settle();
    expect(followed()).toBe(1);
    tabs[2] = { ...YT(3, true), windowId: 2 };
    tabs = tabs.filter((t) => t.id !== 1);
    await fire('tabs.onRemoved', 1, { windowId: 1 });
    await settle();
    expect(w.tabs!.followed()).toBe(3);
  });

  it('a tab moved to another window is listed there', async () => {
    tabs = [YT(1, true), YT(2)];
    const w = await watch();
    tabs[1] = { ...tabs[1]!, windowId: 2 };
    await fire('tabs.onAttached', 2, { newWindowId: 2 });
    await settle();
    expect(w.tabs!.list().map((t) => [t.id, t.windowId])).toEqual([[1, 1], [2, 2]]);
  });
});

it('fixed: a chosen tab gone to a site turned off is followed once the site is turned on', async () => {
  delete stored['mirattic.followActive'];
  delete stored['mirattic.experiment.netflix'];
  tabs = [YT(1), YT(2, true)];
  const w = await watch();
  await w.tabs!.choose(1);
  const nf = NF(1);
  tabs[0] = nf;
  await fire('tabs.onUpdated', 1, { url: nf.url }, nf);
  injectFails = true; // the YouTube page's script went with it
  dropConnection!();
  await settle();
  injectFails = false;
  await fire('tabs.onUpdated', 1, { status: 'complete' }, nf); // Netflix off: not bound
  connects = [];
  await w.experimental!.setEnabled('netflix', true);
  await settle();
  await settle();
  expect(w.tabs!.followed()).toBe(1);
  expect(followed()).toBe(1);
});

describe('watch: a tab that navigates while it is looked up', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  // The held lookup answers with the tab as it was (before going to Netflix): it must not be bound with that.
  const navigateToNetflix = async (id: number) => {
    const nf = NF(id);
    tabs = tabs.map((t) => (t.id === id ? nf : t));
    await fire('tabs.onUpdated', id, { url: nf.url }, nf);
    await fire('tabs.onUpdated', id, { status: 'complete' }, nf);
    await settle();
  };

  it('a choice', async () => {
    tabs = [YT(1, true), YT(2)];
    const w = await watch();
    heldGet.set(2, hold());
    const choosing = w.tabs!.choose(2);
    await settle();
    await navigateToNetflix(2);
    const bound = connects.length;
    heldGet.get(2)!.resolve();
    heldGet.delete(2);
    await choosing;
    await settle();
    expect(connects.length).toBe(bound); // not bound again with its old YouTube page
    expect(w.tabs!.followed()).toBe(2);
  });

  it('a restored tab', async () => {
    tabs = [YT(1), YT(2, true)];
    session['mirattic.followedTab'] = 1;
    heldGet.set(1, hold());
    const started = watch();
    await settle();
    await navigateToNetflix(1);
    heldGet.get(1)!.resolve();
    heldGet.delete(1);
    const w = await started;
    await settle();
    expect(w.tabs!.followed()).toBe(1);
    expect(injected.at(-1)).toEqual(['/content-scripts/netflix.js']); // bound on Netflix, as it is now
  });
});

describe('watch: replacements read as they are now', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('a replacement that navigated while the tabs were queried is bound as it is now', async () => {
    tabs = [YT(1, true), YT(2)];
    const w = await watch();
    heldQuery = hold();
    const release = heldQuery;
    tabs = tabs.filter((t) => t.id !== 1);
    const removed = fire('tabs.onRemoved', 1, { windowId: 1 });
    await settle(); // the query took its snapshot: tab 2 on YouTube
    const nf = NF(2);
    tabs = [nf];
    await fire('tabs.onUpdated', 2, { url: nf.url }, nf);
    release.resolve();
    await removed;
    await settle();
    await settle();
    expect(w.tabs!.followed()).toBe(2);
    expect(injected.at(-1)).toEqual(['/content-scripts/netflix.js']);
  });

  it('a loaded tab the room video opened in is bound as it is now', async () => {
    tabs = [YT(1, true)];
    const w = await watch();
    (globalThis as any).__created = { ...YT(5, true), status: 'complete' }; // as create() reported it
    const nf = { ...NF(5, true), status: 'complete' };
    tabs.push(nf);
    await fire('tabs.onUpdated', 5, { url: nf.url }, nf); // moved on before take() ran
    w.open('https://www.youtube.com/watch?v=aaaaaaaaaa5', true);
    await settle();
    await settle();
    await settle();
    expect(w.tabs!.followed()).toBe(5);
    expect(injected.at(-1)).toEqual(['/content-scripts/netflix.js']);
  });

  it('a closed fixed tab\'s replacement comes from its window, whatever loads elsewhere meanwhile', async () => {
    tabs = [YT(1, true), { ...YT(5, true), windowId: 2 }, { ...YT(6), windowId: 2 }];
    const w = await watch();
    await w.tabs!.choose(6, 2);
    w.follow(1); // window 1's panel opened again
    heldQuery = hold();
    const release = heldQuery;
    tabs = tabs.filter((t) => t.id !== 6);
    const removed = fire('tabs.onRemoved', 6, { windowId: 2 });
    await settle();
    await fire('tabs.onUpdated', 1, { status: 'complete' }, tabs[0]); // window 1's active video tab loads
    release.resolve();
    await removed;
    await settle();
    await settle();
    expect(w.tabs!.followed()).toBe(5);
  });
});

it('fixed: a tab that becomes a video tab while a closed tab\'s replacement is looked up is followed', async () => {
  delete stored['mirattic.followActive'];
  tabs = [YT(1), OTHER(2, true)];
  const w = await watch();
  expect(followed()).toBe(1);
  heldQuery = hold();
  const release = heldQuery;
  tabs = tabs.filter((t) => t.id !== 1);
  const removed = fire('tabs.onRemoved', 1, { windowId: 1 });
  await settle(); // the lookup saw no video tab
  const yt = YT(2, true);
  tabs = [yt];
  await fire('tabs.onUpdated', 2, { url: yt.url }, yt);
  await fire('tabs.onUpdated', 2, { status: 'complete' }, yt);
  release.resolve();
  await removed;
  for (let i = 0; i < 5; i++) await settle();
  expect(w.tabs!.followed()).toBe(2);
});

it('a replacement candidate gone off the video sites meanwhile: the next one is followed', async () => {
  tabs = [YT(1, true), YT(2), YT(3)]; // automatic
  const w = await watch();
  heldQuery = hold();
  const release = heldQuery;
  tabs = tabs.filter((t) => t.id !== 1);
  const removed = fire('tabs.onRemoved', 1, { windowId: 1 });
  await settle(); // the query saw tabs 2 and 3 on YouTube
  const other = OTHER(2);
  tabs = [other, YT(3)];
  await fire('tabs.onUpdated', 2, { url: other.url }, other);
  release.resolve();
  await removed;
  for (let i = 0; i < 5; i++) await settle();
  expect(w.tabs!.followed()).toBe(3);
});

describe('watch: replacement candidates that close or move meanwhile', () => {
  it('closed while looked up: the next one', async () => {
    tabs = [YT(1, true), YT(2), YT(3)]; // automatic
    const w = await watch();
    heldGet.set(2, hold());
    tabs = tabs.filter((t) => t.id !== 1);
    const removed = fire('tabs.onRemoved', 1, { windowId: 1 });
    await settle(); // pick() is looking tab 2 up
    tabs = tabs.filter((t) => t.id !== 2);
    await fire('tabs.onRemoved', 2, { windowId: 1 });
    heldGet.get(2)!.resolve(); // answers with tab 2 as it was
    await removed;
    for (let i = 0; i < 5; i++) await settle();
    expect(w.tabs!.followed()).toBe(3);
  });

  it('moved to another window while looked up: the next one of the window', async () => {
    tabs = [YT(1, true), YT(2), YT(3)];
    const w = await watch();
    heldGet.set(2, hold());
    tabs = tabs.filter((t) => t.id !== 1);
    const removed = fire('tabs.onRemoved', 1, { windowId: 1 });
    await settle();
    tabs[0] = { ...tabs[0]!, windowId: 2 };
    await fire('tabs.onAttached', 2, { newWindowId: 2 });
    heldGet.get(2)!.resolve();
    heldGet.delete(2);
    await removed;
    for (let i = 0; i < 5; i++) await settle();
    expect(w.tabs!.followed()).toBe(3);
  });
});

it('a saved tab whose site is turned off while it is restored: another takes over', async () => {
  delete stored['mirattic.followActive'];
  stored['mirattic.experiment.laftel'] = true;
  tabs = [LAFTEL(1), YT(2, true)];
  session['mirattic.followedTab'] = 1;
  heldGet.set(1, hold());
  const started = watch();
  await settle();
  stored['mirattic.experiment.laftel'] = false;
  await fire('storage.onChanged', { 'mirattic.experiment.laftel': { oldValue: true, newValue: false } }, 'local');
  heldGet.get(1)!.resolve();
  const w = await started;
  for (let i = 0; i < 3; i++) await settle();
  expect(w.tabs!.followed()).toBe(2);
});

describe('watch: turning a site off while its tab is being chosen or opened', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('the followed tab chosen again: its player is let go when its site is turned off meanwhile', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [LAFTEL(1, true)];
    const w = await watch();
    expect(followed()).toBe(1);
    heldGet.set(1, hold());
    const choosing = w.tabs!.choose(1);
    await settle();
    disconnects = [];
    await w.experimental!.setEnabled('laftel', false);
    expect(disconnects).toContain(1); // at once, not after the lookup
    heldGet.get(1)!.resolve();
    await choosing;
    await settle();
    expect(w.tabs!.followed()).toBe(null);
  });

  it('a room video tab still loading on a site turned off: another takes over', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [YT(1, true)];
    const w = await watch();
    const opened = { ...LAFTEL(5, true), status: 'loading' };
    tabs.push(opened);
    (globalThis as any).__created = opened;
    w.open(opened.url, true);
    for (let i = 0; i < 3; i++) await settle();
    expect(w.tabs!.followed()).toBe(5);
    await w.experimental!.setEnabled('laftel', false);
    for (let i = 0; i < 3; i++) await settle();
    expect(w.tabs!.followed()).toBe(1);
  });
});

describe('watch: a followed tab let go mid-way', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('its site turned off: the replacement comes from its own window', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [{ ...LAFTEL(1, true), windowId: 2 }, { ...YT(2, true), windowId: 2 }, YT(3, true)];
    const w = await watch();
    await w.tabs!.choose(1, 2);
    w.follow(1); // window 1's panel opened meanwhile
    await w.experimental!.setEnabled('laftel', false);
    for (let i = 0; i < 4; i++) await settle();
    expect(w.tabs!.followed()).toBe(2);
  });

  it('closed while its script goes in: never connected', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [YT(1, true), LAFTEL(2)];
    const w = await watch();
    heldInject = hold();
    const injecting = heldInject;
    const choosing = w.tabs!.choose(2);
    await settle();
    tabs = [];
    connects = [];
    await fire('tabs.onRemoved', 2, { windowId: 1 });
    injecting.resolve();
    await choosing;
    await settle();
    expect(connects).not.toContain(2);
  });
});

describe('watch: site turned off around other changes', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('a tab chosen while the replacement\'s window is looked up stays chosen', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [LAFTEL(1, true), YT(2), YT(3)];
    const w = await watch();
    await w.tabs!.choose(1);
    heldGet.set(1, hold());
    await w.experimental!.setEnabled('laftel', false); // looks tab 1's window up (held)
    await w.tabs!.choose(3);
    heldGet.get(1)!.resolve();
    for (let i = 0; i < 4; i++) await settle();
    expect(w.tabs!.followed()).toBe(3);
  });

  it('turning off the site of a closed tab while its replacement is picked: from its own window still', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [YT(1, true), { ...LAFTEL(5, true), windowId: 2 }, { ...YT(6), windowId: 2 }];
    const w = await watch();
    await w.tabs!.choose(5, 2);
    w.follow(1);
    heldQuery = hold();
    const release = heldQuery;
    tabs = tabs.filter((t) => t.id !== 5);
    const removed = fire('tabs.onRemoved', 5, { windowId: 2 });
    await settle();
    await w.experimental!.setEnabled('laftel', false);
    release.resolve();
    await removed;
    for (let i = 0; i < 5; i++) await settle();
    expect(w.tabs!.followed()).toBe(6);
  });
});

it('fixed: a tab activated elsewhere while a site-off replacement looks up its window doesn\'t take over', async () => {
  delete stored['mirattic.followActive'];
  stored['mirattic.experiment.laftel'] = true;
  tabs = [YT(1, true), { ...LAFTEL(5, true), windowId: 2 }, { ...YT(6), windowId: 2 }];
  const w = await watch();
  await w.tabs!.choose(5, 2);
  w.follow(1);
  heldGet.set(5, hold());
  await w.experimental!.setEnabled('laftel', false); // looks tab 5's window up (held)
  await fire('tabs.onActivated', { tabId: 1, windowId: 1 });
  heldGet.get(5)!.resolve();
  for (let i = 0; i < 5; i++) await settle();
  expect(w.tabs!.followed()).toBe(6);
});

describe('watch: a release replaces from the tab\'s own window', () => {
  beforeEach(() => void delete stored['mirattic.followActive']);

  it('a room tab loading on a site turned off: an activation elsewhere meanwhile doesn\'t take over', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [YT(1, true), { ...YT(6), windowId: 2 }];
    const w = await watch();
    const opened = { ...LAFTEL(5, true), windowId: 2, status: 'loading' };
    tabs.push(opened);
    (globalThis as any).__created = opened;
    w.open(opened.url, true);
    for (let i = 0; i < 3; i++) await settle();
    expect(w.tabs!.followed()).toBe(5);
    heldQuery = hold(); // the replacement's lookup in window 2
    const releaseQuery = heldQuery;
    await w.experimental!.setEnabled('laftel', false);
    for (let i = 0; i < 3; i++) await settle();
    await fire('tabs.onActivated', { tabId: 1, windowId: 1 });
    releaseQuery.resolve();
    for (let i = 0; i < 5; i++) await settle();
    expect(w.tabs!.followed()).toBe(6);
  });

  it('a choice found on a site turned off: from the chosen tab\'s window, whatever panel connected meanwhile', async () => {
    stored['mirattic.experiment.laftel'] = true;
    tabs = [YT(1, true), { ...LAFTEL(5), windowId: 2 }, { ...YT(6, true), windowId: 2 }];
    const w = await watch();
    heldGet.set(5, hold());
    const choosing = w.tabs!.choose(5, 2);
    await settle();
    w.follow(1);
    stored['mirattic.experiment.laftel'] = false; // turned off (by another panel) while it's looked up
    await fire('storage.onChanged', { 'mirattic.experiment.laftel': { oldValue: true, newValue: false } }, 'local');
    heldGet.get(5)!.resolve();
    await choosing;
    for (let i = 0; i < 5; i++) await settle();
    expect(w.tabs!.followed()).toBe(6);
  });
});

it('fixed: a chosen tab moved to another window, its site turned off: replaced from where it is now', async () => {
  delete stored['mirattic.followActive'];
  stored['mirattic.experiment.laftel'] = true;
  tabs = [YT(1, true), { ...LAFTEL(5, true), windowId: 2 }, { ...YT(7, true), windowId: 3 }];
  const w = await watch();
  await w.tabs!.choose(5, 2);
  tabs[1] = { ...tabs[1]!, windowId: 3, active: false };
  await fire('tabs.onAttached', 5, { newWindowId: 3 });
  tabs = tabs.filter((t) => t.id !== 5); // and closed right after: no lookup can tell its window any more
  await w.experimental!.setEnabled('laftel', false);
  for (let i = 0; i < 5; i++) await settle();
  expect(w.tabs!.followed()).toBe(7);
});

it('fixed: a tab that becomes a video tab while a site-off replacement is looked up is followed', async () => {
  delete stored['mirattic.followActive'];
  stored['mirattic.experiment.laftel'] = true;
  tabs = [LAFTEL(1), OTHER(2, true)];
  const w = await watch();
  expect(followed()).toBe(1);
  heldQuery = hold();
  const release = heldQuery;
  await w.experimental!.setEnabled('laftel', false); // the replacement's lookup sees no video tab
  await settle();
  const yt = YT(2, true);
  tabs = [tabs[0]!, yt];
  await fire('tabs.onUpdated', 2, { url: yt.url }, yt);
  await fire('tabs.onUpdated', 2, { status: 'complete' }, yt);
  release.resolve();
  for (let i = 0; i < 6; i++) await settle();
  expect(w.tabs!.followed()).toBe(2);
});

it('fixed: a chosen tab gone to a site already off is still chosen after a restart, and followed once it\'s turned on', async () => {
  delete stored['mirattic.followActive'];
  delete stored['mirattic.experiment.netflix'];
  tabs = [YT(1), YT(2, true)];
  const w = await watch();
  await w.tabs!.choose(1);
  const nf = NF(1);
  tabs[0] = nf;
  await fire('tabs.onUpdated', 1, { url: nf.url }, nf);
  listeners = {}; // a restarted worker (the old one's listeners gone)
  const again = await watch();
  expect(again.tabs!.followed()).toBe(1);
  connects = [];
  await again.experimental!.setEnabled('netflix', true);
  for (let i = 0; i < 3; i++) await settle();
  expect(followed()).toBe(1);
});

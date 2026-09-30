import { browser } from 'wxt/browser';
import type { Socket } from '@mirattic/client';
import type { Platform } from '@mirattic/ui';
import { contentTitle, type MediaPresence, type MediaProvider, type RoomContent, type WatchingInfo } from '@mirattic/types';
import { RemoteAdapter } from './bridge';
import { ASK_ON_SWITCH_KEY, experimentKey } from './ui-port';
import { describeMetadata, metadataInPage, type NetflixMetadata } from './providers/netflix';

const YOUTUBE = 'https://www.youtube.com/';
const YOUTUBE_SCRIPT = '/content-scripts/youtube.js';
const NETFLIX_META_TRIES = 5;
const NETFLIX_META_RETRY_MS = 2_000;
// Experimental control (docs/platform-policy/{netflix,laftel}.md): each is off until the user turns it on (a
// setting, decision 81). While off we only see that a tab is on the site (to warn), and inject nothing into it.
const EXPERIMENTAL = {
  netflix: { site: 'https://www.netflix.com/', script: '/content-scripts/netflix.js' },
  laftel: { site: 'https://laftel.net/', script: '/content-scripts/laftel.js' },
} as const;
type Experimental = keyof typeof EXPERIMENTAL;
const EXPERIMENTS = Object.keys(EXPERIMENTAL) as Experimental[];
const isExperimental = (p: MediaProvider): p is Experimental => p in EXPERIMENTAL;

/** The same video page: origin and path, and for YouTube's /watch the `v` too (other parameters are position, list). */
export const samePage = (a: URL, b: URL) => {
  const path = (u: URL) => u.pathname.replace(/\/$/, ''); // Laftel's player path works with or without it
  return a.origin === b.origin && path(a) === path(b) && a.searchParams.get('v') === b.searchParams.get('v');
};

const OFF_SITE_KEY = 'mirattic.offSite';
const PRESENCE_DELAY_MS = 300; // the server drops presence updates closer than 250ms

export type Watch = Omit<Platform, 'connect' | 'room'> & {
  /** Follow the video tab of another window (the one whose side panel was opened last). */
  follow(windowId: number): void;
};

/**
 * The extension's platform: follows the video tab of one window — YouTube, or Netflix / Laftel once turned on;
 * the active one, else the last one used, else any — and exposes it as the room player, "now watching"
 * and the user's presence. Runs in the background, so it goes on while the side panel is closed.
 */
export async function watch(opts: { windowId?: number } = {}): Promise<Watch> {
  let windowId = opts.windowId ?? (await browser.windows.getCurrent()).id;
  let tabId: number | null = null;
  let content: RoomContent | null = null;
  let presence: MediaPresence | null = null;
  let socket: Socket | null = null;
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  const subscribers = new Set<() => void>();
  const changed = () => subscribers.forEach((s) => s());
  // ponytail: off after the update that made the sites' access permanent, even for who had it on (re-enable once).
  const stored = await browser.storage.local.get([...EXPERIMENTS.map(experimentKey), ASK_ON_SWITCH_KEY]);
  const on = new Set(EXPERIMENTS.filter((p) => stored[experimentKey(p)] === true));
  let askOnSwitch = stored[ASK_ON_SWITCH_KEY] !== false;
  /** Presence parts the room title joins: my own status lines show them apart (same object while unchanged). */
  let info: WatchingInfo | null = null;
  /** The window's active tab is on a site whose control is off; `visit` counts arrivals there (decision 81). */
  // Kept in storage.session: a service worker restart while the user stays on the tab is the same arrival (the
  // panel's dismissal still holds); the browser closing forgets it.
  type OffSite = { provider: Experimental; visit: number; tabId?: number };
  const kept = (await browser.storage.session.get(OFF_SITE_KEY))[OFF_SITE_KEY] as OffSite | undefined;
  let offSite: { provider: Experimental; visit: number } | null = kept ? { provider: kept.provider, visit: kept.visit } : null;
  let offSiteTab: number | undefined = kept?.tabId; // an arrival is per tab: another tab of the same site is asked about again
  // Time-based, so an arrival after the service worker restarts never repeats one the panel already dismissed.
  let visits = kept?.visit ?? 0;

  const sendPresence = () => {
    if (presenceTimer !== undefined) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = undefined;
      socket?.send({ type: 'presence:update', payload: presence });
    }, PRESENCE_DELAY_MS);
  };

  // A YouTube tab opened before the extension was installed or updated has no live script (it came with the
  // page): put one in, once per page load, and connect again.
  const reinjected = new Set<number>();
  const revive = async (id: number, provider: MediaProvider) => {
    if (provider !== 'youtube' || reinjected.has(id)) return;
    reinjected.add(id);
    const injected = await browser.scripting.executeScript({ target: { tabId: id }, files: [YOUTUBE_SCRIPT] }).catch(() => null);
    if (injected && id === tabId && !adapter.connected) adapter.connect(id, provider);
  };

  // Netflix names what plays only in its page data (decision 73): read once per episode, retried while the
  // player loads; until then the adapter's own title stands. Its show id is the series.
  const netflixMeta = new Map<string, NetflixMetadata | null>();
  /** Episodes played in a row (the adapter's run, named after its first episode) → the show id read for one of them. */
  const runShow = new Map<string, string>();
  let raw: MediaPresence | null = null;
  const readNetflix = async (id: string, attempt: number) => {
    if (!netflixMeta.get(id)) netflixMeta.set(id, null); // a partial answer stays shown while it is read again
    const tab = tabId;
    if (tab === null || !on.has('netflix')) return;
    const [done] = await browser.scripting.executeScript({ target: { tabId: tab }, world: 'MAIN', func: metadataInPage, args: [id] })
      .catch(() => []);
    // Turned off while reading: Chrome can't take back a script it already runs, so its answer is dropped unused
    // (never shown, never sent), and no further read starts while off.
    if (!on.has('netflix')) return;
    const found = (done?.result as NetflixMetadata | null | undefined) ?? null;
    console.info('[mirattic] Netflix page data for', id, found ? `found: ${describeMetadata(found)}` : 'not found', `(try ${attempt})`);
    if (found && !(found.partial && netflixMeta.get(id) && !netflixMeta.get(id)!.partial)) {
      netflixMeta.set(id, found);
      if (tabId === tab && raw?.contentId === id) show(enrich(raw)); // still the tab and episode it was read for
    }
    // Nothing yet, or a show whose episode list lacks this episode so far: read again while tries last.
    if ((!found || found.partial) && attempt < NETFLIX_META_TRIES) {
      setTimeout(() => raw?.contentId === id && void readNetflix(id, attempt + 1), NETFLIX_META_RETRY_MS);
    }
  };
  const enrich = (p: MediaPresence | null): MediaPresence | null => {
    if (p?.provider !== 'netflix' || !p.contentId) return p;
    if (!netflixMeta.has(p.contentId)) void readNetflix(p.contentId, 1);
    const m = netflixMeta.get(p.contentId);
    if (m) {
      if (p.series) runShow.set(p.series, m.showId);
      // Apart, so the friend list shows the title and the episode on their own lines; the room gets them joined.
      // Page data without this episode yet (partial): the episode read from the player's title line stays.
      const episode = m.episode !== undefined ? { season: m.season, episode: m.episode, episodeTitle: m.episodeTitle } : {};
      return { ...p, title: m.title, ...episode, series: m.showId };
    }
    // The next episode of a run whose show is known: keep that show as the series until its own data is read,
    // so members follow it instead of being asked (and the title updates when the data arrives).
    const show = p.series ? runShow.get(p.series) : undefined;
    return show ? { ...p, series: show } : p;
  };

  const show = (p: MediaPresence | null) => {
    presence = p;
    const next: RoomContent | null = p?.contentId
      ? { provider: p.provider, contentId: p.contentId, title: contentTitle(p), durationMs: p.durationMs, canonicalUrl: p.canonicalUrl, series: p.series }
      : null;
    const nextInfo = p ? { provider: p.provider, title: p.title, channel: p.channel, season: p.season, episode: p.episode } : null;
    if (JSON.stringify(nextInfo) !== JSON.stringify(info)) {
      info = nextInfo;
      changed();
    }
    // Same object while the video is the same, as useSyncExternalStore requires.
    if (next?.contentId !== content?.contentId || next?.title !== content?.title || (next?.durationMs ?? 0) !== (content?.durationMs ?? 0)
      || next?.series !== content?.series) {
      content = next;
      changed();
    }
    sendPresence();
  };
  const adapter = new RemoteAdapter((p) => {
    raw = p;
    show(enrich(p));
  }, (id, provider) => void revive(id, provider));

  const providerOf = (url?: string): MediaProvider | null =>
    url?.startsWith(YOUTUBE) ? 'youtube' : ([...on].find((p) => url?.startsWith(EXPERIMENTAL[p].site)) ?? null);
  const isVideoTab = (url?: string) => providerOf(url) !== null;

  let binding = 0; // bumped by every bind and by turning an experiment off: a slower bind then gives up
  let choosing = 0; // bumped by every pick() and every bind: a pick() whose lookups finish after that is stale
  let activations = 0; // tabs.onActivated order: a late lookup of an earlier activation is stale
  const bind = async (id: number, url?: string) => {
    const provider = providerOf(url);
    if (!provider) return;
    choosing++; // every choice of a video tab, however it came about, supersedes a pick() still looking up tabs
    if (id === tabId && adapter.connected && adapter.provider === provider) return;
    tabId = id;
    const mine = ++binding;
    // Experiments aren't in the manifest: only the tab we follow gets the script (it ignores a second injection).
    if (isExperimental(provider)) {
      const injected = await browser.scripting.executeScript({ target: { tabId: id }, files: [EXPERIMENTAL[provider].script] }).catch(() => null);
      // Turned off (or another tab chosen) while injecting: never connect, so nothing is read. An injection Chrome
      // completes late only adds a listener (serveAdapter): the adapter, and any reading, starts on our connect.
      if (!injected || mine !== binding || !on.has(provider)) return;
    }
    adapter.connect(id, provider);
  };

  /** A tab of this window on the same video page as `url` (YouTube: the same `v`). */
  const tabShowing = async (url: string) => {
    const want = new URL(url);
    const tabs = await browser.tabs.query({ windowId, url: [`${want.origin}/*`] });
    return tabs.find((t) => t.url && samePage(new URL(t.url), want));
  };

  /** The active video tab of this window, else any, except one being closed. */
  const pick = async (closing?: number) => {
    const mine = ++choosing;
    const [active] = await browser.tabs.query({ active: true, windowId });
    const urls = [`${YOUTUBE}*`, ...[...on].map((p) => `${EXPERIMENTAL[p].site}*`)];
    const any = (await browser.tabs.query({ windowId, url: urls })).find((t) => t.id !== closing);
    if (mine !== choosing) return;
    const tab = isVideoTab(active?.url) && active?.id !== closing ? active : any;
    if (tab?.id !== undefined) await bind(tab.id, tab.url);
  };

  /** Whether the window's active tab is on a site whose control is off: the panel then offers to turn it on. */
  const offSiteOf = (url?: string) => EXPERIMENTS.find((p) => !on.has(p) && url?.startsWith(EXPERIMENTAL[p].site)) ?? null;
  let checks = 0;
  const checkOffSite = async () => {
    const mine = ++checks;
    const [active] = await browser.tabs.query({ active: true, windowId });
    if (mine !== checks) return;
    const provider = offSiteOf(active?.url);
    if (provider === (offSite?.provider ?? null) && (!provider || active?.id === offSiteTab)) return;
    visits = Math.max(visits + 1, Date.now());
    offSite = provider ? { provider, visit: visits } : null;
    offSiteTab = provider ? active?.id : undefined;
    void browser.storage.session.set({ [OFF_SITE_KEY]: offSite && { ...offSite, tabId: offSiteTab } });
    changed();
  };

  const setOn = (provider: Experimental, enabled: boolean) => {
    if (enabled === on.has(provider)) return;
    if (enabled) on.add(provider);
    else {
      on.delete(provider);
      binding++;
      if (adapter.provider === provider) {
        tabId = null;
        adapter.disconnect();
      }
    }
    changed();
    void pick();
    void checkOffSite();
  };
  // Settings changed by any page (the side panel writes them): applied here, whatever connection carried the click.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const p of EXPERIMENTS) {
      const change = changes[experimentKey(p)];
      if (change) setOn(p, change.newValue === true);
    }
    const ask = changes[ASK_ON_SWITCH_KEY];
    if (ask && (ask.newValue !== false) !== askOnSwitch) {
      askOnSwitch = ask.newValue !== false;
      changed();
    }
  });

  browser.tabs.onActivated.addListener(async (info) => {
    if (info.windowId !== windowId) return;
    void checkOffSite();
    const mine = ++activations;
    const tab = await browser.tabs.get(info.tabId).catch(() => null);
    // The user activated another tab meanwhile: its own handler decides. Only a video tab is a choice, so
    // switching to any other tab doesn't cancel a pending handover (pick() after the synced tab closed).
    if (mine !== activations || !isVideoTab(tab?.url)) return;
    await bind(info.tabId, tab!.url);
  });
  browser.tabs.onUpdated.addListener((id, change, tab) => {
    if (tab.active && tab.windowId === windowId && (change.url || change.status === 'complete')) void checkOffSite();
    // The synced tab left the provider: another video tab in this window takes over. With none, the tab
    // stays ours, so "이 영상 열기" brings it back.
    if (id === tabId && change.url && providerOf(change.url) !== adapter.provider) void pick();
    // A reload or a fresh navigation to a video site starts without our script: reconnect (and reinject).
    if (change.status === 'complete') reinjected.delete(id);
    if (change.status === 'complete' && isVideoTab(tab.url) && (id === tabId || (tab.active && tab.windowId === windowId))) {
      if (id !== tabId || !adapter.connected) {
        tabId = null;
        void bind(id, tab.url);
      }
    }
  });
  browser.tabs.onRemoved.addListener((id) => {
    if (id !== tabId) return;
    tabId = null;
    adapter.disconnect();
    void pick(id); // another video tab in this window takes over
  });

  // After the listeners: a tab switch during the first (possibly injecting) bind must not be missed.
  await pick();
  void checkOffSite();

  return {
    follow: (id) => {
      if (id === windowId) return;
      windowId = id;
      void pick();
      void checkOffSite();
    },
    adapter: (provider) => (provider === 'youtube' || (isExperimental(provider) && on.has(provider)) ? adapter.as(provider) : undefined),
    nowWatching: () => content,
    nowWatchingInfo: () => info,
    offSite: () => offSite,
    preferences: {
      askOnSwitch: () => askOnSwitch,
      setAskOnSwitch: async (ask) => {
        await browser.storage.local.set({ [ASK_ON_SWITCH_KEY]: ask }); // applied by storage.onChanged
      },
    },
    subscribe: (onChange) => {
      subscribers.add(onChange);
      return () => void subscribers.delete(onChange);
    },
    connected: (s) => {
      socket = s;
      if (s && presence) sendPresence(); // the server forgets presence on disconnect
    },
    experimental: {
      enabled: (provider) => isExperimental(provider) && on.has(provider),
      setEnabled: async (provider, enabled) => {
        if (!isExperimental(provider)) return false;
        setOn(provider, enabled); // at once here; storage.onChanged then finds nothing to change
        await browser.storage.local.set({ [experimentKey(provider)]: enabled });
        return true;
      },
    },
    open: (url, newTab) => {
      // Reuse the synced tab so the room keeps following it; the user asked for this navigation. A new tab
      // (the room's "open" button, entering a room) is followed once it loads, being the window's active video
      // tab — unless a tab of this window already has that video: that one is brought forward instead.
      const opened = tabId !== null && !newTab
        ? browser.tabs.update(tabId, { url, active: true })
        : (newTab ? tabShowing(url) : Promise.resolve(undefined)).then((tab) =>
            tab?.id !== undefined ? browser.tabs.update(tab.id, { active: true }) : Promise.reject());
      opened.catch(() => browser.tabs.create({ url, windowId }));
    },
  };
}

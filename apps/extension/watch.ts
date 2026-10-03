import { browser, type Browser } from 'wxt/browser';
import type { Socket } from '@mirattic/client';
import type { Platform, VideoTab } from '@mirattic/ui';
import { contentTitle, type MediaPresence, type MediaProvider, type RoomContent, type WatchingInfo } from '@mirattic/types';
import { pauseTab, RemoteAdapter } from './bridge';
import { ASK_ON_SWITCH_KEY, experimentKey, followActiveSetting } from './ui-port';
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
  /**
   * The panel is its own window: every browser window's tabs count alike — the active tab is the focused browser
   * window's, a replacement may come from any window, a tab moving between windows stays followed, and no window
   * is offered the panel. Until `follow` (a side panel opened).
   */
  detach(): void;
  /** The active tab is what is followed now: out of a room (a replaced device too), or following it by choice. */
  followsActive(): boolean;
};

/** Each site's first page, opened when the room's type is picked and no tab of it is open (decision 93). */
export const SITE_HOME = {
  youtube: YOUTUBE,
  netflix: 'https://www.netflix.com/browse',
  laftel: 'https://laftel.net/',
} as const;

/** storage.session: the tab followed, so a service worker restart keeps a chosen tab. */
const followedTabEntry = 'mirattic.followedTab';

/**
 * The extension's platform: follows one video tab — YouTube, or Netflix / Laftel once turned on. Which one: the tab
 * the user chose (it stays, whichever tab is active, until it closes), or with "follow the active tab" on, the
 * window's active video tab as the user switches; with none chosen yet, the active one, else any — and exposes it as the room player, "now watching"
 * and the user's presence. Runs in the background, so it goes on while the side panel is closed.
 */
/** `site`: the room's site already (a restarted worker back in a room): what is taken over by itself is of it from the start. */
/** `onOtherWindow`: following the active tab, a video tab was activated in another window than the panel's. */
export async function watch(opts: {
  windowId?: number;
  site?: MediaProvider | null;
  inRoom?: boolean;
  onOtherWindow?: (tabId: number, windowId: number) => void;
} = {}): Promise<Watch> {
  let windowId = opts.windowId ?? (await browser.windows.getCurrent()).id;
  /** The panel is its own window (see `detach`): `windowId` is then the browser window focused last. */
  let detached = false;
  let tabId: number | null = null;
  let content: RoomContent | null = null;
  let presence: MediaPresence | null = null;
  let socket: Socket | null = null;
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  const subscribers = new Set<() => void>();
  const changed = () => subscribers.forEach((s) => s());
  // ponytail: off after the update that made the sites' access permanent, even for who had it on (re-enable once).
  const stored = await browser.storage.local.get([...EXPERIMENTS.map(experimentKey), ASK_ON_SWITCH_KEY, followActiveSetting]);
  const on = new Set(EXPERIMENTS.filter((p) => stored[experimentKey(p)] === true));
  let askOnSwitch = stored[ASK_ON_SWITCH_KEY] !== false;
  let followActive = stored[followActiveSetting] === true;
  /**
   * In a room (decision 95): the chosen tab is followed (fixed, unless "활성 탭 자동 따라가기"). Out of one, what I
   * watch is the active tab, as I switch — the home screen's "now watching" follows it.
   */
  let inRoom = opts.inRoom ?? false;
  const autoNow = () => followActive || !inRoom;
  /** Whether a tab switch may change the followed tab: following the active one, or none followed yet. */
  // Fixed: the chosen tab stays even when its video is gone (left the site, player dead); only the user choosing
  // another, the room's video opened in a tab (take), or the tab closing changes it.
  const switching = () => autoNow() || (tabId === null && settling === 0);
  /**
   * The fixed tab being settled — a restarted worker restoring its saved one, or a closed one's replacement picked
   * from its own window: tab switches (activations, loads elsewhere) don't take its place meanwhile.
   */
  let settling = 1; // the restore below (ended once by endRestore, whatever mode this starts in)
  let restored = false;
  /** Sites turned off while the saved fixed tab is being read: a saved tab on one of them isn't restored. */
  const offWhileRestoring = new Set<MediaProvider>();
  const endRestore = () => {
    if (!restored) settling--;
    restored = true;
  };
  /** The video tabs the user can choose from, every window: each panel lists its own window's (titles stay in the user's own panels). */
  let tabs: VideoTab[] = [];
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
      ? { provider: p.provider, contentId: p.contentId, title: contentTitle(p), durationMs: p.durationMs, canonicalUrl: p.canonicalUrl, series: p.series,
        channel: p.channel?.slice(0, 100) || undefined }
      : null;
    const nextInfo = p ? { provider: p.provider, title: p.title, channel: p.channel, season: p.season, episode: p.episode } : null;
    if (JSON.stringify(nextInfo) !== JSON.stringify(info)) {
      info = nextInfo;
      changed();
    }
    // Same object while the video is the same, as useSyncExternalStore requires.
    if (next?.provider !== content?.provider || next?.contentId !== content?.contentId || next?.title !== content?.title || (next?.durationMs ?? 0) !== (content?.durationMs ?? 0)
      || next?.series !== content?.series || next?.channel !== content?.channel) {
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
  /**
   * The room's site (its type, decision 93), while in a room: tabs taken over by themselves (a replacement, an
   * activation, a load) are of it only — its tabs all closed, none of another site is taken (the user chooses).
   */
  // undefined: in a room whose type isn't known yet — nothing is taken over by itself until it is.
  let site: MediaProvider | null | undefined = opts.site !== undefined ? opts.site : opts.inRoom ? undefined : null;
  const ofSite = (url?: string) => isVideoTab(url) && (!inRoom || (site !== undefined && (!site || providerOf(url) === site)));
  const videoUrls = () => [`${YOUTUBE}*`, ...[...on].map((p) => `${EXPERIMENTAL[p].site}*`)];

  /** Changes per tab (URL, load, moved to another window): a lookup that saw one happen meanwhile is stale. */
  const navigations = new Map<number, number>();
  const changedTab = (id: number) => navigations.set(id, (navigations.get(id) ?? 0) + 1);
  /** Tabs closed (ids aren't reused in a browser session): a lookup answered from before the close is void. */
  const closed = new Set<number>();
  /** The tab as it is now: looked up again if it changed while being looked up; null if it's gone. */
  const tabNow = async (id: number) => {
    for (;;) {
      const at = navigations.get(id) ?? 0;
      const tab = await browser.tabs.get(id).catch(() => null);
      if (!tab || closed.has(id)) return null;
      if ((navigations.get(id) ?? 0) === at) return tab;
    }
  };

  let listing = 0;
  const listTabs = async () => {
    const mine = ++listing;
    // Every tab: only video sites' have a URL here (host permissions), filtered below.
    const found = await browser.tabs.query({}).catch(() => []);
    if (mine !== listing) return;
    found.sort((a, b) => a.windowId - b.windowId || a.index - b.index); // each window's tab strip order
    const next = found.flatMap((t) => {
      const provider = providerOf(t.url);
      return t.id !== undefined && provider ? [{ id: t.id, title: t.title || t.url!, provider, windowId: t.windowId }] : [];
    });
    if (JSON.stringify(next) === JSON.stringify(tabs)) return;
    tabs = next;
    changed();
  };

  let binding = 0; // bumped by every bind and by turning an experiment off: a slower bind then gives up
  let choosing = 0; // bumped by every pick() and every bind: a pick() whose lookups finish after that is stale
  let activations = 0; // tabs.onActivated order: a late lookup of an earlier activation is stale
  let intent = 0; // the user's latest say on the tab (a choice, back to automatic, a video opened): earlier ones give up
  /** Bringing chosen tabs of other windows forward, one after another (decision 94). */
  let activating: Promise<void> = Promise.resolve();
  /** The site of the followed tab as last bound (null: still loading), apart from the adapter connecting to it. */
  let tabProvider: MediaProvider | null = null;
  /** The followed tab's window (kept current as it moves): a replacement comes from there, without a lookup. */
  let tabWindow: number | undefined;
  /** Nothing followed (out of a room, the active tab isn't a video one): no player, nothing watched. */
  const unbind = () => {
    choosing++; // a pick still looking up tabs gives up too (also with nothing followed)
    if (tabId === null) return;
    binding++;
    tabId = null;
    void browser.storage.session.set({ [followedTabEntry]: null }); // nor restored after a restart
    tabProvider = null;
    adapter.disconnect();
    changed();
  };
  /** The followed tab from now on: the previous one's player is let go at once, and the choice kept for a restart. */
  const select = (id: number, inWindow: number | undefined) => {
    if (id === tabId) {
      if (inWindow !== undefined && inWindow !== tabWindow) {
        tabWindow = inWindow;
        keep();
      }
      return;
    }
    tabId = id;
    tabWindow = inWindow;
    adapter.disconnect();
    keep();
    changed();
  };
  /** Saved for a restart with its window: a tab found in another window then (moved meanwhile) isn't followed. */
  const keep = () => void browser.storage.session.set({ [followedTabEntry]: { tabId, windowId: tabWindow } });
  const bind = async (id: number, url: string | undefined, inWindow: number | undefined) => {
    const provider = providerOf(url);
    if (!provider) return;
    choosing++; // every choice of a video tab, however it came about, supersedes a pick() still looking up tabs
    if (id === tabId && adapter.connected && adapter.provider === provider) {
      tabProvider = provider; // the same tab chosen again (choose() cleared it)
      if (inWindow !== undefined && inWindow !== tabWindow) {
        tabWindow = inWindow;
        keep();
      }
      return;
    }
    select(id, inWindow);
    tabProvider = provider;
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

  /** A tab of this window (detached: of any) on the same video page as `url` (YouTube: the same `v`). */
  const tabShowing = async (url: string) => {
    const want = new URL(url);
    const tabs = await browser.tabs.query(detached ? { url: [`${want.origin}/*`] } : { windowId, url: [`${want.origin}/*`] });
    const showing = tabs.filter((t) => t.url && samePage(new URL(t.url), want));
    return showing.find((t) => t.windowId === windowId) ?? showing[0]; // this window's first
  };

  /** The active video tab of this window, else any, except one being closed. */
  const pick = async (closing?: number, inWindow = windowId) => {
    const mine = ++choosing;
    const [active] = await browser.tabs.query({ active: true, windowId: inWindow });
    // Detached: any window's, that window's first.
    const all = (await browser.tabs.query(detached ? { url: videoUrls() } : { windowId: inWindow, url: videoUrls() }))
      .filter((t) => t.id !== closing)
      .sort((a, b) => Number(b.windowId === inWindow) - Number(a.windowId === inWindow));
    const activeOne = ofSite(active?.url) && active?.id !== closing ? [active!] : [];
    // Out of a room (decision 95): the active tab only — not a video tab, nothing is watched (no other tab instead).
    if (!inRoom && !activeOne.length) {
      if (mine === choosing) unbind();
      return;
    }
    const candidates = [...activeOne, ...(inRoom ? all.filter((t) => ofSite(t.url)) : [])];
    for (const candidate of candidates) {
      if (mine !== choosing) return;
      if (candidate.id === undefined) continue;
      const now = await tabNow(candidate.id); // as it is now: it may have navigated since the query (next one then)
      // Still a video tab of that window (not closed, not moved away meanwhile): followed.
      if (mine === choosing && now?.id !== undefined && (detached || now.windowId === inWindow) && ofSite(now.url)) {
        return void (await bind(now.id, now.url, now.windowId));
      }
    }
    // Out of a room and no active video tab after all (it moved on while looked at): nothing watched.
    if (!inRoom && mine === choosing) unbind();
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

  /**
   * The followed tab is unusable (gone, on a site turned off): let go, not restored after a restart, and another video
   * tab of `inWindow` (its own window) takes over — tab switches elsewhere don't take its place meanwhile.
   */
  /**
   * The followed tab is gone or let go: following the active tab, the followed window's takes over; a chosen tab,
   * another video tab of its own window (`inWindow`), tab switches elsewhere held off meanwhile. A tab that became a
   * video tab during that lookup (its load was held off) is looked for once more — unless the user said otherwise
   * since (chose a tab, went automatic, opened a video).
   */
  const replace = (inWindow: number | undefined, closing?: number) => {
    if (autoNow()) return void pick(closing, windowId);
    settling++;
    const said = intent;
    void pick(closing, inWindow).finally(() => {
      settling--;
      if (tabId === null && settling === 0 && !autoNow() && intent === said) void pick(closing, inWindow);
    });
  };
  const release = (inWindow: number | undefined) => {
    binding++; // a bind still injecting its script gives up
    tabId = null;
    tabProvider = null;
    adapter.disconnect();
    void browser.storage.session.set({ [followedTabEntry]: null });
    changed();
    replace(inWindow);
  };
  const setOn = (provider: Experimental, enabled: boolean) => {
    if (enabled === on.has(provider)) return;
    let replacing = false; // the followed tab let go here (release picks its replacement)
    if (enabled) on.add(provider);
    else {
      on.delete(provider);
      if (!restored) offWhileRestoring.add(provider);
      // Never left reading or driving a site turned off, whatever is selected.
      if (adapter.connected && adapter.provider === provider) adapter.disconnect();
      if (tabProvider === provider) {
        // The followed tab is on it now (kept current as it navigates), or is being bound to it (that bind gives up).
        replacing = true;
        release(tabWindow);
      } else if (tabId !== null) {
        // Its site not known yet (being chosen, or opened and still loading): its URL decides.
        const id = tabId;
        void tabNow(id).then((t) => {
          if (tabId === id && (!t || offSiteOf(t.url) === provider)) release(t?.windowId ?? tabWindow);
        });
      }
    }
    changed();
    if (!replacing && switching()) void pick(); // (when replacing, picked above from the tab's window)
    else if (enabled && !adapter.connected) {
      // The chosen tab may be on the site just turned on (it went there while off): followed there now.
      const id = tabId;
      void tabNow(id!).then((t) => {
        if (t && tabId === id && providerOf(t.url) === provider && !adapter.connected) void bind(id!, t.url, t.windowId);
      });
    }
    void checkOffSite();
    void listTabs();
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

  /** Another window's active video tab while the active tab is what is followed: the panel can move there. */
  const offerIfOther = async (id: number) => {
    if (!autoNow() || detached || !opts.onOtherWindow) return;
    const tab = await tabNow(id);
    // As things are after the lookup (a room entered meanwhile, the panel moved there).
    // YouTube tabs only: Netflix / Laftel get our script only in the tab followed, so no toast can show in another.
    if (tab?.id !== undefined && autoNow() && !detached && ofSite(tab.url) && providerOf(tab.url) === 'youtube' && tab.active
      && tab.windowId !== windowId) {
      opts.onOtherWindow(tab.id, tab.windowId);
    }
  };
  // Switching windows without switching tabs: that window's active tab counts the same. Detached: that window is
  // the one followed now. Browser windows only (not the detached panel's own).
  browser.windows.onFocusChanged?.addListener(async (focused) => {
    if (focused === browser.windows.WINDOW_ID_NONE || focused === windowId) return;
    if (detached) return moveTo(focused);
    if (!autoNow()) return;
    const [active] = await browser.tabs.query({ active: true, windowId: focused }).catch(() => []);
    if (active?.id !== undefined) void offerIfOther(active.id);
  }, { windowTypes: ['normal'] });
  browser.tabs.onActivated.addListener(async (info) => {
    if (info.windowId !== windowId && detached) {
      // Detached: a tab the user activated in another window (it is focused; a tab closing in a window behind doesn't
      // count) — that window is followed now, and its active tab as in this one.
      const w = await browser.windows.get(info.windowId).catch(() => null);
      if (detached && w?.focused && w.type === 'normal') moveTo(info.windowId);
      return;
    }
    if (info.windowId !== windowId) {
      // Another window's video tab, while the active tab is what is followed: the panel can be moved there (the user
      // clicks it — Chrome opens a side panel only for a user's gesture).
      await offerIfOther(info.tabId);
      return;
    }
    void checkOffSite();
    if (!switching()) return; // the chosen tab stays
    const mine = ++activations;
    const tab = await tabNow(info.tabId);
    // The user activated another tab meanwhile: its own handler decides. Only a video tab is a choice, so
    // switching to any other tab doesn't cancel a pending handover (pick() after the synced tab closed).
    // A tab chosen meanwhile (choose(), take() bump `activations`) wins over this activation.
    // Still this window's (the panel may have moved to another meanwhile: that one's tabs count now).
    if (mine !== activations || !switching() || info.windowId !== windowId) return;
    if (!ofSite(tab?.url)) {
      if (!inRoom) unbind(); // out of a room, what is watched is the active tab: not a video one, nothing
      return;
    }
    await bind(info.tabId, tab!.url, tab!.windowId);
  });
  browser.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.url || change.status) changedTab(id);
    if (change.title !== undefined || change.url || change.status === 'complete') void listTabs();
    // Another window's active tab done loading (a video page ready only now): offered as on activating it.
    if (change.status === 'complete' && tab.active && tab.windowId !== windowId) void offerIfOther(id);
    if (tab.active && tab.windowId === windowId && (change.url || change.status === 'complete')) void checkOffSite();
    // The synced tab left the video sites: following the active tab, another video tab in this window takes over
    // (with none, the tab stays ours, so "이 영상 열기" brings it back). A chosen tab stays chosen, followed again
    // back on a video site. On to another video site: still ours (bound below once it loads).
    if (id === tabId && change.url) {
      tabProvider = providerOf(change.url); // the site it is on now: turning off the one it left doesn't concern it
      if (!tabProvider && autoNow()) void pick();
    }
    // A reload or a fresh navigation to a video site starts without our script: reconnect (and reinject).
    if (change.status === 'complete') reinjected.delete(id);
    if (change.status === 'complete' && isVideoTab(tab.url)
      // The followed tab reloading: bound again — out of a room only while it is the active one (the active tab is
      // what is followed there; a pick of it may be under way).
      && ((id === tabId && (inRoom || (tab.active && tab.windowId === windowId)))
        || (switching() && tab.active && tab.windowId === windowId && ofSite(tab.url)))) {
      if (id !== tabId || !adapter.connected || providerOf(tab.url) !== adapter.provider) {
        tabId = null;
        void bind(id, tab.url, tab.windowId);
      }
    }
  });
  // A tab moved to another window: each panel lists its own window's.
  browser.tabs.onAttached.addListener((id, attached) => {
    changedTab(id);
    void listTabs();
    if (id !== tabId) return;
    tabWindow = attached.newWindowId;
    // Detached, or a chosen tab: still followed in its new window (pulled out into one of its own, or into another).
    // Following the active tab: it's that window's tab only while it stays there.
    if (detached || !autoNow() || attached.newWindowId === windowId) return keep();
    binding++;
    tabId = null;
    tabProvider = null;
    adapter.disconnect();
    void browser.storage.session.set({ [followedTabEntry]: null });
    changed();
    void pick();
  });
  // Tabs reordered: the list follows the tab strip's order.
  browser.tabs.onMoved.addListener(() => void listTabs());
  browser.tabs.onDetached.addListener(() => void listTabs());
  browser.tabs.onRemoved.addListener((id, removed) => {
    void listTabs();
    navigations.delete(id);
    closed.add(id);
    if (id !== tabId) return;
    binding++; // a bind still injecting its script into it gives up
    tabId = null;
    tabProvider = null; // turning its site off now doesn't concern it (its replacement is being picked below)
    adapter.disconnect();
    changed();
    replace(removed?.windowId ?? windowId, id);
  });

  // After the listeners: a tab switch during the first (possibly injecting) bind must not be missed. A tab chosen
  // before a service worker restart stays chosen.
  const before = choosing; // a choice or a room video opened while these are read is newer than the saved tab
  const last = autoNow() ? undefined : (await browser.storage.session.get(followedTabEntry))[followedTabEntry];
  // { tabId, windowId } (a bare id from before windows were kept; 'stopped' from an older version: none)
  const saved = typeof last === 'number' ? { tabId: last, windowId: undefined }
    : last && typeof last === 'object' && typeof (last as { tabId?: unknown }).tabId === 'number'
      ? (last as { tabId: number; windowId?: number }) : null;
  const lastTab = saved ? await tabNow(saved.tabId) : null;
  // In whatever window it is now (moved while this was read, or while no worker ran): still the chosen one.
  if (choosing === before) {
    if (lastTab?.id !== undefined && isVideoTab(lastTab.url)) await bind(lastTab.id, lastTab.url, lastTab.windowId);
    // Not on a video page now (its video died, or it went to a site that's off): kept, bound once it is — unless its
    // site was turned off while this was read (the user let it go): another takes over.
    else if (lastTab?.id !== undefined && ![...offWhileRestoring].some((p) => offSiteOf(lastTab.url) === p)) {
      select(lastTab.id, lastTab.windowId);
    }
    else {
      endRestore(); // none saved: tab switches may choose meanwhile
      await pick();
    }
  }
  endRestore();
  void checkOffSite();
  void listTabs();

  /** A tab the user opened the room's video in (fixed mode): followed from now on, once it has loaded. */
  const take = (tab: Browser.tabs.Tab) => {
    if (autoNow() || tab.id === undefined || tab.id === tabId) return; // the active one is followed anyway
    activations++;
    choosing++; // a pick() still looking up tabs (the followed one closed meanwhile) mustn't replace it
    binding++;
    select(tab.id, tab.windowId); // onUpdated binds it on 'complete'
    tabProvider = null;
    // Loaded already (even before this ran: its 'complete' came while another tab was chosen): bound as it is now.
    const id = tab.id;
    void tabNow(id).then((t) => {
      if (t && tabId === id && t.status === 'complete' && isVideoTab(t.url) && !adapter.connected) void bind(id, t.url, t.windowId);
    });
  };

  /** `id`'s tabs are the window's from now on (the active one followed, if that's what is followed). */
  function moveTo(id: number) {
    if (id === windowId) return;
    windowId = id;
    activations++; // an activation of the previous window still being looked at is not this window's
    if (switching()) void pick();
    void checkOffSite();
  }

  return {
    followsActive: autoNow,
    follow: (id) => {
      detached = false;
      moveTo(id);
    },
    detach: () => {
      detached = true;
      void browser.windows.getLastFocused({ windowTypes: ['normal'] }).then((w) => {
        if (detached && w.id !== undefined) moveTo(w.id);
      }, () => {});
    },
    adapter: (provider) => (provider === 'youtube' || (isExperimental(provider) && on.has(provider)) ? adapter.as(provider) : undefined),
    tabs: {
      list: () => tabs,
      followed: () => tabId,
      auto: () => followActive,
      choose: async (id, chosenIn, opts) => {
        // The panel's window, for its active tab and fallbacks. Detached: `chosenIn` is the tab's own window — the
        // focused browser window stays the one followed (back to the active tab: its, not the chosen tab's window's).
        if (chosenIn !== undefined && !detached) windowId = chosenIn;
        const mine = ++intent;
        followActive = id === null;
        void browser.storage.local.set({ [followActiveSetting]: followActive });
        changed();
        if (id === null) {
          // The fixed tab let go at once: its own reload can't hold on to it while the active one is looked up.
          binding++;
          tabId = null;
          tabProvider = null;
          adapter.disconnect();
          changed();
          return void pick();
        }
        // The tab followed until now, if connected: its video paused once another tab is confirmed as the choice —
        // unless its site's control was turned off meanwhile (a site turned off is never driven).
        const before = id !== tabId && adapter.connected ? { tabId: tabId!, provider: adapter.provider } : null;
        // Chosen at once: events of the old tab, or an earlier lookup, can't take it back meanwhile.
        activations++;
        choosing++;
        binding++;
        select(id, chosenIn); // (its own window: confirmed below)
        tabProvider = null;
        const tab = await tabNow(id);
        if (mine !== intent || tabId !== id) return; // the user said otherwise since
        if (!tab || offSiteOf(tab.url) || (opts?.move && tab.windowId !== chosenIn)) {
          // Closed before the click arrived (its onRemoved may have come already), or its site turned off meanwhile:
          // another video tab of its window (the panel's, if it's gone) takes over. A move's tab dragged out of the
          // window the panel moves to: not followed there (the user picks again from that panel).
          release(opts?.move ? chosenIn : tab?.windowId ?? tabWindow);
        } else {
          // Another tab chosen: the video playing in the one followed until now is paused (a paused one stays so).
          if (before && (!isExperimental(before.provider) || on.has(before.provider))) pauseTab(before.tabId);
          // A tab of another window than the panel's: brought forward there (the user sees what they chose).
          // Not if the panel moved to another window meanwhile (the choice still holds; nothing brought forward), nor
          // for a move (the background brings it forward once the panel is in its window, decision 95). Detached: any
          // tab chosen, in whichever window (no window has the panel), while still detached.
          const wasDetached = detached;
          if (wasDetached || (!opts?.move && chosenIn !== undefined && tab.windowId !== chosenIn && windowId === chosenIn)) {
            // Its window as activated (it may have moved meanwhile); none if it couldn't be activated.
            // One after another, each only if still the latest choice: an older one finishing late can't leave its tab
            // active over a newer choice.
            const latest = () => mine === intent && tabId === id && (wasDetached ? detached : windowId === chosenIn);
            activating = activating.then(async () => {
              if (!latest()) return;
              const t = await browser.tabs.update(id, { active: true }).catch(() => undefined);
              if (t && latest()) await browser.windows.update(t.windowId, { focused: true }).catch(() => {});
            });
          }
          if (isVideoTab(tab.url)) await bind(id, tab.url, tab.windowId);
        }
      },
      setRoom: (room) => {
        // undefined: unknown (a room opened and not loaded yet): nothing taken over by itself until it is known.
        const siteChanged = room.site !== undefined && room.site !== site;
        site = room.site;
        if (room.inRoom && !inRoom) {
          // Into a room: a lookup still under way from out of one (the active tab) mustn't change its tab after.
          choosing++;
          activations++;
        }
        if (room.inRoom === inRoom) {
          // Another site for the room with nothing followed: a tab of it (the active one first) is taken.
          if (siteChanged && tabId === null && switching()) void pick();
          return;
        }
        inRoom = room.inRoom;
        // Out of the room: back to the active tab at once (the home screen shows what is watched now).
        if (!inRoom) void pick(); else if (tabId === null && site !== undefined && switching()) void pick(); // into one, its site known: a tab of it
      },
      openSite: async (site, chosenIn) => {
        // The room's type picked (decision 93): that site's tab of the panel's window is followed (fixed, even if
        // following the active tab before), else its home opens in a new tab, followed once it loads. Looked up here
        // and now, not from the panel's list (a site just turned on may not be listed yet).
        if (!(site in SITE_HOME)) return;
        const mine = ++intent;
        if (chosenIn !== undefined) windowId = chosenIn;
        followActive = false;
        void browser.storage.local.set({ [followActiveSetting]: false });
        changed();
        const home = SITE_HOME[site as keyof typeof SITE_HOME];
        // Every window's tabs of that site, the panel's window first.
        const all = await browser.tabs.query({ url: [`${new URL(home).origin}/*`] }).catch(() => []);
        const found = all.find((t) => t.windowId === windowId) ?? all[0];
        if (mine !== intent) return; // the user said otherwise since
        if (found?.id !== undefined) {
          activations++;
          choosing++;
          binding++;
          select(found.id, found.windowId);
          tabProvider = null;
          // Bound now if its site is on; one turned on a moment ago is bound when that lands (setOn).
          if (isVideoTab(found.url)) await bind(found.id, found.url, found.windowId);
          return;
        }
        const created = await browser.tabs.create({ url: home, windowId }).catch(() => null);
        if (created && mine === intent) take(created);
      },
    },
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
    open: (url, newTab, quiet) => {
      // Reuse the synced tab so the room keeps following it; the user asked for this navigation (quiet: the room
      // followed the host by itself — only the link changes, the tab isn't brought forward). A new tab
      // (the room's "open" button, entering a room) is followed once it loads, being the window's active video
      // tab — unless a tab of this window already has that video: that one is brought forward instead.
      const mine = ++intent;
      const opened = tabId !== null && !newTab
        ? browser.tabs.update(tabId, quiet ? { url } : { url, active: true })
        : (newTab ? tabShowing(url) : Promise.resolve(undefined)).then((tab) =>
            // In a playlist or mix (`list=`): back to the plain video, as opened (a mix differs per person).
            tab?.id === undefined ? Promise.reject()
            : browser.tabs.update(tab.id, tab.url && new URL(tab.url).searchParams.has('list') ? { url, active: true } : { active: true }));
      // Quiet with a chosen tab (fixed): a new one in the background, followed once it loads (take). Following the
      // active tab, only the active one can be followed: it opens in front.
      void opened.catch(() => browser.tabs.create({ url, windowId, active: !(quiet && !autoNow()) })).then((tab) => {
        if (!tab || mine !== intent) return;
        // Detached: a tab of another window than the one followed is brought forward there — seen, and (following the
        // active tab) followed, as a tab of the panel's own window would be.
        if (detached && tab.windowId !== windowId && !quiet) void browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
        take(tab);
      }, () => {});
    },
  };
}

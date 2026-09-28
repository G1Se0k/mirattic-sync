import { browser } from 'wxt/browser';
import type { Socket } from '@mirattic/client';
import type { Platform } from '@mirattic/ui';
import type { MediaPresence, MediaProvider, RoomContent } from '@mirattic/types';
import { RemoteAdapter } from '../../bridge';

const YOUTUBE = 'https://www.youtube.com/';
// Experimental control (docs/platform-policy/{netflix,laftel}.md): each is off until the user grants its
// optional host permission; while off, its tabs are invisible to us and nothing is injected into them.
const EXPERIMENTAL = {
  netflix: { site: 'https://www.netflix.com/', script: '/content-scripts/netflix.js' },
  laftel: { site: 'https://laftel.net/', script: '/content-scripts/laftel.js' },
} as const;
type Experimental = keyof typeof EXPERIMENTAL;
const EXPERIMENTS = Object.keys(EXPERIMENTAL) as Experimental[];
const isExperimental = (p: MediaProvider): p is Experimental => p in EXPERIMENTAL;
const originsOf = (p: Experimental) => ({ origins: [`${EXPERIMENTAL[p].site}*`] });
const PRESENCE_DELAY_MS = 300; // the server drops presence updates closer than 250ms

/**
 * The extension's platform: follows the video tab of this window — YouTube, or Netflix / Laftel once turned on;
 * the active one, else the last one used, else any — and exposes it as the room player, "now watching"
 * and the user's presence.
 */
export async function watch(): Promise<Platform> {
  const windowId = (await browser.windows.getCurrent()).id;
  let tabId: number | null = null;
  let content: RoomContent | null = null;
  let presence: MediaPresence | null = null;
  let socket: Socket | null = null;
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  const subscribers = new Set<() => void>();
  const changed = () => subscribers.forEach((s) => s());
  const granted = () => Promise.all(EXPERIMENTS.map(async (p) => [p, await browser.permissions.contains(originsOf(p))] as const));
  const on = new Set((await granted()).filter(([, ok]) => ok).map(([p]) => p));

  const sendPresence = () => {
    if (presenceTimer !== undefined) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = undefined;
      socket?.send({ type: 'presence:update', payload: presence });
    }, PRESENCE_DELAY_MS);
  };

  const adapter = new RemoteAdapter((p) => {
    presence = p;
    const next: RoomContent | null = p?.contentId
      ? { provider: p.provider, contentId: p.contentId, title: p.title, durationMs: p.durationMs, canonicalUrl: p.canonicalUrl, series: p.series }
      : null;
    // Same object while the video is the same, as useSyncExternalStore requires.
    if (next?.contentId !== content?.contentId || next?.title !== content?.title || (next?.durationMs ?? 0) !== (content?.durationMs ?? 0)
      || next?.series !== content?.series) {
      content = next;
      changed();
    }
    sendPresence();
  });

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
      // Turned off (or another tab chosen) while injecting: never connect, so nothing is read.
      if (!injected || mine !== binding || !on.has(provider)) return;
    }
    adapter.connect(id, provider);
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
  };
  // Also when the user revokes a permission in Chrome's settings.
  const recheck = async () => (await granted()).forEach(([p, ok]) => setOn(p, ok));
  browser.permissions.onAdded.addListener(() => void recheck());
  browser.permissions.onRemoved.addListener(() => void recheck());

  browser.tabs.onActivated.addListener(async (info) => {
    if (info.windowId !== windowId) return;
    const mine = ++activations;
    const tab = await browser.tabs.get(info.tabId).catch(() => null);
    // The user activated another tab meanwhile: its own handler decides. Only a video tab is a choice, so
    // switching to any other tab doesn't cancel a pending handover (pick() after the synced tab closed).
    if (mine !== activations || !isVideoTab(tab?.url)) return;
    await bind(info.tabId, tab!.url);
  });
  browser.tabs.onUpdated.addListener((id, change, tab) => {
    // The synced tab left the provider: another video tab in this window takes over. With none, the tab
    // stays ours, so "이 영상 열기" brings it back.
    if (id === tabId && change.url && providerOf(change.url) !== adapter.provider) void pick();
    // A reload or a fresh navigation to a video site starts without our script: reconnect (and reinject).
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

  return {
    adapter: (provider) => (provider === 'youtube' || (isExperimental(provider) && on.has(provider)) ? adapter.as(provider) : undefined),
    nowWatching: () => content,
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
      // permissions.request needs the click that called this; Chrome shows its own prompt.
      setEnabled: async (provider, enabled) => {
        if (!isExperimental(provider)) return false;
        const origins = originsOf(provider);
        const ok = enabled ? await browser.permissions.request(origins) : await browser.permissions.remove(origins);
        setOn(provider, await browser.permissions.contains(origins));
        return ok;
      },
    },
    open: (url) => {
      // Reuse the synced tab so the room keeps following it; the user asked for this navigation.
      const opened = tabId !== null ? browser.tabs.update(tabId, { url, active: true }) : Promise.reject();
      opened.catch(() => browser.tabs.create({ url, windowId }));
    },
  };
}

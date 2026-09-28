import { browser } from 'wxt/browser';
import type { Socket } from '@mirattic/client';
import type { Platform } from '@mirattic/ui';
import type { MediaPresence, RoomContent } from '@mirattic/types';
import { RemoteAdapter } from '../../bridge';

const YOUTUBE = 'https://www.youtube.com/';
const PRESENCE_DELAY_MS = 300; // the server drops presence updates closer than 250ms

/**
 * The extension's platform: follows the YouTube tab of this window — the active one, else the last one
 * used, else any — and exposes it as the room player, "now watching" and the user's presence.
 */
export async function youtubeWatch(): Promise<Platform> {
  const windowId = (await browser.windows.getCurrent()).id;
  let tabId: number | null = null;
  let content: RoomContent | null = null;
  let presence: MediaPresence | null = null;
  let socket: Socket | null = null;
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  const subscribers = new Set<() => void>();

  const sendPresence = () => {
    if (presenceTimer !== undefined) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = undefined;
      socket?.send({ type: 'presence:update', payload: presence });
    }, PRESENCE_DELAY_MS);
  };

  const adapter = new RemoteAdapter('youtube', (p) => {
    presence = p;
    const next: RoomContent | null = p?.contentId
      ? { provider: p.provider, contentId: p.contentId, title: p.title, durationMs: p.durationMs, canonicalUrl: p.canonicalUrl }
      : null;
    // Same object while the video is the same, as useSyncExternalStore requires.
    if (next?.contentId !== content?.contentId || next?.title !== content?.title || (next?.durationMs ?? 0) !== (content?.durationMs ?? 0)) {
      content = next;
      subscribers.forEach((s) => s());
    }
    sendPresence();
  });

  const bind = (id: number) => {
    if (id === tabId && adapter.connected) return;
    tabId = id;
    adapter.connect(id);
  };
  const isYouTube = (url?: string) => url?.startsWith(YOUTUBE) ?? false;

  /** The active YouTube tab of this window, else any, except one being closed. */
  const pick = async (closing?: number) => {
    const [active] = await browser.tabs.query({ active: true, windowId });
    const any = (await browser.tabs.query({ windowId, url: `${YOUTUBE}*` })).find((t) => t.id !== closing);
    const tab = isYouTube(active?.url) && active?.id !== closing ? active : any;
    if (tab?.id !== undefined) bind(tab.id);
  };
  await pick();

  browser.tabs.onActivated.addListener(async (info) => {
    if (info.windowId !== windowId) return;
    const tab = await browser.tabs.get(info.tabId).catch(() => null);
    if (isYouTube(tab?.url)) bind(info.tabId);
  });
  browser.tabs.onUpdated.addListener((id, change, tab) => {
    // The synced tab left YouTube: another YouTube tab in this window takes over. With none, the tab stays
    // ours, so "이 영상 열기" brings it back.
    if (id === tabId && change.url && !isYouTube(change.url)) void pick();
    // A reload or a fresh navigation to YouTube starts a new content script: reconnect.
    if (change.status === 'complete' && isYouTube(tab.url) && (id === tabId || (tab.active && tab.windowId === windowId))) {
      if (id !== tabId || !adapter.connected) {
        tabId = null;
        bind(id);
      }
    }
  });
  browser.tabs.onRemoved.addListener((id) => {
    if (id !== tabId) return;
    tabId = null;
    adapter.disconnect();
    void pick(id); // another YouTube tab in this window takes over
  });

  return {
    adapter: (provider) => (provider === 'youtube' ? adapter : undefined),
    nowWatching: () => content,
    subscribe: (onChange) => {
      subscribers.add(onChange);
      return () => void subscribers.delete(onChange);
    },
    connected: (s) => {
      socket = s;
      if (s && presence) sendPresence(); // the server forgets presence on disconnect
    },
    open: (url) => {
      // Reuse the synced tab so the room keeps following it; the user asked for this navigation.
      const opened = tabId !== null ? browser.tabs.update(tabId, { url, active: true }) : Promise.reject();
      opened.catch(() => browser.tabs.create({ url, windowId }));
    },
  };
}

import { browser, type Browser } from 'wxt/browser';
import type { MediaPresence, MediaProvider, MediaProviderAdapter, PlayerSnapshot } from '@mirattic/types';
import { seekInPage as netflixSeek } from './providers/netflix';

// Side panel ⇄ provider content script over a port opened by the side panel (plan.md decision 29).
// Content scripts only accept ports from this extension, never from the page.

export const PORT_NAME = 'mirattic-player';

export type PortRequest = { id: number; op: 'snapshot' | 'play' | 'pause' | 'seek'; positionMs?: number };

export type PortMessage =
  | { id: number; snapshot: PlayerSnapshot | null } // reply to a request
  | { change: PlayerSnapshot | null; presence: MediaPresence | null }; // pushed on every change

type Served = MediaProviderAdapter & { onGone(callback: () => void): () => void };

/**
 * Content script side: answers requests and pushes changes to whoever connects (the side panel).
 * The adapter exists only while connected: the side panel connects only after the user's consent,
 * so nothing is read from the page before that.
 */
export function serveAdapter(create: () => Served) {
  // Injected again after an extension update or on every rebind: one live copy per page answers. A copy left
  // over from before an update can't (its runtime is gone), so it doesn't block the new one.
  const g = globalThis as { miratticServing?: () => boolean };
  if (g.miratticServing?.()) return;
  g.miratticServing = () => !!browser.runtime?.id;

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    const adapter = create();
    const push = async (change: PlayerSnapshot | null) =>
      port.postMessage({ change, presence: change && (await adapter.getPresence()) } satisfies PortMessage);
    const offChange = adapter.onChange((s) => void push(s));
    const offGone = adapter.onGone(() => void push(null));
    void adapter.getSnapshot().then(push);

    port.onMessage.addListener(async (req: PortRequest) => {
      if (req.op === 'play') await adapter.play();
      else if (req.op === 'pause') await adapter.pause();
      else if (req.op === 'seek' && Number.isFinite(req.positionMs)) await adapter.seek(req.positionMs!);
      port.postMessage({ id: req.id, snapshot: await adapter.getSnapshot() } satisfies PortMessage);
    });
    port.onDisconnect.addListener(() => {
      offChange();
      offGone();
      adapter.destroy();
    });
  });
}

const REPLY_TIMEOUT_MS = 1000;

/** Providers whose page blocks seeking through <video>: the side panel seeks in the page's world instead. */
const PAGE_SEEK: Partial<Record<MediaProvider, { site: string; seek: (positionMs: number) => boolean }>> = {
  netflix: { site: 'https://www.netflix.com/', seek: netflixSeek },
};

/**
 * Side panel side: a `MediaProviderAdapter` for whatever tab is connected. With no tab (or a dead one)
 * snapshots are null, which the sync engine reports as "waiting".
 */
export class RemoteAdapter implements MediaProviderAdapter {
  provider: MediaProvider = 'youtube';
  private port: Browser.runtime.Port | null = null;
  private tabId: number | null = null;
  /** The page seek failed on this tab (API gone): members are told where to go instead. */
  private pageSeekFailed = false;
  private views = new Map<MediaProvider, MediaProviderAdapter>();
  private presence: MediaPresence | null = null;
  private nextId = 0;
  private replies = new Map<number, (s: PlayerSnapshot | null) => void>();
  private listeners = new Set<(s: PlayerSnapshot) => void>();
  private goneListeners = new Set<() => void>();

  /** Heard from the tab since connecting: a port that closes before that found no live script there. */
  private heard = false;

  constructor(
    /** Every change of what the tab shows, including losing it (null). */
    private readonly onPresence: (presence: MediaPresence | null) => void,
    /** The tab had no script answering (opened before install / update). */
    private readonly onDead?: (tabId: number, provider: MediaProvider) => void,
  ) {}

  get connected() {
    return this.port !== null;
  }

  get seekable() {
    return !this.pageSeekFailed;
  }

  connect(tabId: number, provider: MediaProvider) {
    this.disconnect();
    this.provider = provider;
    this.tabId = tabId;
    this.pageSeekFailed = false;
    this.heard = false;
    const port = browser.tabs.connect(tabId, { name: PORT_NAME });
    this.port = port;
    port.onMessage.addListener((m: PortMessage) => {
      this.heard = true;
      if ('id' in m) {
        this.replies.get(m.id)?.(m.snapshot);
        this.replies.delete(m.id);
        return;
      }
      this.setPresence(m.presence);
      if (m.change) for (const l of this.listeners) l(m.change);
      else this.goneListeners.forEach((l) => l()); // left the watch page
    });
    // Also fires right away when the tab has no content script (not YouTube, or opened before install).
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      const dead = !this.heard;
      this.drop();
      if (dead) this.onDead?.(tabId, provider);
    });
  }

  disconnect() {
    this.port?.disconnect();
    this.drop();
  }

  detect() {
    return this.connected;
  }

  async getPresence() {
    return this.presence;
  }

  getSnapshot() {
    return this.request({ op: 'snapshot' });
  }

  async play() {
    await this.request({ op: 'play' });
  }

  async pause() {
    await this.request({ op: 'pause' });
  }

  async seek(positionMs: number) {
    const pageSeek = PAGE_SEEK[this.provider];
    if (!pageSeek) {
      await this.request({ op: 'seek', positionMs });
      return;
    }
    const { port, tabId } = this;
    if (!port || tabId === null) return;
    // Only into the connection this seek was meant for: the tab may have moved to another site (the
    // rebind is async), and a late answer must not mark a newer connection as failed.
    const current = () => this.port === port;
    let ok = false;
    try {
      if (!(await browser.tabs.get(tabId)).url?.startsWith(pageSeek.site) || !current()) return;
      const [done] = await browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageSeek.seek, args: [positionMs] });
      ok = done?.result === true;
    } catch {
      // tab closed or navigated away mid-call: treated like a failed seek below, if still current
    }
    if (!ok && current()) this.pageSeekFailed = true;
  }

  onChange(callback: (s: PlayerSnapshot) => void) {
    this.listeners.add(callback);
    return () => void this.listeners.delete(callback);
  }

  /** The video went away: left the watch page, or the tab closed / moved to another site. */
  onGone(callback: () => void) {
    this.goneListeners.add(callback);
    return () => void this.goneListeners.delete(callback);
  }

  destroy() {
    this.disconnect();
    this.listeners.clear();
    this.goneListeners.clear();
  }

  /**
   * This adapter as a player of `provider` only: while the tab shows another provider it has no player,
   * so a room never takes one provider's content id for another's.
   */
  as(provider: MediaProvider): MediaProviderAdapter {
    let view = this.views.get(provider);
    if (view) return view;
    const mine = () => this.provider === provider && this.connected;
    const remote = this;
    view = {
      provider,
      get seekable() {
        return !mine() || remote.seekable;
      },
      detect: mine,
      getPresence: async () => (mine() ? this.presence : null),
      getSnapshot: () => (mine() ? this.getSnapshot() : Promise.resolve(null)),
      play: async () => void (mine() && (await this.play())),
      pause: async () => void (mine() && (await this.pause())),
      seek: async (ms) => void (mine() && (await this.seek(ms))),
      onChange: (callback) => this.onChange((s) => mine() && callback(s)),
      // Not `mine()`: the connection is already gone when a closed tab reports it.
      onGone: (callback) => this.onGone(() => this.provider === provider && callback()),
      destroy: () => {},
    };
    this.views.set(provider, view);
    return view;
  }

  private request(req: Omit<PortRequest, 'id'>) {
    const port = this.port;
    if (!port) return Promise.resolve(null);
    const id = ++this.nextId;
    return new Promise<PlayerSnapshot | null>((resolve) => {
      const timer = setTimeout(() => {
        this.replies.delete(id);
        resolve(null);
      }, REPLY_TIMEOUT_MS);
      this.replies.set(id, (s) => {
        clearTimeout(timer);
        resolve(s);
      });
      port.postMessage({ ...req, id } satisfies PortRequest);
    });
  }

  private drop() {
    const had = this.port !== null;
    this.port = null;
    this.tabId = null;
    for (const reply of this.replies.values()) reply(null);
    this.replies.clear();
    this.setPresence(null);
    if (had) this.goneListeners.forEach((l) => l());
  }

  private setPresence(presence: MediaPresence | null) {
    this.presence = presence;
    this.onPresence(presence);
  }
}

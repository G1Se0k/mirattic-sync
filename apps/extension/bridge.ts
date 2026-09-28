import { browser, type Browser } from 'wxt/browser';
import type { MediaPresence, MediaProviderAdapter, PlayerSnapshot } from '@mirattic/types';

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

/**
 * Side panel side: a `MediaProviderAdapter` for whatever tab is connected. With no tab (or a dead one)
 * snapshots are null, which the sync engine reports as "waiting".
 */
export class RemoteAdapter implements MediaProviderAdapter {
  private port: Browser.runtime.Port | null = null;
  private presence: MediaPresence | null = null;
  private nextId = 0;
  private replies = new Map<number, (s: PlayerSnapshot | null) => void>();
  private listeners = new Set<(s: PlayerSnapshot) => void>();

  constructor(
    readonly provider: MediaProviderAdapter['provider'],
    /** Every change of what the tab shows, including losing it (null). */
    private readonly onPresence: (presence: MediaPresence | null) => void,
  ) {}

  get connected() {
    return this.port !== null;
  }

  connect(tabId: number) {
    this.disconnect();
    const port = browser.tabs.connect(tabId, { name: PORT_NAME });
    this.port = port;
    port.onMessage.addListener((m: PortMessage) => {
      if ('id' in m) {
        this.replies.get(m.id)?.(m.snapshot);
        this.replies.delete(m.id);
        return;
      }
      this.setPresence(m.presence);
      if (m.change) for (const l of this.listeners) l(m.change);
    });
    // Also fires right away when the tab has no content script (not YouTube, or opened before install).
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.drop();
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
    await this.request({ op: 'seek', positionMs });
  }

  onChange(callback: (s: PlayerSnapshot) => void) {
    this.listeners.add(callback);
    return () => void this.listeners.delete(callback);
  }

  destroy() {
    this.disconnect();
    this.listeners.clear();
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
    this.port = null;
    for (const reply of this.replies.values()) reply(null);
    this.replies.clear();
    this.setPresence(null);
  }

  private setPresence(presence: MediaPresence | null) {
    this.presence = presence;
    this.onPresence(presence);
  }
}

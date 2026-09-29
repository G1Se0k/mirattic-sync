import { watchUrl, type MediaPresence, type MediaProviderAdapter, type PlayerSnapshot } from '@mirattic/types';

const EVENTS = ['play', 'pause', 'seeked', 'playing', 'loadedmetadata'];

/**
 * Drives the provider page's own <video> from a content script, like its keyboard shortcuts.
 * Subclasses hold the provider's page structure (selectors, URL format, ads) — only there.
 */
export abstract class PageVideoAdapter implements MediaProviderAdapter {
  abstract readonly provider: 'youtube' | 'netflix' | 'laftel';
  private listeners = new Set<(s: PlayerSnapshot) => void>();
  private goneListeners = new Set<() => void>();
  private readonly stop: () => void;

  protected abstract video(): HTMLVideoElement | null;
  /** The content id in the URL, or null off a watch page. */
  protected abstract contentId(): string | null;
  protected abstract title(): string;
  /** The episode number, where the page names one apart from the title (Laftel's "Title 3화"). */
  protected episode(): number | undefined {
    return undefined;
  }
  /** The channel the video belongs to, where the provider has one (YouTube). */
  protected channel(): string | undefined {
    return undefined;
  }
  /** What the content belongs to (playlist, show): members follow the host within it without being asked. */
  protected series(): string | undefined {
    return undefined;
  }
  protected adPlaying() {
    return false;
  }
  /** Runs with every check (every second at least): for page chores of a provider. */
  protected tick() {}

  constructor() {
    // Any <video>: a player may swap in a new element for the next episode while the old one is still first
    // in the page. emit() reads the provider's own choice of video anyway.
    const onMedia = (e: Event) => {
      if (e.target instanceof HTMLVideoElement) this.emit();
    };
    // Media events don't bubble, but capture sees them — also on a <video> swapped in later.
    for (const type of EVENTS) document.addEventListener(type, onMedia, true);
    // An ad starting / ending and in-page navigation change no media event we can rely on: checked every second,
    // and at once when the tab title or the URL changes (a new video shows up without waiting for the poll).
    let last = '';
    const check = () => {
      this.tick();
      // series: a playlist joined mid-video; the video's state: a next episode whose events we missed; the title
      const video = this.video();
      const key = `${this.contentId()}|${this.adPlaying()}|${this.series()}|${video ? video.paused : 'none'}|${this.title()}|${this.channel()}|${this.episode()}`;
      if (key !== last) {
        last = key;
        this.emit();
      }
    };
    const poll = setInterval(check, 1000);
    const titles = new MutationObserver(check);
    titles.observe(document.head ?? document.documentElement, { subtree: true, childList: true, characterData: true });
    let soon: ReturnType<typeof setTimeout> | undefined;
    const onNavigate = () => {
      clearTimeout(soon);
      soon = setTimeout(check, 0); // after the URL has changed
    };
    const navigation = (globalThis as { navigation?: EventTarget }).navigation;
    navigation?.addEventListener('navigate', onNavigate);
    this.stop = () => {
      for (const type of EVENTS) document.removeEventListener(type, onMedia, true);
      clearInterval(poll);
      titles.disconnect();
      clearTimeout(soon);
      navigation?.removeEventListener('navigate', onNavigate);
    };
  }

  detect() {
    return this.contentId() !== null;
  }

  async getSnapshot(): Promise<PlayerSnapshot | null> {
    const video = this.video();
    const contentId = this.contentId();
    if (!video || !contentId) return null;
    return {
      contentId,
      positionMs: Math.round(video.currentTime * 1000),
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
      playing: !video.paused && !video.ended,
      capturedAt: Date.now(),
      adPlaying: this.adPlaying(),
    };
  }

  async getPresence(): Promise<MediaPresence | null> {
    const s = await this.getSnapshot();
    if (!s) return null;
    return {
      provider: this.provider,
      contentId: s.contentId,
      title: this.title(),
      channel: this.channel(),
      episode: this.episode(),
      canonicalUrl: watchUrl({ provider: this.provider, contentId: s.contentId }),
      series: this.series(),
      // During an ad the <video> reports the ad's time and length.
      positionMs: s.adPlaying ? undefined : s.positionMs,
      durationMs: s.adPlaying ? undefined : s.durationMs,
      playing: s.playing,
      capturedAt: s.capturedAt,
    };
  }

  // Commands are ignored during an ad: the sync never skips, seeks or pauses through one.
  async play() {
    const video = this.controllable();
    await video?.play().catch(() => {}); // autoplay policy may refuse without a user gesture
  }

  async pause() {
    this.controllable()?.pause();
  }

  async seek(positionMs: number) {
    const video = this.controllable();
    if (video) video.currentTime = Math.max(0, positionMs) / 1000;
  }

  onChange(callback: (s: PlayerSnapshot) => void) {
    this.listeners.add(callback);
    return () => void this.listeners.delete(callback);
  }

  /** No video to sync any more (left the watch page). `onChange` never reports that. */
  onGone(callback: () => void) {
    this.goneListeners.add(callback);
    return () => void this.goneListeners.delete(callback);
  }

  destroy() {
    this.stop();
    this.listeners.clear();
    this.goneListeners.clear();
  }

  private controllable() {
    return this.adPlaying() ? null : this.video();
  }

  private async emit() {
    const s = await this.getSnapshot();
    if (s) for (const l of this.listeners) l(s);
    else for (const l of this.goneListeners) l();
  }
}

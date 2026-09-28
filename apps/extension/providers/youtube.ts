import { watchUrl, type MediaPresence, type MediaProviderAdapter, type PlayerSnapshot } from '@mirattic/types';

// YouTube page structure lives only here (docs/platform-policy/youtube.md). What we read: the video id
// in the URL, the tab title, and the <video>'s play state. We never touch ads or add anything to the page.
const VIDEO = '#movie_player video';
const PLAYER = '#movie_player';
const AD_CLASS = 'ad-showing';
const EVENTS = ['play', 'pause', 'seeked', 'playing', 'loadedmetadata'];

/** Runs in the youtube.com content script and drives the page's own <video>, like its keyboard shortcuts. */
export class YouTubeAdapter implements MediaProviderAdapter {
  readonly provider = 'youtube' as const;
  private listeners = new Set<(s: PlayerSnapshot) => void>();
  private goneListeners = new Set<() => void>();
  private readonly stop: () => void;

  constructor() {
    const onMedia = (e: Event) => {
      if (e.target === this.video()) this.emit();
    };
    // Media events don't bubble, but capture sees them — also on a <video> swapped in later.
    for (const type of EVENTS) document.addEventListener(type, onMedia, true);
    // An ad starting / ending and in-page navigation change no media event we can rely on: poll them.
    let last = '';
    const poll = setInterval(() => {
      const key = `${this.videoId()}|${this.adPlaying()}`;
      if (key !== last) {
        last = key;
        this.emit();
      }
    }, 1000);
    this.stop = () => {
      for (const type of EVENTS) document.removeEventListener(type, onMedia, true);
      clearInterval(poll);
    };
  }

  detect() {
    return location.hostname === 'www.youtube.com';
  }

  async getSnapshot(): Promise<PlayerSnapshot | null> {
    const video = this.video();
    const contentId = this.videoId();
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
      title: title(),
      canonicalUrl: watchUrl({ provider: this.provider, contentId: s.contentId }),
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

  private video() {
    return document.querySelector<HTMLVideoElement>(VIDEO);
  }

  private controllable() {
    return this.adPlaying() ? null : this.video();
  }

  private adPlaying() {
    return document.querySelector(PLAYER)?.classList.contains(AD_CLASS) ?? false;
  }

  private videoId() {
    const id = location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
    return id && watchUrl({ provider: 'youtube', contentId: id }) ? id : null;
  }

  private async emit() {
    const s = await this.getSnapshot();
    if (s) for (const l of this.listeners) l(s);
    else for (const l of this.goneListeners) l();
  }
}

/** "(3) Title - YouTube" → "Title" (the count is unread notifications). */
export function title(raw = document.title) {
  return raw.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').slice(0, 300) || 'YouTube';
}

import { watchUrl } from '@mirattic/types';
import { PageVideoAdapter } from './page-video';

// Netflix page structure lives only here (docs/platform-policy/netflix.md). Experimental, off by default:
// injected only into the synced tab after the user turned it on. What we read: the id in /watch/<id>,
// the tab title, and the <video>'s play state — no other page content.
const WATCH_PATH = /^\/watch\/(\d{1,12})(?:\/|$)/;

function watchId(pathname: string) {
  const found = WATCH_PATH.exec(pathname)?.[1] ?? null;
  return found && watchUrl({ provider: 'netflix', contentId: found }) ? found : null;
}

/** The page's Navigation API (Chrome 102+), shared with content scripts like other DOM events. */
const navigation = () => (globalThis as { navigation?: EventTarget }).navigation;

export class NetflixAdapter extends PageVideoAdapter {
  readonly provider = 'netflix' as const;
  private run: string | null = null;
  // Every in-page navigation, however quick (a poll could miss /watch/A → /browse → /watch/B in one second).
  private readonly onNavigate = (e: Event) => {
    const url = (e as Event & { destination?: { url: string } }).destination?.url;
    if (url) this.run = episodeRun(this.run, watchId(new URL(url).pathname));
  };

  constructor() {
    super();
    navigation()?.addEventListener('navigate', this.onNavigate);
  }

  override destroy() {
    navigation()?.removeEventListener('navigate', this.onNavigate);
    super.destroy();
  }

  protected video() {
    // Around the next episode the player may hold two <video>s (the one that ended and the next): the playing
    // one, else the newest. Previews elsewhere don't count, as contentId() is null there.
    const all = [...document.querySelectorAll<HTMLVideoElement>('video')];
    return all.find((v) => !v.paused && !v.ended) ?? all.at(-1) ?? null;
  }

  protected contentId() {
    const id = watchId(location.pathname);
    this.run = episodeRun(this.run, id); // also polled every second
    return id;
  }

  protected override series() {
    return this.run ?? undefined;
  }

  private readonly lines = new TitleLines();

  protected title() {
    return this.lines.see(this.contentId(), playerTitle()) ?? title();
  }

  // Writing currentTime makes Netflix stop with error M7375: the side panel seeks with `seekInPage` instead.
  override async seek() {}
}

/**
 * Seeks with Netflix's own player API. Run by the side panel in the page's world (`scripting.executeScript`,
 * world MAIN) of the followed tab only, so it must not reference anything outside itself.
 * Unofficial and undocumented (plan.md decision 66): false when it isn't there, and the side panel falls
 * back to telling members where to go.
 */
export function seekInPage(positionMs: number): boolean {
  try {
    // The tab may have navigated between the side panel's URL check and this run: act only on Netflix.
    if (window.location.origin !== 'https://www.netflix.com') return false;
    type Player = { seek(ms: number): void };
    type VideoPlayer = { getAllPlayerSessionIds(): string[]; getVideoPlayerBySessionId(id: string): Player };
    type Page = { netflix: { appContext: { state: { playerApp: { getAPI(): { videoPlayer: VideoPlayer } } } } } };
    const api = (window as unknown as Page).netflix.appContext.state.playerApp.getAPI().videoPlayer;
    const ids = api.getAllPlayerSessionIds();
    const id = ids.find((s) => s.startsWith('watch')) ?? ids[0];
    if (!id) return false;
    api.getVideoPlayerBySessionId(id).seek(Math.max(0, Math.round(positionMs)));
    return true;
  } catch {
    return false;
  }
}

/**
 * The URL has no show id, and we read nothing else from the page. Episodes the player moves through without
 * leaving the watch page (next episode, autoplay) count as one series, named after the first one; leaving the
 * watch page (or a reload) starts a new one, so the members are asked again.
 */
export function episodeRun(run: string | null, id: string | null) {
  return id === null ? null : (run ?? id);
}

/**
 * The player's title line, remembered per episode (it is in the page only while the controls show). A new episode
 * takes a line only once it differs from the last line seen before it — the previous episode's may still be on
 * screen while the next one loads, even after a stop at the browse page.
 */
export class TitleLines {
  private readonly titles = new Map<string, string>();
  private id: string | null = null;
  private last: string | null = null;
  private stale: string | null = null;

  see(id: string | null, shown: string | null): string | undefined {
    if (id !== this.id) {
      if (id) this.stale = this.last;
      this.id = id;
    }
    if (shown) {
      if (id && shown !== this.stale) {
        this.stale = null;
        this.titles.set(id, shown);
      }
      this.last = shown;
    }
    return id ? this.titles.get(id) : undefined;
  }
}

/** The title line of Netflix's player ("킹덤 · S2:E3 · 제3화"), or null while it isn't shown. */
export function playerTitle(root: ParentNode = document) {
  const line = root.querySelector('[data-uia="video-title"]');
  if (!line) return null;
  const parts = [...line.childNodes].map((n) => n.textContent?.trim()).filter((t): t is string => !!t);
  const text = (parts.length > 0 ? parts.join(' · ') : line.textContent?.trim() ?? '').slice(0, 300);
  return text || null;
}

/** The tab title if it names the title ("Title - Netflix"); the watch page is often just "Netflix". */
export function title(raw = document.title) {
  return raw.replace(/\s*[-|]\s*Netflix$/, '').trim().slice(0, 300).replace(/^Netflix$/, '') || 'Netflix 콘텐츠';
}

export type NetflixMetadata = {
  title: string;
  showId: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  /** A show whose episode list hasn't loaded this episode yet: usable, but read again. */
  partial?: boolean;
};

/**
 * What is playing, from Netflix's own page data (its title isn't in the tab title or the URL). Run by the
 * background in the page's world (like `seekInPage`), so it must not reference anything outside itself.
 * Unofficial (plan.md decision 73): null when the data isn't there (yet), and the adapter's tab-title
 * fallback is kept.
 */
export function metadataInPage(id: string): NetflixMetadata | null {
  try {
    if (window.location.origin !== 'https://www.netflix.com') return null;
    type Episode = { id?: number; episodeId?: number; seq?: number; title?: string };
    type Video = { id: number; title: string; type?: string; seasons?: { seq?: number; episodes?: Episode[] }[] };
    type Page = { netflix: { appContext: { state: { playerApp: { getState(): {
      videoPlayer: { videoMetadata: Record<string, { _metadata?: { video?: Video } }> } } } } } } };
    const video = (window as unknown as Page).netflix.appContext.state.playerApp.getState().videoPlayer.videoMetadata[id]?._metadata?.video;
    // Half-loaded data is not an answer (the caller tries again): a real title and a numeric show id, or nothing.
    const title = typeof video?.title === 'string' ? video.title.trim() : '';
    const showId = String(video?.id ?? '');
    if (!title || !/^\d{1,20}$/.test(showId)) return null;
    const out: NetflixMetadata = { title: title.slice(0, 200), showId };
    for (const season of video?.seasons ?? []) {
      for (const e of season.episodes ?? []) {
        if (String(e.id ?? e.episodeId) === id) {
          return { ...out, season: season.seq, episode: e.seq, episodeTitle: e.title ? String(e.title).slice(0, 200) : undefined };
        }
      }
    }
    return video?.type === 'show' ? { ...out, partial: true } : out;
  } catch {
    return null;
  }
}

/** "Title S2:E3 Name" for the room and the friend list. */
export function describeMetadata(m: NetflixMetadata) {
  const where = m.season !== undefined && m.episode !== undefined ? ` 시즌 ${m.season} ${m.episode}화` : '';
  return `${m.title}${where}${m.episodeTitle ? ` · ${m.episodeTitle}` : ''}`.slice(0, 300);
}

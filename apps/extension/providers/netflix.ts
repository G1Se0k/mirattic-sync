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
    // A watch page plays a single <video>; previews elsewhere don't count as contentId() is null there.
    return document.querySelector<HTMLVideoElement>('video');
  }

  protected contentId() {
    const id = watchId(location.pathname);
    this.run = episodeRun(this.run, id); // also polled every second
    return id;
  }

  protected override series() {
    return this.run ?? undefined;
  }

  protected title() {
    return title();
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

/** The tab title if it names the title ("Title - Netflix"); the watch page is often just "Netflix". */
export function title(raw = document.title) {
  return raw.replace(/\s*[-|]\s*Netflix$/, '').trim().slice(0, 300).replace(/^Netflix$/, '') || 'Netflix 콘텐츠';
}

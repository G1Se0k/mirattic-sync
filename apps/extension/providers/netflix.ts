import { watchUrl } from '@mirattic/types';
import { PageVideoAdapter } from './page-video';

// Netflix page structure lives only here (docs/platform-policy/netflix.md). Experimental, off by default:
// injected only into the synced tab after the user turned it on. What we read: the id in /watch/<id>,
// the tab title, and the <video>'s play state — no other page content.
const WATCH_PATH = /^\/watch\/(\d{1,12})(?:\/|$)/;

export class NetflixAdapter extends PageVideoAdapter {
  readonly provider = 'netflix' as const;

  protected video() {
    // A watch page plays a single <video>; previews elsewhere don't count as contentId() is null there.
    return document.querySelector<HTMLVideoElement>('video');
  }

  protected contentId() {
    const id = WATCH_PATH.exec(location.pathname)?.[1] ?? null;
    return id && watchUrl({ provider: 'netflix', contentId: id }) ? id : null;
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

/** The tab title if it names the title ("Title - Netflix"); the watch page is often just "Netflix". */
export function title(raw = document.title) {
  return raw.replace(/\s*[-|]\s*Netflix$/, '').trim().slice(0, 300).replace(/^Netflix$/, '') || 'Netflix 콘텐츠';
}

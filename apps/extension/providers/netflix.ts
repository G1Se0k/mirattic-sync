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

  // Writing currentTime makes Netflix stop with error M7375; the way around it is Netflix's internal
  // player API, which we don't call. The side panel treats Netflix as unseekable (bridge.ts `SEEKABLE`)
  // and tells members where to go instead.
  override async seek() {}
}

/** The tab title if it names the title ("Title - Netflix"); the watch page is often just "Netflix". */
export function title(raw = document.title) {
  return raw.replace(/\s*[-|]\s*Netflix$/, '').trim().slice(0, 300).replace(/^Netflix$/, '') || 'Netflix 콘텐츠';
}

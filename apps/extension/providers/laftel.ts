import { watchUrl } from '@mirattic/types';
import { PageVideoAdapter } from './page-video';

// Laftel page structure lives only here (docs/platform-policy/laftel.md). Experimental, off by default:
// injected only into the synced tab after the user turned it on. What we read: the ids in
// /player/<item>/<episode>, the tab title, and the <video>'s play state — no other page content.
const PLAYER_PATH = /^\/player\/(\d{1,10})\/(\d{1,10})(?:\/|$)/;

export class LaftelAdapter extends PageVideoAdapter {
  readonly provider = 'laftel' as const;

  protected video() {
    // The player page plays a single <video>; contentId() is null anywhere else.
    return document.querySelector<HTMLVideoElement>('video');
  }

  protected contentId() {
    const m = PLAYER_PATH.exec(location.pathname);
    const id = m ? `${m[1]}/${m[2]}` : null;
    return id && watchUrl({ provider: 'laftel', contentId: id }) ? id : null;
  }

  protected title() {
    return title();
  }
}

/** The tab title without the site name ("Title - 라프텔"); just the site name → a generic label. */
export function title(raw = document.title) {
  return raw.replace(/\s*[-|]\s*(라프텔|laftel).*$/i, '').trim().slice(0, 300).replace(/^(라프텔|laftel)$/i, '') || 'Laftel 콘텐츠';
}

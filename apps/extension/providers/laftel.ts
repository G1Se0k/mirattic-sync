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

  // "장송의 프리렌 3화" → title "장송의 프리렌" and episode 3, so the friend list shows them on two lines (as for
  // Netflix); the room's title joins them again (contentTitle).
  protected title() {
    return splitEpisode(title()).title;
  }

  protected override episode() {
    return splitEpisode(title()).episode;
  }

  // The item id: every episode of a show shares it.
  protected override series() {
    return PLAYER_PATH.exec(location.pathname)?.[1];
  }
}

/** A trailing whole "N화" as the episode; anything else (no number, "1.5화") stays in the title. */
export function splitEpisode(full: string): { title: string; episode?: number } {
  const m = /^(.+?)\s+(\d{1,4})화$/.exec(full);
  return m ? { title: m[1]!, episode: Number(m[2]) } : { title: full };
}

/** The tab title without the site name ("Title - 라프텔") or "다시보기"; just the site name → a generic label. */
export function title(raw = document.title) {
  return raw.replace(/\s*[-|]\s*(라프텔|laftel).*$/i, '').replace(/\s*다시\s*보기\s*/g, ' ')
    .replace(/^[\s|-]+|[\s|-]+$/g, '').slice(0, 300)
    .replace(/^(라프텔|laftel)$/i, '') || 'Laftel 콘텐츠';
}

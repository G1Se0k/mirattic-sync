import { watchUrl } from '@mirattic/types';
import { PageVideoAdapter } from './page-video';

// YouTube page structure lives only here (docs/platform-policy/youtube.md). What we read: the video id
// in the URL, the tab title, and the <video>'s play state. We never touch ads or add anything to the page.
const VIDEO = '#movie_player video';
const PLAYER = '#movie_player';
const AD_CLASS = 'ad-showing';

export class YouTubeAdapter extends PageVideoAdapter {
  readonly provider = 'youtube' as const;

  protected video() {
    return document.querySelector<HTMLVideoElement>(VIDEO);
  }

  protected override adPlaying() {
    return document.querySelector(PLAYER)?.classList.contains(AD_CLASS) ?? false;
  }

  protected contentId() {
    const id = location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
    return id && watchUrl({ provider: 'youtube', contentId: id }) ? id : null;
  }

  protected title() {
    return title();
  }
}

/** "(3) Title - YouTube" → "Title" (the count is unread notifications). */
export function title(raw = document.title) {
  return raw.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').slice(0, 300) || 'YouTube';
}

import { watchUrl } from '@mirattic/types';
import { PageVideoAdapter } from './page-video';
import { TitleLines } from './title-lines';

// YouTube page structure lives only here (docs/platform-policy/youtube.md). What we read: the video id
// in the URL, the tab title, and the <video>'s play state. We never touch ads or add anything to the page.
const VIDEO = '#movie_player video';
const PLAYER = '#movie_player';
const AD_CLASS = 'ad-showing';
const TITLE_LINK = '#movie_player a.ytp-title-link';

/** The video id in a player link (`…/watch?v=<id>`), if any. */
export function playerVideoId(href: string) {
  try {
    return new URL(href).searchParams.get('v');
  } catch {
    return null;
  }
}

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

  private readonly lines = new TitleLines();

  // The player's title link names the video it belongs to, so it is never the previous video's; the tab title
  // lags behind a switch (first "YouTube", then possibly the previous title) and is used only once it changed.
  protected title() {
    const id = this.contentId();
    const link = document.querySelector<HTMLAnchorElement>(TITLE_LINK);
    const linked = link && id && playerVideoId(link.href) === id ? link.textContent?.trim() || null : null;
    const tab = title();
    return this.lines.see(id, linked ?? (tab === 'YouTube' ? null : tab), !!linked) ?? 'YouTube';
  }

  protected override series() {
    return playlist();
  }
}

/** The playlist in the URL (`list=`), if any: videos of one playlist are one series. */
export function playlist(search = location.search) {
  const list = new URLSearchParams(search).get('list');
  return list && /^[A-Za-z0-9_-]{2,128}$/.test(list) ? list : undefined;
}

/** "(3) Title - YouTube" → "Title" (the count is unread notifications). */
export function title(raw = document.title) {
  return raw.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').slice(0, 300) || 'YouTube';
}

import { watchUrl } from '@mirattic/types';
import { PageVideoAdapter } from './page-video';
import { TitleLines } from './title-lines';

// YouTube page structure lives only here (docs/platform-policy/youtube.md). What we read: the video id
// in the URL, the tab title, and the <video>'s play state. We never touch ads or add anything to the page.
const VIDEO = '#movie_player video';
const PLAYER = '#movie_player';
const AD_CLASS = 'ad-showing';
const TITLE_LINK = '#movie_player a.ytp-title-link';
/** The seek bar: pressing it starts a drag (pause → moves → play), told apart from a real pause (decision 86). */
const SEEK_BAR = '#movie_player .ytp-progress-bar-container';
/** The owner line under the video; the watch page element names the video it shows (`video-id`). */
const CHANNEL = (id: string) => `ytd-watch-flexy[video-id="${id}"] ytd-video-owner-renderer ytd-channel-name a`;
/**
 * Premium's miniplayer: the player keeps playing in a corner while the user browses other pages (the URL is the
 * page browsed). Nothing in the player names its video, so: for a playlist or mix, the selected item of the playlist
 * panel — only if its title and length are the player's own (two songs in a row can share a title); without one, the
 * video of the watch page the miniplayer was seen opening from (by its URL), while the player's title and length are
 * still that video's.
 */
const MINIPLAYER_ON = 'ytd-app[miniplayer-is-active]';
const PLAYING_ITEM = 'ytd-playlist-panel-video-renderer[selected]';
/** The watch page's own title line for this video (the page element names its video). */
const WATCH_TITLE = (id: string) => `ytd-watch-flexy[video-id="${id}"] ytd-watch-metadata h1`;
const ITEM_LENGTH = 'ytd-thumbnail-overlay-time-status-renderer #text, .ytBadgeShapeText';

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
  private held = false;
  private readonly unlisten: () => void;

  constructor() {
    super();
    // Only whether the bar is pressed: no position, no other input.
    const down = (e: Event) => {
      if (e.target instanceof Element && e.target.closest(SEEK_BAR)) this.held = true;
    };
    const up = () => {
      if (!this.held) return;
      this.held = false;
      void this.emit(); // let go: said now, even if the drag ended with nothing else changing
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    this.unlisten = () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }

  protected override scrubbing() {
    return this.held;
  }

  override destroy() {
    this.unlisten();
    super.destroy();
  }

  protected video() {
    return document.querySelector<HTMLVideoElement>(VIDEO);
  }

  protected override adPlaying() {
    return document.querySelector(PLAYER)?.classList.contains(AD_CLASS) ?? false;
  }

  protected contentId() {
    return this.playing()?.id ?? null;
  }

  /**
   * The video the player plays, as confirmed last: kept through an ad (the <video> then has the ad's length and the
   * page may not say yet; the sync waits out ads anyway) — also across the miniplayer opening or closing, which
   * moves the same player with the same video.
   */
  private confirmed: Playing | null = null;

  private wasMiniplayer = false;
  /** The watch page at the last look there: its video by the URL, with the player's title and length for it. */
  private onWatch: (SoloStart & { at: number }) | null = null;

  /**
   * The watch page seen just now (5 s): leaving it for the miniplayer, the URL changes first (to the page the user
   * goes back to) and the miniplayer turns on about a second later.
   */
  private justWatched() {
    return this.onWatch && Date.now() - this.onWatch.at < 5000 ? this.onWatch : null;
  }
  /** Without a playlist: the video the miniplayer was seen opening with (from `onWatch`). */
  private soloStart: SoloStart | null = null;

  private playing(): Playing | null {
    const on = miniplayerOn();
    if (on !== this.wasMiniplayer) {
      // Opened right from the watch page: the same player, the video just seen there. Closed, or already open when
      // this adapter came: nothing known.
      this.soloStart = on ? this.justWatched() : null;
      if (!on) this.onWatch = null; // closed: the watch page seen before is over too
      this.wasMiniplayer = on;
    }
    if (on && this.adPlaying()) return this.confirmed;
    // The miniplayer plays what it plays, whatever page the URL says is browsed. Between the watch page and the
    // miniplayer (the URL moved, the miniplayer not on yet): still the watch page's video if the player still shows it.
    const duration = this.video()?.duration;
    const leaving = this.justWatched();
    const found: Playing | null = on ? this.inMiniplayer()
      : location.pathname === '/watch' ? this.watchPage()
      : leaving && stillPlays(document, duration, leaving) ? { id: leaving.id, title: leaving.title, list: leaving.list } : null;
    const valid = found && watchUrl({ provider: 'youtube', contentId: found.id }) ? found : null;
    if (valid) this.confirmed = valid;
    return valid;
  }

  /**
   * The watch page's video by its URL; noted with the player's title and length when the page shows that title for
   * this very video (the player's title link carries no address on the watch page).
   */
  private watchPage(): Playing {
    const id = new URLSearchParams(location.search).get('v') ?? '';
    const shown = document.querySelector(TITLE_LINK)?.textContent?.trim();
    const valid = !!watchUrl({ provider: 'youtube', contentId: id }); // also safe in the selector below
    const title = valid && shown && document.querySelector(WATCH_TITLE(id))?.textContent?.trim() === shown ? shown : undefined;
    const duration = this.video()?.duration;
    const list = playlist();
    if (this.adPlaying()) {
      // The <video> has the ad's length: the record of this very video is kept (checked against the player after).
      this.onWatch = this.onWatch?.id === id ? { ...this.onWatch, at: Date.now() } : null;
    } else {
      this.onWatch = title && duration !== undefined && Number.isFinite(duration) ? { id, title, duration, list, at: Date.now() } : null;
    }
    return { id, list };
  }

  private readonly lines = new TitleLines();

  // The player's title link names the video it belongs to, so it is never the previous video's; the tab title
  // lags behind a switch (first "YouTube", then possibly the previous title) and is used only once it changed.
  protected title() {
    if (miniplayerOn()) {
      const playing = this.playing();
      if (playing?.title) return playing.title.slice(0, 300); // the player's own title: what it plays
    }
    const id = this.contentId();
    const link = document.querySelector<HTMLAnchorElement>(TITLE_LINK);
    const linked = link && id && playerVideoId(link.href) === id ? link.textContent?.trim() || null : null;
    const tab = title();
    return this.lines.see(id, linked ?? (tab === 'YouTube' ? null : tab), !!linked) ?? 'YouTube';
  }

  protected override series() {
    // The watch page's own URL, else what the player plays (the miniplayer, or on the way to it).
    return location.pathname === '/watch' && !miniplayerOn() ? playlist() : this.playing()?.list;
  }

  private inMiniplayer() {
    const duration = this.video()?.duration;
    // Seen playing another video since (not during an ad: inMiniplayer isn't asked then): the one it opened with is
    // over, even if a later one looks the same.
    if (this.soloStart && movedOn(document, duration, this.soloStart)) this.soloStart = null;
    return miniplayerVideo(document, duration) ?? soloMiniplayerVideo(document, duration, this.soloStart);
  }

  // Only when the page says it is this video's: a channel shown during a switch may be the previous video's.
  protected override channel() {
    const id = this.contentId();
    const name = id ? document.querySelector(CHANNEL(id))?.textContent?.trim() : undefined;
    return name ? name.slice(0, 200) : undefined;
  }
}

const miniplayerOn = () => !!document.querySelector(MINIPLAYER_ON);

/**
 * What the miniplayer plays (see MINIPLAYER_ON), or null when it isn't on or the page doesn't say so consistently —
 * then no video is reported rather than a wrong one.
 */
export function miniplayerVideo(
  doc: ParentNode, durationSec: number | undefined,
): { id: string; list?: string; title: string } | null {
  if (!doc.querySelector(MINIPLAYER_ON)) return null;
  const title = doc.querySelector(TITLE_LINK)?.textContent?.trim();
  if (!title) return null;
  const item = doc.querySelector(PLAYING_ITEM);
  if (!item) return null; // no playlist: not known for sure, so not said
  // Its item only, when it is this video by title and length (a switch in progress: not yet).
  // Known limit: two videos in a row with the same title and length can't be told apart while the item catches
  // up (about a second); the player shows no video id of its own.
  const length = clockSeconds(item.querySelector(ITEM_LENGTH)?.textContent?.trim());
  if (item.querySelector('#video-title')?.textContent?.trim() !== title) return null;
  if (length === null || durationSec === undefined || !Number.isFinite(durationSec)) return null;
  if (Math.abs(length - durationSec) > 1.5) return null;
  let url: URL;
  try {
    url = new URL(item.querySelector('a')?.getAttribute('href') ?? '', 'https://www.youtube.com');
  } catch {
    return null;
  }
  const id = url.searchParams.get('v');
  return id ? { id, list: playlist(url.search), title } : null;
}

type SoloStart = { id: string; title: string; duration: number; list?: string };
/** A video the player plays: its id, playlist (`list`) and own title where known. */
type Playing = { id: string; list?: string; title?: string };

/**
 * The miniplayer's video without a playlist (see MINIPLAYER_ON): the one it was seen opening with (`start`, from its
 * watch page's URL), while the player's title and length are still that video's; null otherwise, and when it wasn't
 * seen opening (no `start`). Known limit: a next video with the same title and length, moved to in the corner,
 * can't be told apart.
 */
export function soloMiniplayerVideo(
  doc: ParentNode, durationSec: number | undefined, start: SoloStart | null,
): { id: string; title: string; list?: string } | null {
  if (!start || !doc.querySelector(MINIPLAYER_ON) || doc.querySelector(PLAYING_ITEM)) return null;
  // Its playlist too: a playlist video before its panel item shows up in the corner keeps its series.
  return stillPlays(doc, durationSec, start) ? { id: start.id, title: start.title, list: start.list } : null;
}

/** Whether the player shows another video for sure: another title, or another known length (a blank reading isn't). */
export function movedOn(doc: ParentNode, durationSec: number | undefined, video: SoloStart) {
  const title = doc.querySelector(TITLE_LINK)?.textContent?.trim();
  return (!!title && title !== video.title)
    || (durationSec !== undefined && Number.isFinite(durationSec) && Math.abs(video.duration - durationSec) > 1.5);
}

/** Whether the player still shows that video: its title, and its length (known). */
export function stillPlays(doc: ParentNode, durationSec: number | undefined, video: SoloStart) {
  return doc.querySelector(TITLE_LINK)?.textContent?.trim() === video.title
    && durationSec !== undefined && Number.isFinite(durationSec) && Math.abs(video.duration - durationSec) <= 1.5;
}

/** "3:28" / "1:02:03" → seconds; null if it isn't a length. */
export function clockSeconds(text: string | undefined) {
  if (!text || !/^\d+(:\d{2}){1,2}$/.test(text)) return null;
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
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

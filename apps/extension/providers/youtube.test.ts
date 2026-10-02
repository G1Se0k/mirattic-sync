import { expect, it } from 'vitest';
import { clockSeconds, miniplayerVideo, playerVideoId, playlist, movedOn, soloMiniplayerVideo, stillPlays } from './youtube';

it('reads the playlist from the URL as the series', () => {
  expect(playlist('?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=2')).toBe('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  expect(playlist('?v=dQw4w9WgXcQ')).toBeUndefined();
  expect(playlist('?v=dQw4w9WgXcQ&list=bad/../id')).toBeUndefined();
});

it("reads the video id from the player's title link", () => {
  expect(playerVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5')).toBe('dQw4w9WgXcQ');
  expect(playerVideoId('not a url')).toBeNull();
});

/** A page as `querySelector` sees it: selector → element (text, attributes, children by selector). */
type Fake = { text?: string; attrs?: Record<string, string>; kids?: Record<string, Fake> };
const el = (f: Fake): unknown => ({
  textContent: f.text ?? '',
  getAttribute: (n: string) => f.attrs?.[n] ?? null,
  querySelector: (s: string) => (f.kids?.[s] ? el(f.kids[s]) : null),
});
const page = (kids: Record<string, Fake>) => el({ kids }) as ParentNode;
const ON = { 'ytd-app[miniplayer-is-active]': {} };
const shows = (title: string) => ({ '#movie_player a.ytp-title-link': { text: ` ${title} ` } });
const item = (href: string, title: string, length = '3:28') => ({
  'ytd-playlist-panel-video-renderer[selected]': {
    kids: { a: { attrs: { href } }, '#video-title': { text: title }, 'ytd-thumbnail-overlay-time-status-renderer #text, .ytBadgeShapeText': { text: length } },
  },
});
const watchPage = (id: string, title: string) => ({
  'ytd-watch-flexy': { attrs: { 'video-id': id } },
  'ytd-watch-flexy ytd-watch-metadata h1': { text: title },
});

it("reads the miniplayer's video from the playlist item it plays, only if the player shows that title and length", () => {
  // A mix moved on in the corner: the item is the new video, the hidden watch page still the first one.
  const mix = { ...ON, ...shows('Second'), ...item('/watch?v=XkSgIsGoW4g&list=RDfkxtHbB25h4&index=2', 'Second'), ...watchPage('fkxtHbB25h4', 'First') };
  expect(miniplayerVideo(page(mix), 207.76)).toEqual({ id: 'XkSgIsGoW4g', list: 'RDfkxtHbB25h4', title: 'Second' });
  // The item not caught up yet: nothing, rather than a wrong video — the watch page isn't used.
  expect(miniplayerVideo(page({ ...ON, ...shows('Third'), ...item('/watch?v=XkSgIsGoW4g&list=RDx', 'Second'), ...watchPage('aqz-KE-bpKQ', 'Third') }), 207.76)).toBeNull();
  // The same title twice in a row: the length tells the stale item apart; an unknown length isn't trusted.
  expect(miniplayerVideo(page({ ...ON, ...shows('Same'), ...item('/watch?v=XkSgIsGoW4g&list=RDx', 'Same', '3:28') }), 251)).toBeNull();
  expect(miniplayerVideo(page({ ...ON, ...shows('Same'), ...item('/watch?v=XkSgIsGoW4g&list=RDx', 'Same', '3:28') }), NaN)).toBeNull();
  // A malformed link: nothing, no error.
  expect(miniplayerVideo(page({ ...ON, ...shows('Second'), ...item('http://[', 'Second') }), 207.76)).toBeNull();
  // No playlist: not said, even if the hidden watch page shows the same title (it may be a stale one).
  expect(miniplayerVideo(page({ ...ON, ...shows('Solo'), ...watchPage('aqz-KE-bpKQ', 'Solo') }), 600)).toBeNull();
  // Miniplayer off: nothing (the watch page's URL says what plays).
  expect(miniplayerVideo(page({ ...shows('Solo'), ...watchPage('aqz-KE-bpKQ', 'Solo') }), 600)).toBeNull();
});

it('reads a clock length', () => {
  expect(clockSeconds('3:28')).toBe(208);
  expect(clockSeconds('1:02:03')).toBe(3723);
  expect(clockSeconds('LIVE')).toBeNull();
  expect(clockSeconds(undefined)).toBeNull();
});

it("reads a miniplayer's video without a playlist as the one it opened with, while its title and length hold", () => {
  const start = { id: 'BiXAarBTrUo', title: 'Long mix', duration: 4100.24 };
  const solo = { ...ON, ...shows('Long mix') };
  expect(soloMiniplayerVideo(page(solo), 4100.24, start)).toEqual({ id: 'BiXAarBTrUo', title: 'Long mix' });
  // A playlist video before its panel item shows up: its playlist kept.
  expect(soloMiniplayerVideo(page(solo), 4100.24, { ...start, list: 'RDfkxtHbB25h4' })).toEqual({ id: 'BiXAarBTrUo', title: 'Long mix', list: 'RDfkxtHbB25h4' });
  // Not seen opening (e.g. already open when the extension came): not said.
  expect(soloMiniplayerVideo(page(solo), 4100.24, null)).toBeNull();
  // Moved on in the corner: another title, or the same title with another length — not said; unknown length neither.
  expect(soloMiniplayerVideo(page({ ...ON, ...shows('Next one') }), 4100.24, start)).toBeNull();
  expect(soloMiniplayerVideo(page(solo), 251, start)).toBeNull();
  expect(soloMiniplayerVideo(page(solo), NaN, start)).toBeNull();
  // The watch page's id doesn't matter any more (it can be another page browsed): only what it opened with.
  expect(soloMiniplayerVideo(page({ ...solo, ...watchPage('OtherVideoX', 'Long mix') }), 4100.24, start)).toEqual({ id: 'BiXAarBTrUo', title: 'Long mix' });
  // A playlist: that path's business; miniplayer off: nothing.
  expect(soloMiniplayerVideo(page({ ...solo, ...item('/watch?v=XkSgIsGoW4g&list=RDx', 'Long mix') }), 4100.24, start)).toBeNull();
  expect(soloMiniplayerVideo(page(shows('Long mix')), 4100.24, start)).toBeNull();
});

it('tells whether the player still shows a video by its title and length', () => {
  const video = { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny', duration: 634.6 };
  expect(stillPlays(page(shows('Big Buck Bunny')), 634.6, video)).toBe(true);
  expect(stillPlays(page(shows('Big Buck Bunny')), 251, video)).toBe(false);
  expect(stillPlays(page(shows('Big Buck Bunny')), NaN, video)).toBe(false);
  expect(stillPlays(page(shows('Another')), 634.6, video)).toBe(false);
});

it('tells when the player surely shows another video (not on a blank reading)', () => {
  const video = { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny', duration: 634.6 };
  expect(movedOn(page(shows('Another')), 634.6, video)).toBe(true);
  expect(movedOn(page(shows('Big Buck Bunny')), 251, video)).toBe(true);
  expect(movedOn(page(shows('Big Buck Bunny')), 634.6, video)).toBe(false);
  expect(movedOn(page(shows('')), NaN, video)).toBe(false); // loading: not known yet
});

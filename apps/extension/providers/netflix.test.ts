import { afterEach, expect, it } from 'vitest';
import { describeMetadata, episodeRun, metadataInPage, playerTitle, seekInPage, TitleLines } from './netflix';

const g = globalThis as { window?: unknown };
afterEach(() => delete g.window);

const NETFLIX = { origin: 'https://www.netflix.com' };
const page = (ids: string[], seeks: [string, number][] = [], location = NETFLIX) => ({
  location,
  netflix: { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
    getAllPlayerSessionIds: () => ids,
    getVideoPlayerBySessionId: (id: string) => ({ seek: (ms: number) => seeks.push([id, ms]) }),
  } }) } } } },
});

it("seeks the watch session through Netflix's player API", () => {
  const seeks: [string, number][] = [];
  g.window = page(['preview-1', 'watch-2'], seeks);
  expect(seekInPage(61_234.6)).toBe(true);
  expect(seekInPage(-5)).toBe(true);
  expect(seeks).toEqual([['watch-2', 61_235], ['watch-2', 0]]);
});

it('reports failure when the API is gone, so members get the guide instead', () => {
  g.window = { location: NETFLIX };
  expect(seekInPage(1000)).toBe(false);
  g.window = page([]);
  expect(seekInPage(1000)).toBe(false);
});

it('does nothing once the tab has navigated off Netflix', () => {
  const seeks: [string, number][] = [];
  g.window = page(['watch-1'], seeks, { origin: 'https://www.youtube.com' });
  expect(seekInPage(1000)).toBe(false);
  expect(seeks).toEqual([]);
});

it('counts episodes played in a row as one series, until the watch page is left', () => {
  let run = episodeRun(null, '100'); // first episode
  expect(run).toBe('100');
  run = episodeRun(run, '101'); // next episode, still on the watch page
  expect(run).toBe('100');
  run = episodeRun(run, null); // back to browsing
  expect(episodeRun(run, '200')).toBe('200'); // another title starts its own series
});

it("names what plays from Netflix's page data: show, season, episode", () => {
  const video: { id: number; title: string; type: string; seasons: unknown[] } = { id: 80100172, title: '킹덤', type: 'show', seasons: [{ seq: 2, episodes: [{ id: 81000001, seq: 3, title: '제3화' }] }] };
  g.window = { location: NETFLIX, netflix: { appContext: { state: { playerApp: { getState: () => ({
    videoPlayer: { videoMetadata: { '81000001': { _metadata: { video } } } } }) } } } } };
  const m = metadataInPage('81000001')!;
  expect(m).toEqual({ title: '킹덤', showId: '80100172', season: 2, episode: 3, episodeTitle: '제3화' });
  expect(describeMetadata(m)).toBe('킹덤 시즌 2 3화 · 제3화');
  expect(metadataInPage('999')).toBeNull(); // not loaded yet
  // The show is known but its episode list doesn't have this episode yet: usable, marked to be read again.
  video.seasons = [];
  expect(metadataInPage('81000001')).toEqual({ title: '킹덤', showId: '80100172', partial: true });
  video.seasons = [{ seq: 2, episodes: [{ id: 81000001, seq: 3, title: '제3화' }] }];
  video.id = undefined as unknown as number; // half loaded: no show id yet → not an answer
  expect(metadataInPage('81000001')).toBeNull();
  video.id = 80100172;
  video.title = '  ';
  expect(metadataInPage('81000001')).toBeNull();
  g.window = { location: { origin: 'https://www.youtube.com' } };
  expect(metadataInPage('81000001')).toBeNull();
});

it("reads the player's title line", () => {
  const text = (t: string) => ({ textContent: t });
  const line = { childNodes: [text('킹덤'), text(' '), text('S2:E3'), text('제3화')], textContent: '킹덤 S2:E3제3화' };
  expect(playerTitle({ querySelector: () => line } as unknown as ParentNode)).toBe('킹덤 · S2:E3 · 제3화');
  expect(playerTitle({ querySelector: () => null } as unknown as ParentNode)).toBeNull();
});

it("never gives the previous episode's title line to the next one, also via the browse page", () => {
  const lines = new TitleLines();
  expect(lines.see('A', null)).toBeUndefined(); // controls hidden
  expect(lines.see('A', '킹덤 · E1')).toBe('킹덤 · E1');
  expect(lines.see(null, null)).toBeUndefined(); // the browse page
  expect(lines.see('B', '킹덤 · E1')).toBeUndefined(); // A's line still on screen
  expect(lines.see('B', '킹덤 · E2')).toBe('킹덤 · E2');
  expect(lines.see('C', '킹덤 · E2')).toBeUndefined(); // straight to the next one too
  expect(lines.see('C', '킹덤 · E3')).toBe('킹덤 · E3');
  expect(lines.see('B', null)).toBe('킹덤 · E2'); // remembered
});

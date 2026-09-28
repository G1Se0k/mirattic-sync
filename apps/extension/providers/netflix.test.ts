import { afterEach, expect, it } from 'vitest';
import { seekInPage } from './netflix';

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

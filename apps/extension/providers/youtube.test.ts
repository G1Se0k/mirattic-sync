import { expect, it } from 'vitest';
import { playerVideoId, playlist } from './youtube';

it('reads the playlist from the URL as the series', () => {
  expect(playlist('?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=2')).toBe('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  expect(playlist('?v=dQw4w9WgXcQ')).toBeUndefined();
  expect(playlist('?v=dQw4w9WgXcQ&list=bad/../id')).toBeUndefined();
});

it("reads the video id from the player's title link", () => {
  expect(playerVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5')).toBe('dQw4w9WgXcQ');
  expect(playerVideoId('not a url')).toBeNull();
});

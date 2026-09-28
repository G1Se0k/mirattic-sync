import { expect, it } from 'vitest';
import { playlist } from './youtube';

it('reads the playlist from the URL as the series', () => {
  expect(playlist('?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=2')).toBe('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  expect(playlist('?v=dQw4w9WgXcQ')).toBeUndefined();
  expect(playlist('?v=dQw4w9WgXcQ&list=bad/../id')).toBeUndefined();
});

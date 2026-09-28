import { expect, it } from 'vitest';
import { title } from './laftel';

it('drops the site name from the tab title', () => {
  expect(title('장송의 프리렌 1화 - 라프텔')).toBe('장송의 프리렌 1화');
  expect(title('Frieren | LAFTEL')).toBe('Frieren');
  expect(title('라프텔')).toBe('Laftel 콘텐츠');
  expect(title('')).toBe('Laftel 콘텐츠');
});

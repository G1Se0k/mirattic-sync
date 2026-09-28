import { expect, it } from 'vitest';
import { title } from './laftel';

it('drops the site name from the tab title', () => {
  expect(title('장송의 프리렌 1화 - 라프텔')).toBe('장송의 프리렌 1화');
  expect(title('Frieren | LAFTEL')).toBe('Frieren');
  expect(title('라프텔')).toBe('Laftel 콘텐츠');
  expect(title('')).toBe('Laftel 콘텐츠');
});

it('drops "다시보기" from the title', () => {
  expect(title('장송의 프리렌 1화 다시보기 - 라프텔')).toBe('장송의 프리렌 1화');
  expect(title('다시보기 | 장송의 프리렌 2화 - 라프텔')).toBe('장송의 프리렌 2화');
  expect(title('다시 보기 - 라프텔')).toBe('Laftel 콘텐츠');
});

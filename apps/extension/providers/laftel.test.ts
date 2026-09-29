import { expect, it } from 'vitest';
import { splitEpisode, title } from './laftel';

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

it('reads a trailing "N화" as the episode', () => {
  expect(splitEpisode('장송의 프리렌 12화')).toEqual({ title: '장송의 프리렌', episode: 12 });
  expect(splitEpisode('극장판 너의 이름은')).toEqual({ title: '극장판 너의 이름은' });
  expect(splitEpisode('어떤 작품 1.5화')).toEqual({ title: '어떤 작품 1.5화' });
});

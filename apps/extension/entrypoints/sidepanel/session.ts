import { createApi, socketUrl, type RefreshTokenStore } from '@mirattic/client';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';
export const SOCKET_URL = socketUrl(API_URL);

// storage.session: in memory only, cleared when the browser restarts, and hidden from content scripts by
// default. Chrome's docs recommend it for sensitive data; storage.local is plain text on disk.
const KEY = 'mirattic.refresh';
const store: RefreshTokenStore = {
  load: async () => ((await browser.storage.session.get(KEY))[KEY] as string | undefined) ?? null,
  save: (token) => (token ? browser.storage.session.set({ [KEY]: token }) : browser.storage.session.remove(KEY)),
};

export const api = createApi({ baseUrl: API_URL, store });

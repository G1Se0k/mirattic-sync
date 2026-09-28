import { createApi, socketUrl, type RefreshTokenStore } from '@mirattic/client';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';
export const SOCKET_URL = socketUrl(API_URL);

// storage.local: signed in again automatically after the browser restarts (plan.md decision 68, replacing
// storage.session). Plain text in the Chrome profile; the server rotates it and a reuse revokes the family.
// Readable by extension pages only: our content scripts run inside provider pages and never need it.
// Fails closed: if the restriction can't be set, the token is neither read nor stored.
const KEY = 'mirattic.refresh';
const trusted = browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const store: RefreshTokenStore = {
  load: async () => {
    await trusted;
    return ((await browser.storage.local.get(KEY))[KEY] as string | undefined) ?? null;
  },
  save: async (token) => {
    await trusted;
    await (token ? browser.storage.local.set({ [KEY]: token }) : browser.storage.local.remove(KEY));
  },
};

export const api = createApi({ baseUrl: API_URL, store });

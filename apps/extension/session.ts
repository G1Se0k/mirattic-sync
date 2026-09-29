import { browser } from 'wxt/browser';
import { ApiError, socketUrl, type Authorize, type RefreshTokenStore } from '@mirattic/client';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';
export const SOCKET_URL = socketUrl(API_URL);

// Used by the background only: it is the one API client, so refresh tokens are never rotated from two places.
// storage.local: signed in again automatically after the browser restarts (plan.md decision 68, replacing
// storage.session). Plain text in the Chrome profile; the server rotates it and a reuse revokes the family.
// Readable by extension pages only: our content scripts run inside provider pages and never need it.
// Fails closed: if the restriction can't be set, the token is neither read nor stored.
const KEY = 'mirattic.refresh';
const trusted = browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
export const store: RefreshTokenStore = {
  load: async () => {
    await trusted;
    return ((await browser.storage.local.get(KEY))[KEY] as string | undefined) ?? null;
  },
  save: async (token) => {
    await trusted;
    await (token ? browser.storage.local.set({ [KEY]: token }) : browser.storage.local.remove(KEY));
  },
};

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Mirattic account sign-in (Mirattic Auth migration.md, option B): a browser window runs the server's /auth/start →
// Mirattic Auth → /auth/callback, which lands back here with a one-time handoff code, never a token. The code is
// redeemed with the verifier of the challenge sent at the start, so only this extension instance can use it.
export const authorize: Authorize = async () => {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = `${API_URL}/auth/start?${new URLSearchParams({ redirect: browser.identity.getRedirectURL(), challenge })}`;
  let landed: string | undefined;
  try {
    landed = await browser.identity.launchWebAuthFlow({ url, interactive: true });
  } catch {
    throw new ApiError(0, 'cancelled'); // window closed, or the server could not be reached
  }
  const params = new URL(landed ?? 'about:blank').searchParams;
  const code = params.get('handoff');
  if (!code) throw new ApiError(401, params.get('error') ?? 'sign-in failed');
  return { code, verifier };
};

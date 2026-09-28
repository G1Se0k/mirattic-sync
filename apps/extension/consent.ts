import { browser } from 'wxt/browser';

// Bump when what we collect changes: everyone is asked again.
export const CONSENT_KEY = 'mirattic.consent';
export const CONSENT_VERSION = '2026-09-28.2';

export async function hasConsent() {
  return (await browser.storage.local.get(CONSENT_KEY))[CONSENT_KEY] === CONSENT_VERSION;
}

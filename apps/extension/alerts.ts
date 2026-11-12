import { browser } from 'wxt/browser';
import { alertPrefs, type AlertPrefs } from '@mirattic/types';
import { ALERTS_KEY } from './ui-port';

let alertsSaved: Promise<unknown> = Promise.resolve();
/**
 * One alert setting changed: merged into what storage holds now, one save after another — quick switches can't put
 * back each other's old value (decision 119).
 */
export function saveAlerts(change: Partial<AlertPrefs>): Promise<void> {
  const save = alertsSaved.then(async () => {
    const stored = await browser.storage.local.get(ALERTS_KEY);
    await browser.storage.local.set({ [ALERTS_KEY]: { ...alertPrefs(stored[ALERTS_KEY]), ...change } });
  });
  alertsSaved = save.catch(() => {});
  return save;
}

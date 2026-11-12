import { browser } from 'wxt/browser';
import { LANG_KEY, langChoice, langChosen, setLang, type LangChoice } from '@mirattic/i18n';

const apply = (value: unknown) => setLang(langChoice(value));

/**
 * Shows the language kept in storage.local, and any change of it from another page (Settings in a panel). Resolves
 * once it is read (a failed read: the browser's language).
 */
export function followLang(changed?: () => void): Promise<void> {
  let newer = false; // a change seen while the first read was out: that read is older
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(LANG_KEY in changes)) return;
    newer = true;
    apply(changes[LANG_KEY].newValue);
    changed?.();
  });
  return browser.storage.local.get(LANG_KEY).then((s) => void (newer || apply(s[LANG_KEY])), () => void (newer || apply('auto')));
}

/** The language chosen on this device (decision 124), "auto" until one is. */
export const langSetting = langChosen;

/** Shown at once here and saved: every page of the extension follows it. */
export function saveLang(next: LangChoice): Promise<void> {
  apply(next);
  return browser.storage.local.set({ [LANG_KEY]: next });
}

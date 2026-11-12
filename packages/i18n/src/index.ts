import en from "./en.json";
import ja from "./ja.json";

/**
 * The panel's and the extension's languages (decision 124). The Korean text is the key: written as is in the code,
 * looked up in `en` / `ja` (AI-translated). `{name}` in a text is filled from `params`.
 */
export type Lang = "ko" | "en" | "ja";
/** The setting: a language, or the browser's ("auto"). */
export type LangChoice = Lang | "auto";
export const LANGS: Lang[] = ["ko", "en", "ja"];
/** Each language by its own name, so a wrong choice is easy to undo. */
export const LANG_NAMES: Record<Lang, string> = { ko: "한국어", en: "English", ja: "日本語" };
/** Where the extension keeps the choice (storage.local), on this device. */
export const LANG_KEY = "mirattic.lang";

const dicts: Record<Exclude<Lang, "ko">, Record<string, string>> = { en, ja };
let current: Lang = "ko";
/** As chosen ("auto" stays "auto"): a change of it is told even when the language shown stays the same. */
let chosen: LangChoice = "auto";
const listeners = new Set<() => void>();

/** The browser's language among ours, else English. */
export function browserLang(tag: string | undefined = globalThis.navigator?.language): Lang {
  const l = (tag ?? "").toLowerCase();
  return l.startsWith("ko") ? "ko" : l.startsWith("ja") ? "ja" : "en";
}

export function langChoice(stored: unknown): LangChoice {
  return stored === "auto" || LANGS.includes(stored as Lang) ? (stored as LangChoice) : "auto";
}

/** Shows `choice` from now on (an "auto" one: the browser's language); listeners are told when it changes. */
export function setLang(choice: LangChoice) {
  const next = choice === "auto" ? browserLang() : choice;
  if (next === current && choice === chosen) return;
  current = next;
  chosen = choice;
  listeners.forEach((l) => l());
}

export const lang = () => current;
export const langChosen = () => chosen;

export function subscribeLang(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** `text`'s `{name}`s filled from `params`. */
export const fill = (text: string, params?: Record<string, string | number>) =>
  params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text;

/** `ko` in the language shown, its `{name}`s filled from `params`. */
export function t(ko: string, params?: Record<string, string | number>): string {
  return fill(current === "ko" ? ko : dicts[current][ko] ?? ko, params);
}

/** `ko` in the language shown, split at its `{name}`s with `params` in their places (for text around elements). */
export function tParts<T>(ko: string, params: Record<string, T>): (string | T)[] {
  const text = current === "ko" ? ko : dicts[current][ko] ?? ko;
  return text.split(/\{(\w+)\}/).map((s, i) => (i % 2 ? (s in params ? (params[s] as T) : `{${s}}`) : s)).filter((s) => s !== "");
}

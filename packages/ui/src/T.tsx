import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { subscribeLang, tParts } from "@mirattic/i18n";

/** Translated text with elements in it: `tn("{name}님이 들어왔습니다", { name: <b>…</b> })` (decision 124). */
export function tn(ko: string, params: Record<string, ReactNode>): ReactNode {
  return tParts(ko, params).map((p, i) => <Fragment key={i}>{p}</Fragment>);
}

/** A message kept in state, cleared when the language changes (it was written in the one before; decision 124). */
export function useOnLangChange(changed: () => void) {
  const latest = useRef(changed);
  latest.current = changed;
  useEffect(() => subscribeLang(() => latest.current()), []);
}

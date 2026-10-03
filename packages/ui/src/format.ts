export { PROVIDER_NAMES } from "@mirattic/types";

export function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "3:28" / "1:02:03" → ms; null if it isn't a time (minutes and seconds under 60 after the first part). */
export function parseClock(text: string) {
  const t = text.trim();
  if (!/^\d{1,3}(:[0-5]\d){1,2}$/.test(t)) return null;
  return t.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;
}

/** Only the latest started load may apply; `invalidate` also drops the ones in flight (a newer local change). */
export function latest() {
  let generation = 0;
  return {
    begin: () => {
      const mine = ++generation;
      return () => mine === generation;
    },
    invalidate: () => void generation++,
  };
}

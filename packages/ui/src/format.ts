import type { MediaProvider } from "@mirattic/types";

export const PROVIDER_NAMES: Record<MediaProvider, string> = { youtube: "YouTube", netflix: "Netflix", laftel: "Laftel", mock: "Mock" };

export function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

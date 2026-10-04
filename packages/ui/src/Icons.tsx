import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { MediaProvider } from "@mirattic/types";
import { PROVIDER_NAMES } from "./format";
import { platform } from "./session";
import youtube from "./assets/youtube.png";
import netflix from "./assets/netflix.png";
import laftel from "./assets/laftel.png";

// A small stroke icon set (24px grid, drawn at 16px), inline so no icon font or package is needed.
const PATHS = {
  back: <path d="M15 18l-6-6 6-6" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  login: <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" />,
  userPlus: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1M19 8v6M22 11h-6" />
    </>
  ),
  watch: (
    <>
      <rect x="2" y="6" width="20" height="14" rx="2" />
      <path d="M10 10l5 3-5 3z" />
    </>
  ),
  /** A raised hand: asking to join (unlike `login`, entering a room). */
  join: <path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0" />,
  plus: <path d="M12 5v14M5 12h14" />,
  hash: <path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" />,
  send: <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />,
  trash: <path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  crown: <path d="M3 18h18M4 8l4 4 4-7 4 7 4-4-2 10H6z" />,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  refresh: <path d="M21 4v6h-6M3 20v-6h6M5 9a8 8 0 0 1 13.4-3.4L21 10M3 14l2.6 4.4A8 8 0 0 0 19 15" />,
  power: <path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0" />,
  dock: <path d="M3 4h18v16H3zM15 4v16" />,
  external: <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />,
  pause: <path d="M8 5v14M16 5v14" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  ban: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </>
  ),
  flag: <path d="M4 22V4s1.5-1 4-1 5 2 8 2 4-1 4-1v11s-1.5 1-4 1-5-2-8-2-4 1-4 1" />,
  userMinus: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1M16 11h6" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** A square icon button; `label` is its accessible name and tooltip. */
export function IconButton({ icon, label, tone, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  tone?: "danger" | "primary";
}) {
  return (
    <button type="button" className={`icon-button${tone ? ` ${tone}` : ""}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

/** Out to a window of its own, or back to the side panel (where the platform offers it). */
export function PanelWindowButton() {
  const w = platform.panelWindow;
  if (!w) return null;
  return w.detached
    ? <IconButton icon="dock" label="사이드 패널로 돌아가기" onClick={() => w.toggle()} />
    : <IconButton icon="external" label="창으로 분리" onClick={() => w.toggle()} />;
}

/** A streaming site's logo (square, transparent). */
const PROVIDER_LOGOS: Record<MediaProvider, string> = { youtube, netflix, laftel };

export function ProviderIcon({ provider }: { provider: MediaProvider }) {
  return <img className="provider" src={PROVIDER_LOGOS[provider]} alt={PROVIDER_NAMES[provider]} title={PROVIDER_NAMES[provider]} />;
}

/** Initials in a circle: a face for a name without pictures. */
export function Avatar({ name, on }: { name: string; on?: boolean }) {
  return (
    <span className="avatar" aria-hidden="true">
      {[...name.trim()][0]?.toUpperCase() ?? "?"}
      {on !== undefined && <span className={`presence ${on ? "on" : ""}`} />}
    </span>
  );
}

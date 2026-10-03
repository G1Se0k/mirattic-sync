import type { SocketStatus } from '@mirattic/client';
import type { RoomSyncState } from '@mirattic/sync-core';
import type { ClientEvent, MediaProvider, RoomContent, ServerEvent, WatchingInfo } from '@mirattic/types';
import type { VideoTab } from '@mirattic/ui';

// Side panel ⇄ background (plan.md decision 69). The background owns the API client (the only one that
// refreshes tokens), the socket, the followed tab and the room's sync, so they outlive the side panel. The
// panel is a view: it calls the API and sends socket events through the background, and gets pushed state.

export const UI_PORT = 'mirattic-ui';

/** Room actions the panel may call on the background's `RoomSync`. */
/**
 * Settings in storage.local (decision 81): the side panel writes them, the background follows storage.onChanged.
 * One key per site, so turning on two at once can't lose one.
 */
export const experimentKey = (provider: 'netflix' | 'laftel') => `mirattic.experiment.${provider}`;
/** Whether members are asked before following the host to another video. */
export const ASK_ON_SWITCH_KEY = 'mirattic.askOnSwitch';

export const ROOM_ACTIONS = ['requestPause', 'dismissPauseRequest', 'pauseAll', 'seek', 'openSwitched', 'dismissSwitched',
  'setMuted', 'reload'] as const;
export type RoomAction = (typeof ROOM_ACTIONS)[number];

export type FromPanel =
  | { op: 'hello'; windowId?: number }
  | { op: 'api'; id: number; name: string; args: unknown[] }
  | { op: 'socket' }
  | { op: 'socket:resume' }
  | { op: 'send'; event: ClientEvent }
  /** `resume`: a panel restating its room after a worker restart, not the user entering it (no video tab). */
  | { op: 'room:open'; roomId: string; resume?: boolean }
  // With the room they are about: another window's panel may have made a different room the active one.
  | { op: 'room:close'; roomId: string }
  | { op: 'room:exit'; roomId: string }
  | { op: 'room:act'; roomId: string; name: RoomAction; args: unknown[] }
  | { op: 'open'; url: string; newTab?: boolean }
  /** The tab to follow; null = the active one, as the user switches. */
  | { op: 'tab'; tabId: number | null; windowId?: number }
  /** The room's type change told (decision 93): confirmed, or leave the room. */
  | { op: 'type:answer'; roomId: string; version: number; leave: boolean }
  /** The room's type picked: follow that site's tab of this window, or open the site. */
  | { op: 'site'; site: MediaProvider; windowId?: number }
  /** The notice of this closed room was shown to this account: not again (every panel). */
  | { op: 'closed:seen'; roomId: string; userId: string };

export type Shared = {
  watching: RoomContent | null;
  watchingInfo: WatchingInfo | null;
  offSite: { provider: MediaProvider; visit: number } | null;
  askOnSwitch: boolean;
  /** Video tabs that can be followed, the one followed, and whether it follows the active one. */
  tabs: VideoTab[];
  followedTab: number | null;
  followActive: boolean;
  experiments: { netflix: boolean; laftel: boolean };
  activeRoom: string | null;
  /** When alerts shown before a panel opened run out ("invite:<room>", "request:<friend>"; epoch ms). */
  alertsUntil: Record<string, number>;
  /**
   * The host changed my rooms' types (decision 93), one per room, until I confirm or leave (`type:answer`). `version`:
   * the room's type version — the answer is about that one (a later change is asked again).
   */
  typeNotices: { roomId: string; type: MediaProvider; version: number }[];
  /** Rooms of mine their host closed (decision 90), until a panel showed the notice (`closed:seen`). */
  closedRooms: { roomId: string; title: string; userId: string }[];
};

export type ToPanel =
  | { kind: 'reply'; id: number; ok?: unknown; error?: { status: number; message: string } }
  | { kind: 'status'; status: SocketStatus }
  | { kind: 'event'; event: ServerEvent }
  | { kind: 'shared'; shared: Shared }
  | { kind: 'room'; state: RoomSyncState }
  /** The background has stored that this room's closure notice was shown: not shown again. */
  | { kind: 'closed:recorded'; roomId: string; userId: string };

/** storage.local: the side panel's text size in percent (100 = default); only the panel uses it. */
export const TEXT_SIZE_ITEM = 'mirattic.textSize';
/** Whether the followed tab is the window's active video tab as the user switches (else one tab, chosen). */
export const followActiveSetting = 'mirattic.followActive';

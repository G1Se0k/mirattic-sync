import type { SocketStatus } from '@mirattic/client';
import type { RoomSyncState } from '@mirattic/sync-core';
import type { ClientEvent, MediaProvider, RoomContent, ServerEvent, WatchingInfo } from '@mirattic/types';

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
  | { op: 'send'; event: ClientEvent }
  | { op: 'room:open'; roomId: string }
  // With the room they are about: another window's panel may have made a different room the active one.
  | { op: 'room:close'; roomId: string }
  | { op: 'room:exit'; roomId: string }
  | { op: 'room:act'; roomId: string; name: RoomAction; args: unknown[] }
  | { op: 'open'; url: string; newTab?: boolean };

export type Shared = {
  watching: RoomContent | null;
  watchingInfo: WatchingInfo | null;
  offSite: { provider: MediaProvider; visit: number } | null;
  askOnSwitch: boolean;
  experiments: { netflix: boolean; laftel: boolean };
  activeRoom: string | null;
};

export type ToPanel =
  | { kind: 'reply'; id: number; ok?: unknown; error?: { status: number; message: string } }
  | { kind: 'status'; status: SocketStatus }
  | { kind: 'event'; event: ServerEvent }
  | { kind: 'shared'; shared: Shared }
  | { kind: 'room'; state: RoomSyncState };

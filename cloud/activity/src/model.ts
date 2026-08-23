import type { CloudRoomSnapshot, ServerCloudRoomMessage } from '../../../src/shared/cloudRoom'
import type { ServerCloudSyncMessage } from '../../../src/shared/cloudSync'
import type { ViewerAccount } from './api'

export type ActivityPhase =
  | 'boot'
  | 'error'
  | 'lobby'
  | 'waiting'
  | 'live'
  | 'stale'
  | 'incompatible'
  | 'deleted'

export interface ActivityState {
  phase: ActivityPhase
  account?: ViewerAccount
  room?: CloudRoomSnapshot
  revision: number
  lastSeenAt?: number
  message?: string
  pairing?: { code: string; expiresAt: number }
  roomCode?: string
}

export const initialState: ActivityState = { phase: 'boot', revision: -1 }

export type ActivityAction =
  | { type: 'account'; account: ViewerAccount; roomCode?: string }
  | { type: 'pairing'; code: string; expiresAt: number }
  | { type: 'socket'; message: ServerCloudSyncMessage | ServerCloudRoomMessage }
  | { type: 'disconnected'; at: number }
  | { type: 'error'; message: string }
  | { type: 'incompatible'; message: string }
  | { type: 'deleted' }

function applySocket(state: ActivityState, message: ServerCloudSyncMessage | ServerCloudRoomMessage): ActivityState {
  if (message.type === 'room') {
    if (message.room.revision <= state.revision) return state
    return { ...state, room: message.room, revision: message.room.revision, phase: 'live' }
  }
  if (message.type === 'error') {
    return { ...state, phase: message.code === 'version_mismatch' ? 'incompatible' : 'error', message: message.message }
  }
  return state
}

function terminalState(
  state: ActivityState,
  action: Extract<ActivityAction, { type: 'error' | 'incompatible' | 'deleted' }>
): ActivityState {
  if (action.type === 'deleted') return { ...initialState, phase: 'deleted' }
  if (action.type === 'incompatible') return { ...state, phase: 'incompatible', message: action.message }
  return { ...state, phase: 'error', message: action.message }
}

export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  switch (action.type) {
    case 'account': return applyAccount(state, action)
    case 'pairing': return { ...state, pairing: action }
    case 'socket': return applySocket(state, action.message)
    case 'disconnected': return disconnect(state, action.at)
    default: return terminalState(state, action)
  }
}

function applyAccount(state: ActivityState, action: Extract<ActivityAction, { type: 'account' }>): ActivityState {
  const sameRoom = state.account?.room?.id !== undefined && state.account.room.id === action.account.room?.id
  return {
    ...initialState,
    account: action.account,
    phase: action.account.room === null ? 'lobby' : 'waiting',
    ...(sameRoom && state.room !== undefined ? { room: state.room, revision: state.revision } : {}),
    ...(action.roomCode === undefined ? {} : { roomCode: action.roomCode })
  }
}

function disconnect(state: ActivityState, at: number): ActivityState {
  if (state.phase === 'lobby') return state
  return { ...state, phase: state.room === undefined ? 'waiting' : 'stale', lastSeenAt: state.lastSeenAt ?? at }
}

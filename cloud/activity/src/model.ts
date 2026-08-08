import type { CloudSyncState, ServerCloudSyncMessage } from '../../../src/shared/cloudSync'
import type { ViewerAccount } from './api'

export type ActivityPhase = 'boot' | 'error' | 'unpaired' | 'waiting' | 'live' | 'stale' | 'incompatible' | 'deleted'

export interface ActivityState {
  phase: ActivityPhase
  account?: ViewerAccount
  state?: CloudSyncState
  revision: number
  lastSeenAt?: number
  message?: string
  pairing?: { code: string; expiresAt: number }
}

export const initialState: ActivityState = { phase: 'boot', revision: -1 }

export type ActivityAction =
  | { type: 'account'; account: ViewerAccount }
  | { type: 'pairing'; code: string; expiresAt: number }
  | { type: 'socket'; message: ServerCloudSyncMessage }
  | { type: 'disconnected'; at: number }
  | { type: 'error'; message: string }
  | { type: 'incompatible'; message: string }
  | { type: 'deleted' }

type ServerMessage<T extends ServerCloudSyncMessage['type']> = Extract<ServerCloudSyncMessage, { type: T }>

function applyPublishedState(state: ActivityState, message: ServerMessage<'state'>): ActivityState {
  if (message.revision <= state.revision) return state
  return { ...state, phase: state.phase === 'stale' ? 'stale' : 'live', state: message.state, revision: message.revision }
}

function applyPresence(state: ActivityState, message: ServerMessage<'presence'>): ActivityState {
  if (!state.state && state.account?.paired === false) return state
  if (message.online) return { ...state, phase: state.state ? 'live' : 'waiting', lastSeenAt: message.lastSeenAt }
  return { ...state, phase: state.state ? 'stale' : 'waiting', lastSeenAt: message.lastSeenAt }
}

function applyServerError(state: ActivityState, message: ServerMessage<'error'>): ActivityState {
  const phase = message.code === 'version_mismatch' ? 'incompatible' : 'error'
  return { ...state, phase, message: message.message }
}

function socketState(state: ActivityState, message: ServerCloudSyncMessage): ActivityState {
  if (message.type === 'state') return applyPublishedState(state, message)
  if (message.type === 'presence') return applyPresence(state, message)
  if (message.type === 'error') return applyServerError(state, message)
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
  if (action.type === 'account') {
    return { ...initialState, account: action.account, phase: action.account.paired ? 'waiting' : 'unpaired' }
  }
  if (action.type === 'pairing') return { ...state, pairing: action, phase: 'unpaired' }
  if (action.type === 'socket') return socketState(state, action.message)
  if (action.type === 'disconnected') {
    if (!state.state && state.account?.paired === false) return state
    return { ...state, phase: state.state ? 'stale' : 'waiting', lastSeenAt: state.lastSeenAt ?? action.at }
  }
  return terminalState(state, action)
}

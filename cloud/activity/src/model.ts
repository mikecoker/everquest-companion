import type { CloudSyncState, ServerCloudSyncMessage } from '../../../src/shared/cloudSync'
import type { ViewerAccount } from './api'

export type ActivityPhase = 'boot' | 'error' | 'unpaired' | 'waiting' | 'live' | 'stale' | 'incompatible'

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

function socketState(state: ActivityState, message: ServerCloudSyncMessage): ActivityState {
  if (message.type === 'state') {
    if (message.revision <= state.revision) return state
    return { ...state, phase: state.phase === 'stale' ? 'stale' : 'live', state: message.state, revision: message.revision }
  }
  if (message.type === 'presence') {
    if (!state.state && state.account?.paired === false) return state
    if (message.online) return { ...state, phase: state.state ? 'live' : 'waiting', lastSeenAt: message.lastSeenAt }
    return { ...state, phase: state.state ? 'stale' : 'waiting', lastSeenAt: message.lastSeenAt }
  }
  if (message.type === 'error' && message.code === 'version_mismatch') {
    return { ...state, phase: 'incompatible', message: message.message }
  }
  if (message.type === 'error') return { ...state, phase: 'error', message: message.message }
  return state
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
  if (action.type === 'incompatible') return { ...state, phase: 'incompatible', message: action.message }
  return { ...state, phase: 'error', message: action.message }
}

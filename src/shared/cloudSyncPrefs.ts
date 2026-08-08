import { CLOUD_SYNC_LIMITS } from './cloudSync'

export interface CloudSyncPrefsView {
  enabled: boolean
  endpoint: string
  paired: boolean
  pairedDiscordName?: string
  secretProtected: boolean
}

export type CloudSyncStatus =
  | { state: 'disabled' }
  | { state: 'connecting' }
  | { state: 'online'; lastPublishedAt?: number }
  | { state: 'retrying'; retryAt: number; message: string }
  | { state: 'error'; message: string }
  | { state: 'revoked' }
  | { state: 'superseded' }

export interface CloudSyncActionResult {
  ok: boolean
  prefs: CloudSyncPrefsView
  error?: string
  credentialsCleared?: boolean
}

export interface CloudSyncPairRequest {
  code: string
  label: string
}

const MAX_ENDPOINT_CHARS = 512
const MAX_PAIR_CODE_CHARS = 64
const MAX_DEVICE_LABEL_CHARS = 80

export function parseCloudSyncEndpointInput(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length <= MAX_ENDPOINT_CHARS ? value.trim() : null
}

export function parseCloudSyncPairRequest(code: unknown, label: unknown): CloudSyncPairRequest | null {
  if (typeof code !== 'string' || typeof label !== 'string') return null
  const cleanCode = code.trim()
  const cleanLabel = label.trim()
  if (cleanCode.length === 0 || cleanCode.length > MAX_PAIR_CODE_CHARS) return null
  if (cleanLabel.length === 0 || cleanLabel.length > MAX_DEVICE_LABEL_CHARS) return null
  return { code: cleanCode, label: cleanLabel }
}

function finiteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function boundedMessage(value: unknown): string {
  const message = typeof value === 'string' ? value : 'Cloud sync failed'
  return message.slice(0, CLOUD_SYNC_LIMITS.maxErrorChars)
}

/** Copy a publisher status field-by-field before it crosses into the renderer. */
export function sanitizeCloudSyncStatus(value: unknown): CloudSyncStatus {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { state: 'error', message: 'Cloud sync failed' }
  const source = value as Record<string, unknown>
  switch (source.state) {
    case 'disabled': return { state: 'disabled' }
    case 'connecting': return { state: 'connecting' }
    case 'online': return sanitizeOnlineStatus(source)
    case 'retrying': return sanitizeRetryingStatus(source)
    case 'error': return { state: 'error', message: boundedMessage(source.message) }
    case 'revoked': return { state: 'revoked' }
    case 'superseded': return { state: 'superseded' }
    default: return { state: 'error', message: 'Cloud sync failed' }
  }
}

function sanitizeOnlineStatus(source: Record<string, unknown>): CloudSyncStatus {
  return finiteTime(source.lastPublishedAt)
    ? { state: 'online', lastPublishedAt: source.lastPublishedAt }
    : { state: 'online' }
}

function sanitizeRetryingStatus(source: Record<string, unknown>): CloudSyncStatus {
  return finiteTime(source.retryAt)
    ? { state: 'retrying', retryAt: source.retryAt, message: boundedMessage(source.message) }
    : { state: 'error', message: 'Cloud sync failed' }
}

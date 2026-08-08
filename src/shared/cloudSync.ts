/**
 * Public wire contract for the opt-in Discord live view. This is intentionally
 * independent of Electron and Cloudflare so both ends validate the same bytes.
 * Only the fields named below may leave the desktop; raw log lines and chat do not.
 */

export const CLOUD_SYNC_PROTOCOL_VERSION = 1 as const

export const CLOUD_SYNC_LIMITS = {
  maxJsonChars: 64 * 1024,
  maxIdChars: 128,
  maxNameChars: 96,
  maxServerChars: 64,
  maxZoneChars: 128,
  maxItemChars: 160,
  maxErrorChars: 256,
  maxClasses: 3,
  maxCombatRows: 20,
  maxRecentKills: 10,
  maxRecentLoot: 10
} as const

export type CloudCombatantKind = 'self' | 'party' | 'pet' | 'other'

export interface CloudSyncState {
  publishedAt: number
  character: {
    id: string
    name: string
    server: string
    level?: number
    classes: string[]
    zone?: string
  }
  combat: {
    inCombat: boolean
    target?: string
    startedAt?: number
    totalDamage: number
    dps: number
    rows: {
      name: string
      total: number
      dps: number
      kind: CloudCombatantKind
    }[]
  }
  progression?: {
    level: number
    percent?: number
    xpPerHour: number
    etaMs?: number
  }
  recent: {
    kills: { name: string; ts: number }[]
    loot: { item: string; ts: number; quantity?: number }[]
  }
}

export type DesktopCloudSyncMessage =
  | {
      version: typeof CLOUD_SYNC_PROTOCOL_VERSION
      type: 'publish'
      state: CloudSyncState
    }
  | {
      version: typeof CLOUD_SYNC_PROTOCOL_VERSION
      type: 'ping'
      sentAt: number
    }

export type CloudSyncErrorCode =
  | 'unauthorized'
  | 'invalid_message'
  | 'rate_limited'
  | 'version_mismatch'
  | 'internal'

export type ServerCloudSyncMessage =
  | {
      version: typeof CLOUD_SYNC_PROTOCOL_VERSION
      type: 'ready'
      sessionId: string
      serverTime: number
    }
  | {
      version: typeof CLOUD_SYNC_PROTOCOL_VERSION
      type: 'state'
      revision: number
      state: CloudSyncState
    }
  | {
      version: typeof CLOUD_SYNC_PROTOCOL_VERSION
      type: 'presence'
      online: boolean
      lastSeenAt?: number
    }
  | {
      version: typeof CLOUD_SYNC_PROTOCOL_VERSION
      type: 'error'
      code: CloudSyncErrorCode
      message: string
      retryAfterMs?: number
    }

export type CloudSyncParseErrorCode =
  | 'invalid_json'
  | 'too_large'
  | 'invalid_message'
  | 'unsupported_version'
  | 'unknown_type'

export type CloudSyncParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: CloudSyncParseErrorCode; message: string } }

class ValidationError extends Error {
  constructor(
    readonly code: CloudSyncParseErrorCode,
    message: string
  ) {
    super(message)
  }
}

function reject(code: CloudSyncParseErrorCode, message: string): never {
  throw new ValidationError(code, message)
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject('invalid_message', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    reject('invalid_message', `${label} must be 1-${maxChars} characters`)
  }
  return value
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    reject('invalid_message', `${label} must be a finite non-negative number`)
  }
  return value
}

function integerValue(value: unknown, label: string): number {
  const parsed = numberValue(value, label)
  if (!Number.isSafeInteger(parsed)) reject('invalid_message', `${label} must be an integer`)
  return parsed
}

function levelValue(value: unknown, label: string): number {
  const parsed = integerValue(value, label)
  if (parsed < 1 || parsed > 255) reject('invalid_message', `${label} must be between 1 and 255`)
  return parsed
}

function arrayValue(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    reject('invalid_message', `${label} must contain at most ${maxItems} items`)
  }
  return value
}

function parseCharacter(value: unknown): CloudSyncState['character'] {
  const source = objectValue(value, 'character')
  const classes = arrayValue(source.classes, 'character.classes', CLOUD_SYNC_LIMITS.maxClasses).map(
    (entry) => stringValue(entry, 'character class', CLOUD_SYNC_LIMITS.maxNameChars)
  )
  return {
    id: stringValue(source.id, 'character.id', CLOUD_SYNC_LIMITS.maxIdChars),
    name: stringValue(source.name, 'character.name', CLOUD_SYNC_LIMITS.maxNameChars),
    server: stringValue(source.server, 'character.server', CLOUD_SYNC_LIMITS.maxServerChars),
    ...(source.level === undefined ? {} : { level: levelValue(source.level, 'character.level') }),
    classes,
    ...(source.zone === undefined
      ? {}
      : { zone: stringValue(source.zone, 'character.zone', CLOUD_SYNC_LIMITS.maxZoneChars) })
  }
}

function parseCombatRow(value: unknown): CloudSyncState['combat']['rows'][number] {
  const source = objectValue(value, 'combat row')
  const kind = source.kind
  if (kind !== 'self' && kind !== 'party' && kind !== 'pet' && kind !== 'other') {
    reject('invalid_message', 'combat row kind is unknown')
  }
  return {
    name: stringValue(source.name, 'combat row name', CLOUD_SYNC_LIMITS.maxNameChars),
    total: numberValue(source.total, 'combat row total'),
    dps: numberValue(source.dps, 'combat row dps'),
    kind
  }
}

function parseCombat(value: unknown): CloudSyncState['combat'] {
  const source = objectValue(value, 'combat')
  if (typeof source.inCombat !== 'boolean') reject('invalid_message', 'combat.inCombat must be boolean')
  const rows = arrayValue(source.rows, 'combat.rows', CLOUD_SYNC_LIMITS.maxCombatRows).map(parseCombatRow)
  return {
    inCombat: source.inCombat,
    ...(source.target === undefined
      ? {}
      : { target: stringValue(source.target, 'combat.target', CLOUD_SYNC_LIMITS.maxNameChars) }),
    ...(source.startedAt === undefined
      ? {}
      : { startedAt: integerValue(source.startedAt, 'combat.startedAt') }),
    totalDamage: numberValue(source.totalDamage, 'combat.totalDamage'),
    dps: numberValue(source.dps, 'combat.dps'),
    rows
  }
}

function parseProgression(value: unknown): NonNullable<CloudSyncState['progression']> {
  const source = objectValue(value, 'progression')
  const percent = source.percent === undefined ? undefined : numberValue(source.percent, 'progression.percent')
  if (percent !== undefined && percent > 100) {
    reject('invalid_message', 'progression.percent must be at most 100')
  }
  return {
    level: levelValue(source.level, 'progression.level'),
    ...(percent === undefined ? {} : { percent }),
    xpPerHour: numberValue(source.xpPerHour, 'progression.xpPerHour'),
    ...(source.etaMs === undefined ? {} : { etaMs: integerValue(source.etaMs, 'progression.etaMs') })
  }
}

function parseRecent(value: unknown): CloudSyncState['recent'] {
  const source = objectValue(value, 'recent')
  const kills = arrayValue(source.kills, 'recent.kills', CLOUD_SYNC_LIMITS.maxRecentKills).map((entry) => {
    const row = objectValue(entry, 'recent kill')
    return {
      name: stringValue(row.name, 'recent kill name', CLOUD_SYNC_LIMITS.maxNameChars),
      ts: integerValue(row.ts, 'recent kill timestamp')
    }
  })
  const loot = arrayValue(source.loot, 'recent.loot', CLOUD_SYNC_LIMITS.maxRecentLoot).map((entry) => {
    const row = objectValue(entry, 'recent loot')
    const quantity = row.quantity === undefined ? undefined : integerValue(row.quantity, 'recent loot quantity')
    if (quantity !== undefined && quantity < 1) reject('invalid_message', 'recent loot quantity must be positive')
    return {
      item: stringValue(row.item, 'recent loot item', CLOUD_SYNC_LIMITS.maxItemChars),
      ts: integerValue(row.ts, 'recent loot timestamp'),
      ...(quantity === undefined ? {} : { quantity })
    }
  })
  return { kills, loot }
}

function parseStateUnsafe(value: unknown): CloudSyncState {
  const source = objectValue(value, 'state')
  return {
    publishedAt: integerValue(source.publishedAt, 'publishedAt'),
    character: parseCharacter(source.character),
    combat: parseCombat(source.combat),
    ...(source.progression === undefined ? {} : { progression: parseProgression(source.progression) }),
    recent: parseRecent(source.recent)
  }
}

function checked<T>(parse: () => T): CloudSyncParseResult<T> {
  try {
    return { ok: true, value: parse() }
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    return { ok: false, error: { code: 'invalid_message', message: 'Message could not be read' } }
  }
}

function parseEnvelope(value: unknown): Record<string, unknown> {
  const source = objectValue(value, 'message')
  if (source.version !== CLOUD_SYNC_PROTOCOL_VERSION) {
    reject('unsupported_version', 'Unsupported cloud sync protocol version')
  }
  if (typeof source.type !== 'string') reject('unknown_type', 'Cloud sync message type is missing')
  return source
}

/** Validate and copy a state, discarding every field outside the public allowlist. */
export function parseCloudSyncState(value: unknown): CloudSyncParseResult<CloudSyncState> {
  return checked(() => parseStateUnsafe(value))
}

export function parseDesktopCloudSyncMessage(value: unknown): CloudSyncParseResult<DesktopCloudSyncMessage> {
  return checked(() => {
    const source = parseEnvelope(value)
    if (source.type === 'publish') {
      return {
        version: CLOUD_SYNC_PROTOCOL_VERSION,
        type: 'publish',
        state: parseStateUnsafe(source.state)
      }
    }
    if (source.type === 'ping') {
      return { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'ping', sentAt: integerValue(source.sentAt, 'sentAt') }
    }
    return reject('unknown_type', 'Unknown desktop cloud sync message type')
  })
}

function errorCode(value: unknown): CloudSyncErrorCode {
  if (
    value !== 'unauthorized' &&
    value !== 'invalid_message' &&
    value !== 'rate_limited' &&
    value !== 'version_mismatch' &&
    value !== 'internal'
  ) {
    reject('invalid_message', 'Unknown server error code')
  }
  return value
}

export function parseServerCloudSyncMessage(value: unknown): CloudSyncParseResult<ServerCloudSyncMessage> {
  return checked(() => {
    const source = parseEnvelope(value)
    if (source.type === 'ready') {
      return {
        version: CLOUD_SYNC_PROTOCOL_VERSION,
        type: 'ready',
        sessionId: stringValue(source.sessionId, 'sessionId', CLOUD_SYNC_LIMITS.maxIdChars),
        serverTime: integerValue(source.serverTime, 'serverTime')
      }
    }
    if (source.type === 'state') {
      return {
        version: CLOUD_SYNC_PROTOCOL_VERSION,
        type: 'state',
        revision: integerValue(source.revision, 'revision'),
        state: parseStateUnsafe(source.state)
      }
    }
    if (source.type === 'presence') {
      if (typeof source.online !== 'boolean') reject('invalid_message', 'presence.online must be boolean')
      return {
        version: CLOUD_SYNC_PROTOCOL_VERSION,
        type: 'presence',
        online: source.online,
        ...(source.lastSeenAt === undefined ? {} : { lastSeenAt: integerValue(source.lastSeenAt, 'lastSeenAt') })
      }
    }
    if (source.type === 'error') {
      return {
        version: CLOUD_SYNC_PROTOCOL_VERSION,
        type: 'error',
        code: errorCode(source.code),
        message: stringValue(source.message, 'error.message', CLOUD_SYNC_LIMITS.maxErrorChars),
        ...(source.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: integerValue(source.retryAfterMs, 'retryAfterMs') })
      }
    }
    return reject('unknown_type', 'Unknown server cloud sync message type')
  })
}

function parseJson<T>(json: string, parse: (value: unknown) => CloudSyncParseResult<T>): CloudSyncParseResult<T> {
  if (json.length > CLOUD_SYNC_LIMITS.maxJsonChars) {
    return { ok: false, error: { code: 'too_large', message: 'Cloud sync message is too large' } }
  }
  try {
    return parse(JSON.parse(json) as unknown)
  } catch {
    return { ok: false, error: { code: 'invalid_json', message: 'Cloud sync message is not valid JSON' } }
  }
}

export function parseDesktopCloudSyncJson(json: string): CloudSyncParseResult<DesktopCloudSyncMessage> {
  return parseJson(json, parseDesktopCloudSyncMessage)
}

export function parseServerCloudSyncJson(json: string): CloudSyncParseResult<ServerCloudSyncMessage> {
  return parseJson(json, parseServerCloudSyncMessage)
}

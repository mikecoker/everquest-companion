/**
 * Shared-room wire contract for the Discord Activity. A room is an explicit,
 * authenticated audience: every participant joined with its invite code, and
 * every published state still passes through the narrower cloudSync allowlist.
 */

import {
  CLOUD_SYNC_LIMITS,
  CLOUD_SYNC_PROTOCOL_VERSION,
  parseCloudSyncState,
  type CloudSyncParseResult,
  type CloudSyncState
} from './cloudSync'

export const CLOUD_ROOM_LIMITS = {
  maxJsonChars: 512 * 1024,
  maxParticipants: 72,
  maxEncounters: 25,
  maxRoomNameChars: 64
} as const

export interface CloudRoomParticipant {
  participantId: string
  displayName: string
  avatarUrl?: string
  online: boolean
  lastSeenAt?: number
  state?: CloudSyncState
}

export interface CloudRoomEncounterContribution {
  participantId: string
  characterName: string
  totalDamage: number
  dps: number
}

export interface CloudRoomEncounter {
  id: string
  target: string
  zone?: string
  startedAt: number
  endedAt?: number
  durationSec: number
  totalDamage: number
  dps: number
  active: boolean
  participants: CloudRoomEncounterContribution[]
}

export interface CloudRoomSnapshot {
  roomId: string
  name: string
  ownerParticipantId: string
  revision: number
  participants: CloudRoomParticipant[]
  encounters: CloudRoomEncounter[]
}

export interface ServerCloudRoomMessage {
  version: typeof CLOUD_SYNC_PROTOCOL_VERSION
  type: 'room'
  room: CloudRoomSnapshot
}

class RoomValidationError extends Error {}

function reject(message: string): never {
  throw new RoomValidationError(message)
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(`${label} must be an object`)
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string, max: number = CLOUD_SYNC_LIMITS.maxNameChars): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    reject(`${label} must be 1-${max} characters`)
  }
  return value
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    reject(`${label} must be a finite non-negative number`)
  }
  return value
}

function integerValue(value: unknown, label: string): number {
  const result = numberValue(value, label)
  if (!Number.isSafeInteger(result)) reject(`${label} must be an integer`)
  return result
}

function arrayValue(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) reject(`${label} must contain at most ${max} items`)
  return value
}

function parseParticipant(value: unknown): CloudRoomParticipant {
  const source = objectValue(value, 'participant')
  if (typeof source.online !== 'boolean') reject('participant.online must be boolean')
  const state = source.state === undefined ? undefined : parseCloudSyncState(source.state)
  if (state?.ok === false) reject(`participant.state is invalid: ${state.error.message}`)
  return {
    participantId: stringValue(source.participantId, 'participant.participantId', CLOUD_SYNC_LIMITS.maxIdChars),
    displayName: stringValue(source.displayName, 'participant.displayName'),
    ...(source.avatarUrl === undefined
      ? {}
      : { avatarUrl: stringValue(source.avatarUrl, 'participant.avatarUrl', 512) }),
    online: source.online,
    ...(source.lastSeenAt === undefined ? {} : { lastSeenAt: integerValue(source.lastSeenAt, 'participant.lastSeenAt') }),
    ...(state?.ok !== true ? {} : { state: state.value })
  }
}

function parseContribution(value: unknown): CloudRoomEncounterContribution {
  const source = objectValue(value, 'encounter participant')
  return {
    participantId: stringValue(source.participantId, 'encounter participant id', CLOUD_SYNC_LIMITS.maxIdChars),
    characterName: stringValue(source.characterName, 'encounter character name'),
    totalDamage: numberValue(source.totalDamage, 'encounter participant damage'),
    dps: numberValue(source.dps, 'encounter participant dps')
  }
}

function parseEncounter(value: unknown): CloudRoomEncounter {
  const source = objectValue(value, 'encounter')
  if (typeof source.active !== 'boolean') reject('encounter.active must be boolean')
  return {
    id: stringValue(source.id, 'encounter.id', CLOUD_SYNC_LIMITS.maxIdChars),
    target: stringValue(source.target, 'encounter.target'),
    ...(source.zone === undefined ? {} : { zone: stringValue(source.zone, 'encounter.zone', CLOUD_SYNC_LIMITS.maxZoneChars) }),
    startedAt: integerValue(source.startedAt, 'encounter.startedAt'),
    ...(source.endedAt === undefined ? {} : { endedAt: integerValue(source.endedAt, 'encounter.endedAt') }),
    durationSec: numberValue(source.durationSec, 'encounter.durationSec'),
    totalDamage: numberValue(source.totalDamage, 'encounter.totalDamage'),
    dps: numberValue(source.dps, 'encounter.dps'),
    active: source.active,
    participants: arrayValue(
      source.participants,
      'encounter.participants',
      CLOUD_ROOM_LIMITS.maxParticipants
    ).map(parseContribution)
  }
}

function parseSnapshot(value: unknown): CloudRoomSnapshot {
  const source = objectValue(value, 'room')
  return {
    roomId: stringValue(source.roomId, 'room.roomId', CLOUD_SYNC_LIMITS.maxIdChars),
    name: stringValue(source.name, 'room.name', CLOUD_ROOM_LIMITS.maxRoomNameChars),
    ownerParticipantId: stringValue(source.ownerParticipantId, 'room.ownerParticipantId', CLOUD_SYNC_LIMITS.maxIdChars),
    revision: integerValue(source.revision, 'room.revision'),
    participants: arrayValue(source.participants, 'room.participants', CLOUD_ROOM_LIMITS.maxParticipants)
      .map(parseParticipant),
    encounters: arrayValue(source.encounters, 'room.encounters', CLOUD_ROOM_LIMITS.maxEncounters)
      .map(parseEncounter)
  }
}

export function parseServerCloudRoomMessage(value: unknown): CloudSyncParseResult<ServerCloudRoomMessage> {
  try {
    const source = objectValue(value, 'message')
    if (source.version !== CLOUD_SYNC_PROTOCOL_VERSION) {
      return { ok: false, error: { code: 'unsupported_version', message: 'Unsupported cloud sync protocol version' } }
    }
    if (source.type !== 'room') {
      return { ok: false, error: { code: 'unknown_type', message: 'Unknown shared room message type' } }
    }
    return {
      ok: true,
      value: { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'room', room: parseSnapshot(source.room) }
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'invalid_message',
        message: error instanceof RoomValidationError ? error.message : 'Message could not be read'
      }
    }
  }
}

export function parseServerCloudRoomJson(json: string): CloudSyncParseResult<ServerCloudRoomMessage> {
  if (json.length > CLOUD_ROOM_LIMITS.maxJsonChars) {
    return { ok: false, error: { code: 'too_large', message: 'Shared room message is too large' } }
  }
  try {
    return parseServerCloudRoomMessage(JSON.parse(json) as unknown)
  } catch {
    return { ok: false, error: { code: 'invalid_json', message: 'Shared room message is not valid JSON' } }
  }
}

import {
  CLOUD_ROOM_LIMITS,
  type CloudRoomEncounter,
  type CloudRoomEncounterContribution,
  type CloudRoomParticipant,
  type CloudRoomSnapshot
} from '../../src/shared/cloudRoom'
import type { CloudSyncState } from '../../src/shared/cloudSync'

export interface RoomMemberIdentity {
  participantId: string
  displayName: string
  avatarUrl?: string
}

interface ParticipantRecord extends RoomMemberIdentity {
  online: boolean
  lastSeenAt?: number
  state?: CloudSyncState
}

interface ActiveEncounter {
  id: string
  target: string
  zone?: string
  startedAt: number
  lastUpdateAt: number
  participants: Record<string, CloudRoomEncounterContribution>
  fighting: Record<string, boolean>
}

export interface StoredRoomState {
  roomId: string
  name: string
  ownerParticipantId: string
  revision: number
  checkpointAt: number
  participants: Record<string, ParticipantRecord>
  active: ActiveEncounter[]
  history: CloudRoomEncounter[]
}

export function createStoredRoom(roomId: string, name: string, ownerParticipantId: string): StoredRoomState {
  return { roomId, name, ownerParticipantId, revision: 0, checkpointAt: 0, participants: {}, active: [], history: [] }
}

/** Upgrade the singular active encounter written by pre-0.13 Durable Objects. */
export function normalizeStoredRoomState(stored: StoredRoomState): StoredRoomState {
  const legacy = (stored as unknown as { active?: ActiveEncounter | ActiveEncounter[] }).active
  return { ...stored, active: legacy === undefined ? [] : Array.isArray(legacy) ? legacy : [legacy] }
}

function ownContribution(participantId: string, state: CloudSyncState): CloudRoomEncounterContribution {
  const ownRows = state.combat.rows.filter((row) => row.kind === 'self' || row.kind === 'pet')
  return {
    participantId,
    characterName: state.character.name,
    totalDamage: ownRows.reduce((total, row) => total + row.total, 0),
    dps: ownRows.reduce((total, row) => total + row.dps, 0)
  }
}

function participantView(record: ParticipantRecord): CloudRoomParticipant {
  return {
    participantId: record.participantId,
    displayName: record.displayName,
    ...(record.avatarUrl === undefined ? {} : { avatarUrl: record.avatarUrl }),
    online: record.online,
    ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
    ...(record.state === undefined ? {} : { state: record.state })
  }
}

function encounterView(active: ActiveEncounter, now: number, isActive: boolean): CloudRoomEncounter {
  const participants = Object.values(active.participants).sort((left, right) => right.totalDamage - left.totalDamage)
  const totalDamage = participants.reduce((total, participant) => total + participant.totalDamage, 0)
  const dps = participants.reduce((total, participant) => total + participant.dps, 0)
  const endedAt = isActive ? undefined : Math.max(active.startedAt, now)
  const durationSec = Math.max(1, ((endedAt ?? now) - active.startedAt) / 1_000)
  return {
    id: active.id,
    target: active.target,
    ...(active.zone === undefined ? {} : { zone: active.zone }),
    startedAt: active.startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    durationSec,
    totalDamage,
    dps,
    active: isActive,
    participants
  }
}

function chooseEncounterLabel(active: ActiveEncounter, state: CloudSyncState, contribution: CloudRoomEncounterContribution): void {
  const currentLeader = Object.values(active.participants)
    .reduce((highest, row) => Math.max(highest, row.totalDamage), 0)
  if (state.combat.target !== undefined && contribution.totalDamage >= currentLeader) active.target = state.combat.target
  if (state.character.zone !== undefined) active.zone = state.character.zone
}

const ENCOUNTER_OVERLAP_GRACE_MS = 60_000

function sameEncounter(active: ActiveEncounter, state: CloudSyncState, now: number): boolean {
  const zone = state.character.zone
  if (now - active.lastUpdateAt > ENCOUNTER_OVERLAP_GRACE_MS) return false
  if (active.zone !== undefined && zone !== undefined) return active.zone === zone
  return active.target === (state.combat.target ?? 'Shared encounter')
}

function createActiveEncounter(state: CloudSyncState, encounterId: string, now: number): ActiveEncounter {
  return {
    id: encounterId,
    target: state.combat.target ?? 'Shared encounter',
    ...(state.character.zone === undefined ? {} : { zone: state.character.zone }),
    startedAt: state.combat.startedAt ?? state.publishedAt,
    lastUpdateAt: now,
    participants: {},
    fighting: {}
  }
}

interface ActiveUpdate {
  participantId: string
  state: CloudSyncState
  encounterId: string
  now: number
}

function updateActiveEncounter(stored: StoredRoomState, update: ActiveUpdate): void {
  const { participantId, state, encounterId, now } = update
  let active = stored.active.find((candidate) => sameEncounter(candidate, state, now))
  if (active === undefined) {
    active = createActiveEncounter(state, encounterId, now)
    stored.active.unshift(active)
  }
  const contribution = ownContribution(participantId, state)
  chooseEncounterLabel(active, state, contribution)
  active.startedAt = Math.min(active.startedAt, state.combat.startedAt ?? state.publishedAt)
  active.lastUpdateAt = Math.max(active.lastUpdateAt, now)
  active.participants[participantId] = contribution
  active.fighting[participantId] = true
}

function finalizeIfSettled(stored: StoredRoomState, now: number): void {
  const settled = stored.active.filter((active) => !Object.values(active.fighting).some(Boolean))
  if (settled.length === 0) return
  stored.active = stored.active.filter((active) => Object.values(active.fighting).some(Boolean))
  stored.history.unshift(...settled.map((active) => encounterView(active, now, false)))
  stored.history = stored.history.slice(0, CLOUD_ROOM_LIMITS.maxEncounters)
}

function settleParticipant(active: ActiveEncounter, participantId: string, state: CloudSyncState, now: number): void {
  if (!active.fighting[participantId]) return
  const contribution = ownContribution(participantId, state)
  active.participants[participantId] = contribution
  active.lastUpdateAt = Math.max(active.lastUpdateAt, now)
  chooseEncounterLabel(active, state, contribution)
  active.fighting[participantId] = false
}

function changedDesktopEncounter(previous: CloudSyncState | undefined, next: CloudSyncState): boolean {
  return previous?.combat.inCombat === true && next.combat.inCombat &&
    (previous.combat.startedAt !== next.combat.startedAt || previous.character.zone !== next.character.zone)
}

export function addRoomMember(stored: StoredRoomState, member: RoomMemberIdentity): StoredRoomState {
  const previous = stored.participants[member.participantId]
  stored.participants[member.participantId] = {
    ...member,
    online: previous?.online ?? false,
    ...(previous?.lastSeenAt === undefined ? {} : { lastSeenAt: previous.lastSeenAt }),
    ...(previous?.state === undefined ? {} : { state: previous.state })
  }
  stored.revision += 1
  return stored
}

export function removeRoomMember(stored: StoredRoomState, participantId: string, now: number): StoredRoomState {
  stored.participants = Object.fromEntries(
    Object.entries(stored.participants).filter(([id]) => id !== participantId)
  )
  for (const active of stored.active) active.fighting[participantId] = false
  finalizeIfSettled(stored, now)
  stored.revision += 1
  return stored
}

export interface RoomContributionUpdate {
  member: RoomMemberIdentity
  state: CloudSyncState
  online: boolean
  now: number
  encounterId: string
}

export function applyRoomContribution(stored: StoredRoomState, update: RoomContributionUpdate): StoredRoomState {
  const { member, state, online, now, encounterId } = update
  const previous = stored.participants[member.participantId]?.state
  stored.participants[member.participantId] = {
    ...member,
    online,
    lastSeenAt: now,
    state
  }
  if (changedDesktopEncounter(previous, state) && previous !== undefined) {
    for (const active of stored.active) settleParticipant(active, member.participantId, previous, now)
    finalizeIfSettled(stored, now)
  }
  if (online && state.combat.inCombat) {
    updateActiveEncounter(stored, { participantId: member.participantId, state, encounterId, now })
  } else {
    for (const active of stored.active) settleParticipant(active, member.participantId, state, now)
  }
  finalizeIfSettled(stored, now)
  stored.revision += 1
  return stored
}

export function markRoomParticipantOffline(stored: StoredRoomState, participantId: string, now: number): StoredRoomState {
  const participant = stored.participants[participantId]
  if (participant !== undefined) {
    participant.online = false
    participant.lastSeenAt = now
  }
  for (const active of stored.active) active.fighting[participantId] = false
  finalizeIfSettled(stored, now)
  stored.revision += 1
  return stored
}

export function roomSnapshot(stored: StoredRoomState, now: number): CloudRoomSnapshot {
  const participants = Object.values(stored.participants)
    .sort((left, right) => Number(right.online) - Number(left.online) || left.displayName.localeCompare(right.displayName))
    .slice(0, CLOUD_ROOM_LIMITS.maxParticipants)
    .map(participantView)
  return {
    roomId: stored.roomId,
    name: stored.name,
    ownerParticipantId: stored.ownerParticipantId,
    revision: stored.revision,
    participants,
    encounters: [
      ...[...stored.active].sort((left, right) => right.lastUpdateAt - left.lastUpdateAt)
        .map((active) => encounterView(active, now, true)),
      ...stored.history
    ]
      .slice(0, CLOUD_ROOM_LIMITS.maxEncounters)
  }
}

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
  participants: Record<string, ParticipantRecord>
  active?: ActiveEncounter
  history: CloudRoomEncounter[]
}

export function createStoredRoom(roomId: string, name: string, ownerParticipantId: string): StoredRoomState {
  return { roomId, name, ownerParticipantId, revision: 0, participants: {}, history: [] }
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
    dps: totalDamage / durationSec,
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

function updateActiveEncounter(
  stored: StoredRoomState,
  participantId: string,
  state: CloudSyncState,
  encounterId: string
): void {
  stored.active ??= {
    id: encounterId,
    target: state.combat.target ?? 'Shared encounter',
    ...(state.character.zone === undefined ? {} : { zone: state.character.zone }),
    startedAt: state.combat.startedAt ?? state.publishedAt,
    lastUpdateAt: state.publishedAt,
    participants: {},
    fighting: {}
  }
  const contribution = ownContribution(participantId, state)
  chooseEncounterLabel(stored.active, state, contribution)
  stored.active.startedAt = Math.min(stored.active.startedAt, state.combat.startedAt ?? state.publishedAt)
  stored.active.lastUpdateAt = Math.max(stored.active.lastUpdateAt, state.publishedAt)
  stored.active.participants[participantId] = contribution
  stored.active.fighting[participantId] = true
}

function finalizeIfSettled(stored: StoredRoomState, now: number): void {
  const active = stored.active
  if (active === undefined || Object.values(active.fighting).some(Boolean)) return
  stored.history.unshift(encounterView(active, now, false))
  stored.history = stored.history.slice(0, CLOUD_ROOM_LIMITS.maxEncounters)
  delete stored.active
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
  if (stored.active !== undefined) stored.active.fighting[participantId] = false
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
  stored.participants[member.participantId] = {
    ...member,
    online,
    lastSeenAt: now,
    state
  }
  if (online && state.combat.inCombat) updateActiveEncounter(stored, member.participantId, state, encounterId)
  else if (stored.active !== undefined) stored.active.fighting[member.participantId] = false
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
  if (stored.active !== undefined) stored.active.fighting[participantId] = false
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
    encounters: [...(stored.active === undefined ? [] : [encounterView(stored.active, now, true)]), ...stored.history]
      .slice(0, CLOUD_ROOM_LIMITS.maxEncounters)
  }
}

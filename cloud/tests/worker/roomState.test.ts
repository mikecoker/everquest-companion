import { describe, expect, it } from 'vitest'
import type { CloudSyncState } from '../../../src/shared/cloudSync'
import {
  addRoomMember,
  applyRoomContribution,
  createStoredRoom,
  markRoomParticipantOffline,
  roomSnapshot
} from '../../worker/roomState'

function state(name: string, total: number, inCombat = true): CloudSyncState {
  return {
    publishedAt: 10_000,
    character: { id: name.toLowerCase(), name, server: 'freeport', classes: ['Monk'], zone: 'The Hole' },
    combat: {
      inCombat,
      target: 'a rock golem',
      startedAt: 5_000,
      totalDamage: total + 999,
      dps: (total + 999) / 5,
      rows: [
        { name, total, dps: total / 5, kind: 'self' },
        { name: `${name}'s pet`, total: 50, dps: 10, kind: 'pet' },
        { name: 'Observed ally', total: 999, dps: 199.8, kind: 'party' }
      ]
    },
    recent: { kills: [], loot: [] }
  }
}

describe('shared room aggregation', () => {
  it('sums only each participant self and owned-pet contribution', () => {
    const stored = createStoredRoom('room-1', 'Raid', 'one')
    addRoomMember(stored, { participantId: 'one', displayName: 'One' })
    addRoomMember(stored, { participantId: 'two', displayName: 'Two' })
    applyRoomContribution(stored, {
      member: { participantId: 'one', displayName: 'One' }, state: state('One', 400),
      online: true, now: 10_000, encounterId: 'enc-1'
    })
    applyRoomContribution(stored, {
      member: { participantId: 'two', displayName: 'Two' }, state: state('Two', 600),
      online: true, now: 10_000, encounterId: 'unused'
    })

    const encounter = roomSnapshot(stored, 10_000).encounters[0]
    expect(encounter?.totalDamage).toBe(1_100)
    expect(encounter?.participants.map((row) => row.totalDamage)).toEqual([650, 450])
  })

  it('finalizes an encounter when every contributor settles or disconnects', () => {
    const stored = createStoredRoom('room-1', 'Raid', 'one')
    applyRoomContribution(stored, {
      member: { participantId: 'one', displayName: 'One' }, state: state('One', 400),
      online: true, now: 10_000, encounterId: 'enc-1'
    })
    markRoomParticipantOffline(stored, 'one', 12_000)
    const encounter = roomSnapshot(stored, 12_000).encounters[0]
    expect(encounter).toMatchObject({ id: 'enc-1', active: false, endedAt: 12_000, totalDamage: 450 })
  })
})

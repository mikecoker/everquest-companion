import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLOUD_ROOM_LIMITS,
  parseServerCloudRoomJson,
  parseServerCloudRoomMessage,
  type CloudRoomSnapshot
} from '../src/shared/cloudRoom'
import type { CloudSyncState } from '../src/shared/cloudSync'

const state: CloudSyncState = {
  publishedAt: 100,
  character: { id: 'primitive@freeport', name: 'Primitive', server: 'freeport', classes: ['Monk'] },
  combat: {
    inCombat: true,
    target: 'a gnoll',
    startedAt: 90,
    totalDamage: 442,
    dps: 44.2,
    rows: [{ name: 'Primitive', total: 442, dps: 44.2, kind: 'self' }]
  },
  recent: { kills: [], loot: [] }
}

function room(): CloudRoomSnapshot {
  return {
    roomId: 'room-1',
    name: 'Friday raid',
    ownerParticipantId: 'discord-1',
    revision: 3,
    participants: [{ participantId: 'discord-1', displayName: 'Mike', online: true, state }],
    encounters: [{
      id: 'encounter-1',
      target: 'a gnoll',
      startedAt: 90,
      durationSec: 10,
      totalDamage: 442,
      dps: 44.2,
      active: true,
      participants: [{ participantId: 'discord-1', characterName: 'Primitive', totalDamage: 442, dps: 44.2 }]
    }]
  }
}

test('shared room messages round-trip a fresh bounded copy', () => {
  const message = { version: 1, type: 'room', room: room(), rawLog: 'private' }
  const parsed = parseServerCloudRoomMessage(message)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.value, { version: 1, type: 'room', room: room() })
  assert.notEqual(parsed.value.room, message.room)
  assert.notEqual(parsed.value.room.participants[0]?.state, state)
})

test('room parser rejects malformed, oversized, and overflowing messages', () => {
  assert.equal(parseServerCloudRoomJson('{').ok, false)
  assert.equal(parseServerCloudRoomJson(' '.repeat(CLOUD_ROOM_LIMITS.maxJsonChars + 1)).ok, false)
  const overflow = room()
  overflow.participants = Array.from({ length: CLOUD_ROOM_LIMITS.maxParticipants + 1 }, (_, index) => ({
    participantId: `p-${index}`,
    displayName: 'Player',
    online: false
  }))
  assert.equal(parseServerCloudRoomMessage({ version: 1, type: 'room', room: overflow }).ok, false)
})

test('room parser rejects invalid nested state and integer fields', () => {
  const invalidState = room() as unknown as Record<string, unknown>
  const participants = (invalidState.participants as Record<string, unknown>[])
  participants[0]!.state = { ...state, publishedAt: 1.5 }
  assert.equal(parseServerCloudRoomMessage({ version: 1, type: 'room', room: invalidState }).ok, false)

  const invalidRevision = room()
  invalidRevision.revision = -1
  assert.equal(parseServerCloudRoomMessage({ version: 1, type: 'room', room: invalidRevision }).ok, false)
})

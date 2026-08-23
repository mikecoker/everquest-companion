import { CLOUD_SYNC_PROTOCOL_VERSION } from '../../../src/shared/cloudSync'
import type { CloudRoomSnapshot } from '../../../src/shared/cloudRoom'
import { activityReducer, initialState } from './model'
import { liveState } from './test/fixture'

const account = {
  user: { id: '1', username: 'u', displayName: 'U' }, paired: true, devices: [],
  room: { id: 'room-1', name: 'Party', owner: true, joinedAt: 1 }
}

const room: CloudRoomSnapshot = {
  roomId: 'room-1', name: 'Party', ownerParticipantId: '1', revision: 4,
  participants: [{ participantId: '1', displayName: 'U', online: true, state: liveState }],
  encounters: []
}

describe('activity reducer', () => {
  it('enters the lobby without a room and waits when a room exists', () => {
    expect(activityReducer(initialState, { type: 'account', account: { ...account, room: null } }).phase).toBe('lobby')
    expect(activityReducer(initialState, { type: 'account', account }).phase).toBe('waiting')
  })

  it('deduplicates room revisions and retains the latest room offline', () => {
    const waiting = activityReducer(initialState, { type: 'account', account })
    const first = activityReducer(waiting, { type: 'socket', message: { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'room', room } })
    const duplicate = activityReducer(first, { type: 'socket', message: { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'room', room: { ...room, name: 'Wrong' } } })
    expect(duplicate).toBe(first)
    expect(activityReducer(first, { type: 'disconnected', at: 20 })).toMatchObject({ phase: 'stale', room, lastSeenAt: 20 })
  })

  it('preserves a room snapshot when refreshing the same membership', () => {
    const live = { ...initialState, phase: 'live' as const, account, room, revision: room.revision }
    expect(activityReducer(live, { type: 'account', account, roomCode: 'ABCD-EFGH-JKLM' })).toMatchObject({
      phase: 'waiting', room, revision: 4, roomCode: 'ABCD-EFGH-JKLM'
    })
  })
})

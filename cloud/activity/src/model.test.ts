import { CLOUD_SYNC_PROTOCOL_VERSION } from '../../../src/shared/cloudSync'
import { activityReducer, initialState } from './model'
import { liveState } from './test/fixture'

describe('activity reducer', () => {
  it('deduplicates server revisions and retains latest state offline', () => {
    const first = activityReducer({ ...initialState, phase: 'waiting' }, { type: 'socket', message: { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'state', revision: 4, state: liveState } })
    const duplicate = activityReducer(first, { type: 'socket', message: { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'state', revision: 4, state: { ...liveState, publishedAt: 9 } } })
    expect(duplicate).toBe(first)
    const stale = activityReducer(first, { type: 'socket', message: { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'presence', online: false, lastSeenAt: 1_900_000 } })
    expect(stale).toMatchObject({ phase: 'stale', state: liveState, lastSeenAt: 1_900_000 })
  })

  it('uses presence to distinguish waiting, live, and stale', () => {
    const waiting = activityReducer({ ...initialState, phase: 'waiting' }, { type: 'socket', message: { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'presence', online: true } })
    expect(waiting.phase).toBe('waiting')
    const withState = { ...waiting, state: liveState }
    expect(activityReducer(withState, { type: 'socket', message: { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'presence', online: true } }).phase).toBe('live')
    expect(activityReducer(withState, { type: 'disconnected', at: 20 }).phase).toBe('stale')
  })

  it('keeps an unpaired viewer on the pairing instructions during reconnects', () => {
    const unpaired = {
      ...initialState,
      phase: 'unpaired' as const,
      account: { user: { id: '1', username: 'u', displayName: 'U' }, paired: false, devices: [] }
    }
    expect(activityReducer(unpaired, { type: 'disconnected', at: 20 })).toBe(unpaired)
    expect(activityReducer(unpaired, { type: 'socket', message: { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'presence', online: false } })).toBe(unpaired)
  })
})

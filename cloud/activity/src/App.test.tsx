import { act, fireEvent, render, screen } from '@testing-library/react'
import { CLOUD_SYNC_PROTOCOL_VERSION } from '../../../src/shared/cloudSync'
import type { CloudRoomSnapshot } from '../../../src/shared/cloudRoom'
import { App, type AppDeps } from './App'
import type { ActivityApi, ViewerAccount } from './api'
import type { DiscordAdapter } from './discord'
import type { SocketLike } from './transport'
import { liveState } from './test/fixture'

class TestSocket implements SocketLike {
  listeners = new Map<string, ((event: Event | MessageEvent) => void)[]>()
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event | MessageEvent) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  close(): void { this.emit('close') }
  emit(type: string, event: Event | MessageEvent = new Event(type)): void { this.listeners.get(type)?.forEach((listener) => listener(event)) }
  message(value: unknown): void { this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) })) }
}

const viewerRoom = { id: 'room-1', name: 'Friday Group', owner: true, joinedAt: 1 }
const room: CloudRoomSnapshot = {
  roomId: 'room-1', name: 'Friday Group', ownerParticipantId: '1', revision: 5,
  participants: [
    { participantId: '1', displayName: 'Josh', online: true, state: liveState },
    { participantId: '2', displayName: 'Mira', online: true }
  ],
  encounters: [{
    id: 'fight-1', target: 'A fierce cockatrice', zone: 'The Overthere', startedAt: 1_790_000,
    durationSec: 20, totalDamage: 20_000, dps: 1_000, active: true,
    participants: [{ participantId: '1', characterName: 'Primitive', totalDamage: 12_450, dps: 622.5 }]
  }]
}

function testDeps(initialRoom: ViewerAccount['room']) {
  let currentRoom = initialRoom
  const loadMe = vi.fn((): Promise<ViewerAccount> => Promise.resolve({
    user: { id: '1', username: 'josh', displayName: 'Josh' }, paired: true,
    devices: [{ id: 'device-1', label: 'Gaming PC', createdAt: 1 }], room: currentRoom
  }))
  const createRoom = vi.fn(() => { currentRoom = viewerRoom; return Promise.resolve({ room: viewerRoom, code: 'ABCD-EFGH-JKLM' }) })
  const joinRoom = vi.fn(() => { currentRoom = { ...viewerRoom, owner: false }; return Promise.resolve(currentRoom) })
  const createPairing = vi.fn().mockResolvedValue({ code: '7QK2MP', expiresAt: 300_000 })
  const createViewerSession = vi.fn().mockResolvedValue('viewer-ticket')
  const api: ActivityApi = {
    exchangeOAuthCode: vi.fn().mockResolvedValue('sdk-access-token'), loadMe, createPairing, createViewerSession,
    createRoom, joinRoom, rotateRoomCode: vi.fn().mockResolvedValue('WXYZ-2345-6789'),
    leaveRoom: vi.fn().mockResolvedValue(undefined), closeRoom: vi.fn().mockResolvedValue(undefined),
    revokeDevice: vi.fn().mockResolvedValue(undefined), deleteAccount: vi.fn().mockResolvedValue(undefined)
  }
  const discord: DiscordAdapter = { ready: vi.fn().mockResolvedValue(undefined), authorize: vi.fn().mockResolvedValue('oauth-code'), authenticate: vi.fn().mockResolvedValue(undefined) }
  const sockets: TestSocket[] = []
  const deps: AppDeps = {
    clientId: 'client-id', discord: vi.fn(() => discord), api,
    socket: () => { const socket = new TestSocket(); sockets.push(socket); return socket },
    now: () => 1_800_000, random: () => 0.5,
    delay: (_ms, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  }
  return { deps, api, sockets, joinRoom }
}

describe('shared-room Activity', () => {
  it('authenticates into a room lobby without opening a viewer socket', async () => {
    const fixture = testDeps(null)
    render(<App deps={fixture.deps} />)
    expect(await screen.findByText('Join a shared room')).toBeInTheDocument()
    expect(fixture.sockets).toHaveLength(0)
  })

  it('creates a room and exposes its initial invite code', async () => {
    const fixture = testDeps(null)
    render(<App deps={fixture.deps} />)
    await screen.findByText('Join a shared room')
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }))
    await vi.waitFor(() => expect(fixture.sockets).toHaveLength(1))
    act(() => fixture.sockets[0].message({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'room', room }))
    expect(await screen.findAllByText('A fierce cockatrice')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }))
    expect(screen.getByLabelText('Room code')).toHaveTextContent('ABCD-EFGH-JKLM')
  })

  it('joins by code and renders Encounters as the default room view', async () => {
    const fixture = testDeps(null)
    render(<App deps={fixture.deps} />)
    await screen.findByText('Join a shared room')
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'abcd-efgh-jklm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join room' }))
    await vi.waitFor(() => expect(fixture.sockets).toHaveLength(1))
    expect(fixture.joinRoom).toHaveBeenCalledWith('ABCD-EFGH-JKLM')
    act(() => fixture.sockets[0].message({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'room', room }))
    expect(await screen.findByRole('navigation', { name: 'Shared room views' })).toBeInTheDocument()
    expect(screen.getByText('Group damage')).toBeInTheDocument()
  })

  it('lets viewers inspect another connected player and create pairing under Setup', async () => {
    const fixture = testDeps(viewerRoom)
    render(<App deps={fixture.deps} />)
    await vi.waitFor(() => expect(fixture.sockets).toHaveLength(1))
    act(() => fixture.sockets[0].message({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'room', room }))
    fireEvent.click(await screen.findByRole('button', { name: 'Players' }))
    fireEvent.click(screen.getByRole('button', { name: /Mira/ }))
    expect(screen.getByText('This player has not published desktop data yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create pairing code' }))
    expect(await screen.findByLabelText('Pairing code')).toHaveTextContent('7QK2MP')
  })

  it('renders incompatible protocol as a terminal state', async () => {
    const fixture = testDeps(viewerRoom)
    render(<App deps={fixture.deps} />)
    await vi.waitFor(() => expect(fixture.sockets).toHaveLength(1))
    act(() => fixture.sockets[0].message({ version: 999, type: 'room', room }))
    expect(await screen.findByText('Update required')).toBeInTheDocument()
  })
})

import { CLOUD_SYNC_PROTOCOL_VERSION } from '../../../src/shared/cloudSync'
import { backoffDelay, runViewerTransport, type SocketLike, type TransportDeps } from './transport'
import { liveState } from './test/fixture'

class FakeSocket implements SocketLike {
  listeners = new Map<string, ((event: Event | MessageEvent) => void)[]>()
  closed = false
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event | MessageEvent) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  close(): void { this.closed = true }
  emit(type: string, event: Event | MessageEvent = new Event(type)): void { this.listeners.get(type)?.forEach((listener) => listener(event)) }
}

function transportFixture() {
  const sockets: { url: string; socket: FakeSocket }[] = []
  const actions: unknown[] = []
  const delays: (() => void)[] = []
  const api = { createViewerSession: vi.fn().mockResolvedValueOnce('ticket-one').mockResolvedValueOnce('ticket-two') }
  const deps = {
    api, dispatch: (action: unknown) => actions.push(action), now: () => 10, random: () => 0.5,
    socket: (url: string) => { const socket = new FakeSocket(); sockets.push({ url, socket }); return socket },
    delay: (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => { if (!signal.aborted) delays.push(resolve) })
  } as unknown as TransportDeps
  return { deps, api, actions, sockets, delays }
}

describe('viewer transport', () => {
  it('validates frames, ignores malformed frames, and stops on incompatibility', async () => {
    const fixture = transportFixture()
    const controller = new AbortController()
    const running = runViewerTransport(fixture.deps, controller.signal)
    await vi.waitFor(() => expect(fixture.sockets).toHaveLength(1))
    fixture.sockets[0].socket.emit('message', new MessageEvent('message', { data: '{bad' }))
    fixture.sockets[0].socket.emit('message', new MessageEvent('message', { data: JSON.stringify({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'state', revision: 1, state: liveState }) }))
    fixture.sockets[0].socket.emit('message', new MessageEvent('message', { data: JSON.stringify({ version: 99, type: 'ready' }) }))
    await running
    expect(fixture.actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'socket' }), expect.objectContaining({ type: 'incompatible' })]))
    expect(fixture.api.createViewerSession).toHaveBeenCalledTimes(1)
  })

  it('gets a fresh ticket on bounded reconnect and cancels cleanly', async () => {
    const fixture = transportFixture()
    const controller = new AbortController()
    const running = runViewerTransport(fixture.deps, controller.signal)
    await vi.waitFor(() => expect(fixture.sockets).toHaveLength(1))
    fixture.sockets[0].socket.emit('close')
    await vi.waitFor(() => expect(fixture.delays).toHaveLength(1))
    fixture.delays.shift()?.()
    await vi.waitFor(() => expect(fixture.sockets).toHaveLength(2))
    expect(fixture.sockets.map(({ url }) => url)).toEqual(expect.arrayContaining([expect.stringContaining('ticket-one'), expect.stringContaining('ticket-two')]))
    controller.abort()
    await running
    expect(fixture.sockets[1].socket.closed).toBe(true)
  })

  it('bounds exponential backoff with jitter', () => {
    expect(backoffDelay(0, 0)).toBe(375)
    expect(backoffDelay(30, 1)).toBe(37_500)
  })
})

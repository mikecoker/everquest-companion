import { act, fireEvent, render, screen } from '@testing-library/react'
import { CLOUD_SYNC_PROTOCOL_VERSION } from '../../../src/shared/cloudSync'
import { App, type AppDeps } from './App'
import type { ActivityApi } from './api'
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

function testDeps(paired: boolean, ready = vi.fn().mockResolvedValue(undefined)) {
  const authorize = vi.fn().mockResolvedValue('oauth-code')
  const authenticate = vi.fn().mockResolvedValue(undefined)
  const exchangeOAuthCode = vi.fn().mockResolvedValue('sdk-access-token')
  const loadMe = vi.fn().mockResolvedValue({
    user: { id: '1', username: 'josh', displayName: 'Josh' },
    paired,
    devices: paired ? [{ id: 'device-1', label: 'Gaming PC', createdAt: 1 }] : []
  })
  const createPairing = vi.fn().mockResolvedValue({ code: '7QK2MP', expiresAt: 300_000 })
  const createViewerSession = vi.fn().mockResolvedValue('viewer-ticket')
  const revokeDevice = vi.fn().mockResolvedValue(undefined)
  const deleteAccount = vi.fn().mockResolvedValue(undefined)
  const discord: DiscordAdapter = { ready, authorize, authenticate }
  const api: ActivityApi = {
    exchangeOAuthCode, loadMe, createPairing, createViewerSession, revokeDevice, deleteAccount
  }
  const sockets: TestSocket[] = []
  const deps: AppDeps = {
    clientId: 'client-id', discord: vi.fn(() => discord), api,
    socket: () => { const socket = new TestSocket(); sockets.push(socket); return socket },
    now: () => 1_800_000, random: () => 0.5,
    delay: (_ms, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  }
  return {
    deps,
    calls: { ready, authorize, authenticate, exchangeOAuthCode, createPairing, createViewerSession, revokeDevice, deleteAccount },
    sockets
  }
}

async function renderReady(paired: boolean) {
  const fixture = testDeps(paired)
  render(<App deps={fixture.deps} />)
  await screen.findByText(paired ? 'Waiting for your desktop' : 'Pair your desktop companion')
  return fixture
}

describe('Activity UI states', () => {
  it('shows boot and a useful outside-Discord offline state with retry', async () => {
    const deps = { ...testDeps(false).deps, clientId: undefined }
    render(<App deps={deps} />)
    expect(screen.getByText('Connecting to Discord…')).toBeInTheDocument()
    expect(await screen.findByText('You’re offline')).toBeInTheDocument()
    expect(screen.getByText('Open this Activity inside Discord to connect.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('times out into offline help when Discord never becomes ready', async () => {
    const fixture = testDeps(false, vi.fn(() => new Promise<void>(() => undefined)))
    fixture.deps.delay = vi.fn().mockResolvedValue(undefined)
    render(<App deps={fixture.deps} />)
    expect(await screen.findByText('You’re offline')).toBeInTheDocument()
    expect(screen.getByText(/Discord did not respond/)).toBeInTheDocument()
  })

  it('authenticates in order and renders unpaired instructions plus one pairing action', async () => {
    const { calls } = await renderReady(false)
    expect(calls.ready).toHaveBeenCalledOnce()
    expect(calls.authorize).toHaveBeenCalledWith('client-id')
    expect(calls.exchangeOAuthCode).toHaveBeenCalledWith('oauth-code')
    expect(calls.authenticate).toHaveBeenCalledWith('sdk-access-token')
    expect(screen.getByText(/Preferences → Discord Live/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create pairing code' }))
    expect(await screen.findByLabelText('Pairing code')).toHaveTextContent('7QK2MP')
    expect(calls.createPairing).toHaveBeenCalledOnce()
  })

  it('renders paired waiting, then the responsive live dashboard as server text', async () => {
    const { sockets } = await renderReady(true)
    expect(screen.getByText('Waiting for desktop')).toBeInTheDocument()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].message({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'state', revision: 5, state: liveState })
    expect(await screen.findByText('A fierce cockatrice')).toBeInTheDocument()
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(document.querySelector('script:not([type="module"])')).not.toBeInTheDocument()
    expect(document.querySelector('[data-layout="responsive"]')).toHaveClass('dashboard')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '67.5')
    expect(screen.getByText('2× Cockatrice beak')).toBeInTheDocument()
  })

  it('retains the latest state in a clear stale/offline state', async () => {
    const { sockets } = await renderReady(true)
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].message({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'state', revision: 1, state: liveState })
    await screen.findByText('Primitive')
    sockets[0].message({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'presence', online: false, lastSeenAt: 1_790_000 })
    expect(await screen.findByText('Desktop offline')).toBeInTheDocument()
    expect(screen.getByText(/Showing the latest update · last seen/)).toBeInTheDocument()
    expect(screen.getByText('Primitive')).toBeInTheDocument()
  })

  it('lets the authenticated viewer revoke a desktop and erase the cloud account', async () => {
    const { calls } = await renderReady(true)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Gaming PC' }))
    await vi.waitFor(() => expect(calls.revokeDevice).toHaveBeenCalledWith('device-1'))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Delete cloud account' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Delete cloud account' }))
    expect(screen.getByText(/removes every paired desktop/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    expect(await screen.findByText('Cloud sync deleted')).toBeInTheDocument()
    expect(calls.deleteAccount).toHaveBeenCalledOnce()
  })

  it('renders incompatible protocol as a terminal explicit state', async () => {
    const { sockets, calls } = await renderReady(true)
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    act(() => sockets[0].message({ version: 999, type: 'ready', sessionId: 'x', serverTime: 0 }))
    expect(await screen.findByText('Update required')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(calls.createViewerSession).toHaveBeenCalledOnce()
  })
})

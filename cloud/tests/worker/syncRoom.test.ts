import { env } from 'cloudflare:workers'
import {
  applyD1Migrations,
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF
} from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SyncRoom } from '../../worker/SyncRoom'
import { jsonRequest, message, seedAccount, seedDevice, sessionCookie, TEST_STATE } from './helpers'

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

async function publisherTicket(device: { deviceId: string; deviceSecret: string }): Promise<string> {
  const response = await SELF.fetch(jsonRequest('/api/devices/session', device))
  return ((await response.json()) as { ticket: string }).ticket
}

async function viewerTicket(): Promise<string> {
  const response = await SELF.fetch(jsonRequest('/api/viewer/session', {}, await sessionCookie()))
  return ((await response.json()) as { ticket: string }).ticket
}

async function openSocket(ticket: string): Promise<WebSocket> {
  const response = await SELF.fetch(`https://worker.test/api/sync?ticket=${ticket}`, {
    headers: { upgrade: 'websocket' }
  })
  expect(response.status).toBe(101)
  const socket = response.webSocket!
  socket.accept()
  return socket
}

async function openPublisher(device: { deviceId: string; deviceSecret: string }): Promise<WebSocket> {
  const socket = await openSocket(await publisherTicket(device))
  expect((await message(socket)).type).toBe('ready')
  expect((await message(socket)).type).toBe('presence')
  return socket
}

async function openViewer(): Promise<WebSocket> {
  const socket = await openSocket(await viewerTicket())
  expect((await message(socket)).type).toBe('ready')
  return socket
}

function publish(socket: WebSocket, state = TEST_STATE): void {
  socket.send(JSON.stringify({ version: 1, type: 'publish', state }))
}

describe('SyncRoom authorization and protocol', () => {
  it('rejects missing tickets and direct unsigned room access', async () => {
    expect((await SELF.fetch('https://worker.test/api/sync', { headers: { upgrade: 'websocket' } })).status).toBe(401)
    const stub = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName('unsigned-room'))
    expect((await stub.fetch('https://room.test', { headers: { upgrade: 'websocket' } })).status).toBe(401)
  })

  it('validates publisher frames and assigns server-owned revisions', async () => {
    await seedAccount()
    const device = await seedDevice()
    const publisher = await openPublisher(device)
    const viewer = await openViewer()
    expect((await message(viewer)).type).toBe('presence')

    publisher.send('{bad json')
    expect(await message(publisher)).toMatchObject({ type: 'error', code: 'invalid_message' })
    viewer.send(JSON.stringify({ version: 1, type: 'publish', state: TEST_STATE }))
    expect(await message(viewer)).toMatchObject({ type: 'error', code: 'invalid_message' })
    publish(publisher)
    expect(await message(viewer)).toMatchObject({ type: 'state', revision: 1, state: TEST_STATE })
    publish(publisher, { ...TEST_STATE, publishedAt: 2000 })
    expect(await message(viewer)).toMatchObject({ type: 'state', revision: 2, state: { publishedAt: 2000 } })
    publisher.close()
    viewer.close()
  })

  it('fans out to viewers and sends the latest state immediately on reconnect', async () => {
    await seedAccount()
    const device = await seedDevice()
    const publisher = await openPublisher(device)
    const firstViewer = await openViewer()
    await message(firstViewer)
    publish(publisher)
    expect((await message(firstViewer)).revision).toBe(1)
    firstViewer.close()

    const reconnect = await openViewer()
    expect(await message(reconnect)).toMatchObject({ type: 'state', revision: 1, state: TEST_STATE })
    expect(await message(reconnect)).toMatchObject({ type: 'presence', online: true })
    publisher.close()
    reconnect.close()
  })

  it('replaces a stale publisher from the same device', async () => {
    await seedAccount()
    const device = await seedDevice()
    const first = await openPublisher(device)
    const closed = new Promise<CloseEvent>((resolve) => first.addEventListener('close', resolve, { once: true }))
    const second = await openPublisher(device)
    expect((await closed).code).toBe(4001)
    second.close()
  })

  it('disconnects a live publisher immediately when its owner revokes the device', async () => {
    await seedAccount()
    const device = await seedDevice()
    const publisher = await openPublisher(device)
    const reconnectTicket = await publisherTicket(device)
    const viewer = await openViewer()
    await message(viewer)
    const closed = new Promise<CloseEvent>((resolve) => publisher.addEventListener('close', resolve, { once: true }))
    const presence = message(viewer)

    const response = await SELF.fetch(
      new Request(`https://worker.test/api/devices/${device.deviceId}`, {
        method: 'DELETE',
        headers: { cookie: await sessionCookie() }
      })
    )
    expect(response.status).toBe(204)
    expect(await closed).toMatchObject({ code: 4003, reason: 'Device revoked' })
    expect(await presence).toMatchObject({ type: 'presence', online: false })
    expect(publisher.readyState).toBe(WebSocket.CLOSED)
    expect((await SELF.fetch(jsonRequest('/api/devices/session', device))).status).toBe(401)
    expect(
      (await SELF.fetch(`https://worker.test/api/sync?ticket=${reconnectTicket}`, { headers: { upgrade: 'websocket' } })).status
    ).toBe(401)
    viewer.close()
  })

  it('keeps the room online when revoking one of two publisher devices', async () => {
    await seedAccount()
    const revokedDevice = await seedDevice()
    const remainingDevice = await seedDevice()
    const revokedPublisher = await openPublisher(revokedDevice)
    const remainingPublisher = await openPublisher(remainingDevice)
    const viewer = await openViewer()
    await message(viewer)
    const closed = new Promise<CloseEvent>((resolve) => revokedPublisher.addEventListener('close', resolve, { once: true }))

    const response = await SELF.fetch(
      new Request(`https://worker.test/api/devices/${revokedDevice.deviceId}`, {
        method: 'DELETE',
        headers: { cookie: await sessionCookie() }
      })
    )
    expect(response.status).toBe(204)
    expect((await closed).code).toBe(4003)
    publish(remainingPublisher)
    expect(await message(viewer)).toMatchObject({ type: 'state', revision: 1 })
    remainingPublisher.close()
    viewer.close()
  })
})

describe('hibernation and retention', () => {
  it('reconstructs sockets and bounded attachments after eviction', async () => {
    await seedAccount()
    const device = await seedDevice()
    const publisher = await openPublisher(device)
    const viewer = await openViewer()
    await message(viewer)
    const stub = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName('123456789012345678'))

    await evictDurableObject(stub)
    publish(publisher)
    expect(await message(viewer)).toMatchObject({ type: 'state', revision: 1 })
    const attachments = await runInDurableObject(stub, (_instance: SyncRoom, state) =>
      state.getWebSockets().map((socket) => socket.deserializeAttachment() as Record<string, unknown>)
    )
    expect(attachments).toHaveLength(2)
    expect(Object.keys(attachments[0]!).sort()).toEqual([
      'bytes',
      'connectedAt',
      'messages',
      'offenses',
      'role',
      'subjectId',
      'windowStartedAt'
    ])
    publisher.close()
    viewer.close()
  })

  it('broadcasts offline and deletes stale state when the TTL alarm runs', async () => {
    await seedAccount()
    const device = await seedDevice()
    const publisher = await openPublisher(device)
    const viewer = await openViewer()
    await message(viewer)
    publish(publisher)
    await message(viewer)
    publisher.close(1000, 'done')
    expect(await message(viewer)).toMatchObject({ type: 'presence', online: false })

    const stub = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName('123456789012345678'))
    const alarmAt = await runInDurableObject(stub, (_instance: SyncRoom, state) => state.storage.getAlarm())
    expect(alarmAt).toBeGreaterThanOrEqual(Date.now() + 60 * 60 * 1000 - 1_000)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const stored = await runInDurableObject(stub, (_instance: SyncRoom, state) => state.storage.get('latest'))
    expect(stored).toBeUndefined()
    viewer.close()
  })

  it('enforces bounded message budgets and closes repeat offenders', async () => {
    await seedAccount()
    const publisher = await openPublisher(await seedDevice())
    for (let index = 0; index < 30; index += 1) {
      publisher.send(JSON.stringify({ version: 1, type: 'ping', sentAt: index }))
    }
    const closed = new Promise<CloseEvent>((resolve) => publisher.addEventListener('close', resolve, { once: true }))
    publisher.send(JSON.stringify({ version: 1, type: 'ping', sentAt: 31 }))
    expect(await message(publisher)).toMatchObject({ type: 'error', code: 'rate_limited' })
    publisher.send(JSON.stringify({ version: 1, type: 'ping', sentAt: 32 }))
    expect(await message(publisher)).toMatchObject({ type: 'error', code: 'rate_limited' })
    publisher.send(JSON.stringify({ version: 1, type: 'ping', sentAt: 33 }))
    expect(await message(publisher)).toMatchObject({ type: 'error', code: 'rate_limited' })
    expect((await closed).code).toBe(4008)
  })
})

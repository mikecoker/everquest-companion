import { env, exports } from 'cloudflare:workers'
import {
  applyD1Migrations,
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject
} from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SyncRoom } from '../../worker/SyncRoom'
import { signValue } from '../../worker/crypto'
import { consumeTicket } from '../../worker/deviceAuth'
import { ACCOUNT_ID, ACTIVITY_ORIGIN, jsonRequest, message, seedAccount, seedDevice, sessionCookie, TEST_STATE } from './helpers'

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

async function publisherTicket(device: { deviceId: string; deviceSecret: string }): Promise<string> {
  const response = await exports.default.fetch(jsonRequest('/api/devices/session', device))
  return (await response.json<{ ticket: string }>()).ticket
}

async function viewerTicket(): Promise<string> {
  const response = await exports.default.fetch(jsonRequest('/api/viewer/session', {}, await sessionCookie()))
  return (await response.json<{ ticket: string }>()).ticket
}

async function openSocket(ticket: string): Promise<WebSocket> {
  const response = await exports.default.fetch(`https://worker.test/api/sync?ticket=${ticket}`, {
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
    expect((await exports.default.fetch('https://worker.test/api/sync', { headers: { upgrade: 'websocket' } })).status).toBe(401)
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

    const response = await exports.default.fetch(
      new Request(`https://worker.test/api/devices/${device.deviceId}`, {
        method: 'DELETE',
        headers: { cookie: await sessionCookie(), origin: ACTIVITY_ORIGIN }
      })
    )
    expect(response.status).toBe(204)
    expect(await closed).toMatchObject({ code: 4003, reason: 'Device revoked' })
    expect(await presence).toMatchObject({ type: 'presence', online: false })
    expect(publisher.readyState).toBe(WebSocket.CLOSED)
    expect((await exports.default.fetch(jsonRequest('/api/devices/session', device))).status).toBe(401)
    expect(
      (await exports.default.fetch(`https://worker.test/api/sync?ticket=${reconnectTicket}`, { headers: { upgrade: 'websocket' } })).status
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

    const response = await exports.default.fetch(
      new Request(`https://worker.test/api/devices/${revokedDevice.deviceId}`, {
        method: 'DELETE',
        headers: { cookie: await sessionCookie(), origin: ACTIVITY_ORIGIN }
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
    const firstAttachment = attachments[0]
    if (firstAttachment === undefined) throw new Error('Durable Object attachment was missing')
    expect(Object.keys(firstAttachment).sort()).toEqual([
      'accountId',
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

describe('account erasure', () => {
  it('deletes only the authenticated account, its room state, and its live connections', async () => {
    const otherAccountId = '987654321098765432'
    await seedAccount()
    await seedAccount(otherAccountId)
    const publisher = await openPublisher(await seedDevice())
    const viewer = await openViewer()
    await message(viewer)
    publish(publisher)
    await message(viewer)

    const accountRoom = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName('123456789012345678'))
    const otherRoom = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(otherAccountId))
    await runInDurableObject(otherRoom, (_instance: SyncRoom, state) => state.storage.put('latest', { retained: true }))
    await env.DB.prepare(
      'INSERT INTO pairing (code_hash, discord_user_id, expires_at, consumed_at, created_at) VALUES (?, ?, 999999, NULL, 1)'
    ).bind('owned-pairing', ACCOUNT_ID).run()
    await env.DB.prepare(
      'INSERT INTO pairing (code_hash, discord_user_id, expires_at, consumed_at, created_at) VALUES (?, ?, 999999, NULL, 1)'
    ).bind('other-pairing', otherAccountId).run()
    await seedDevice(otherAccountId)
    await env.DB.prepare('INSERT INTO rate_limit (key, count, reset_at) VALUES (?, 1, 999999)')
      .bind(`pairing-account:${ACCOUNT_ID}`).run()
    await env.DB.prepare('INSERT INTO rate_limit (key, count, reset_at) VALUES (?, 1, 999999)')
      .bind(`pairing-account:${otherAccountId}`).run()

    const publisherClosed = new Promise<CloseEvent>((resolve) => publisher.addEventListener('close', resolve, { once: true }))
    const viewerClosed = new Promise<CloseEvent>((resolve) => viewer.addEventListener('close', resolve, { once: true }))
    const cookie = await sessionCookie()
    const eraseRequest = (): Request => new Request('https://worker.test/api/me', {
      method: 'DELETE',
      headers: { cookie, origin: ACTIVITY_ORIGIN }
    })
    expect((await exports.default.fetch(eraseRequest())).status).toBe(204)
    expect(await publisherClosed).toMatchObject({ code: 4004, reason: 'Account deleted' })
    expect(await viewerClosed).toMatchObject({ code: 4004, reason: 'Account deleted' })
    expect((await exports.default.fetch(eraseRequest())).status).toBe(204)

    const accountRows = await env.DB.prepare('SELECT COUNT(*) AS count FROM account WHERE discord_user_id = ?')
      .bind(ACCOUNT_ID).first<{ count: number }>()
    const ownedRows = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM device WHERE discord_user_id = ?) +
         (SELECT COUNT(*) FROM pairing WHERE discord_user_id = ?) +
         (SELECT COUNT(*) FROM session_ticket WHERE discord_user_id = ?) AS count`
    ).bind(ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID).first<{ count: number }>()
    const erasedRate = await env.DB.prepare('SELECT 1 FROM rate_limit WHERE key = ?')
      .bind(`pairing-account:${ACCOUNT_ID}`).first()
    expect(accountRows?.count).toBe(0)
    expect(ownedRows?.count).toBe(0)
    expect(erasedRate).toBeNull()
    expect(await runInDurableObject(accountRoom, (_instance: SyncRoom, state) => state.storage.list())).toEqual(new Map())

    expect(await env.DB.prepare('SELECT 1 FROM account WHERE discord_user_id = ?').bind(otherAccountId).first()).not.toBeNull()
    expect(await env.DB.prepare('SELECT 1 FROM device WHERE discord_user_id = ?').bind(otherAccountId).first()).not.toBeNull()
    expect(await env.DB.prepare('SELECT 1 FROM pairing WHERE discord_user_id = ?').bind(otherAccountId).first()).not.toBeNull()
    expect(await env.DB.prepare('SELECT 1 FROM rate_limit WHERE key = ?')
      .bind(`pairing-account:${otherAccountId}`).first()).not.toBeNull()
    expect(await runInDurableObject(otherRoom, (_instance: SyncRoom, state) => state.storage.get('latest')))
      .toEqual({ retained: true })
  })

  it('rejects a consumed handoff that reaches a fresh room after account deletion', async () => {
    await seedAccount()
    const ticket = await viewerTicket()
    const handoff = await consumeTicket(ticket, env)
    const encoded = btoa(JSON.stringify(handoff)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    const signed = await signValue(encoded, env.TICKET_SIGNING_KEY)
    const room = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(ACCOUNT_ID))

    const cookie = await sessionCookie()
    const erased = await exports.default.fetch(new Request('https://worker.test/api/me', {
      method: 'DELETE',
      headers: { cookie, origin: ACTIVITY_ORIGIN }
    }))
    expect(erased.status).toBe(204)
    await evictDurableObject(room)

    const response = await room.fetch('https://room.test', {
      headers: { upgrade: 'websocket', 'x-eq-sync-handoff': signed }
    })
    expect(response.status).toBe(401)
    expect(response.webSocket).toBeNull()
  })
})

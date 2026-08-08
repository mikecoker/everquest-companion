import { env, exports } from 'cloudflare:workers'
import { applyD1Migrations, reset, runInDurableObject } from 'cloudflare:test'
import type { SyncRoom } from '../../worker/SyncRoom'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CloudSyncState } from '../../../src/shared/cloudSync'
import {
  ACCOUNT_ID,
  ACTIVITY_ORIGIN,
  jsonRequest,
  message,
  seedAccount,
  seedDevice,
  sessionCookie,
  TEST_STATE
} from './helpers'

const OTHER_ACCOUNT_ID = '987654321098765432'

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

async function roomRequest(path: string, body: unknown, accountId = ACCOUNT_ID): Promise<Response> {
  return exports.default.fetch(jsonRequest(path, body, await sessionCookie(accountId)))
}

async function createTestRoom(): Promise<{ id: string; code: string }> {
  const response = await roomRequest('/api/rooms', { name: 'Friday raid' })
  expect(response.status).toBe(201)
  const body = await response.json<{ room: { id: string }; code: string }>()
  return { id: body.room.id, code: body.code }
}

async function ticket(path: string, body: unknown, accountId?: string): Promise<string> {
  const response = accountId === undefined
    ? await exports.default.fetch(jsonRequest(path, body))
    : await roomRequest(path, body, accountId)
  expect(response.status).toBe(200)
  return (await response.json<{ ticket: string }>()).ticket
}

async function socket(ticketValue: string): Promise<WebSocket> {
  const response = await exports.default.fetch(`https://worker.test/api/sync?ticket=${ticketValue}`, {
    headers: { upgrade: 'websocket' }
  })
  expect(response.status).toBe(101)
  const ws = response.webSocket!
  ws.accept()
  return ws
}

async function roomMessage(ws: WebSocket, label: string): Promise<Record<string, unknown>> {
  try {
    return await message(ws)
  } catch {
    throw new Error(`Timed out waiting for ${label}`)
  }
}

async function publisher(device: { deviceId: string; deviceSecret: string }): Promise<WebSocket> {
  const ws = await socket(await ticket('/api/devices/session', device))
  await roomMessage(ws, 'publisher ready')
  await roomMessage(ws, 'publisher presence')
  return ws
}

async function viewer(accountId: string): Promise<WebSocket> {
  const viewerTicket = await ticket('/api/viewer/session', {}, accountId)
  const storedTicket = await env.DB.prepare(
    'SELECT room_id FROM session_ticket WHERE discord_user_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(accountId, 'viewer').first<{ room_id: string | null }>()
  expect(storedTicket?.room_id).not.toBeNull()
  const ws = await socket(viewerTicket)
  expect(await roomMessage(ws, 'viewer ready')).toMatchObject({ type: 'ready' })
  const shared = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(`shared:${storedTicket!.room_id!}`))
  const diagnostic = await runInDurableObject(shared, async (_instance: SyncRoom, state) => ({
    stored: await state.storage.get('sharedRoom'),
    attachments: state.getWebSockets().map((entry) => entry.deserializeAttachment() as unknown)
  }))
  expect(diagnostic.stored).toBeDefined()
  expect(diagnostic.attachments).toEqual(expect.arrayContaining([
    expect.objectContaining({ accountId, roomId: storedTicket!.room_id })
  ]))
  return ws
}

function publishedState(name: string, damage: number): CloudSyncState {
  return {
    ...TEST_STATE,
    character: { ...TEST_STATE.character, id: `${name}@freeport`, name },
    combat: {
      ...TEST_STATE.combat,
      startedAt: 500,
      rows: [
        { name, total: damage, dps: damage / 4, kind: 'self' as const },
        { name: 'Observed ally', total: 9_999, dps: 2_499.75, kind: 'party' as const }
      ]
    }
  }
}

describe('shared room control plane and fanout', () => {
  it('creates and joins a hashed invite room, then fans out unique participant contributions', async () => {
    await seedAccount()
    await seedAccount(OTHER_ACCOUNT_ID)
    const ownerDevice = await seedDevice()
    const otherDevice = await seedDevice(OTHER_ACCOUNT_ID)
    const created = await createTestRoom()
    expect(created.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/u)
    const stored = await env.DB.prepare('SELECT invite_hash FROM room WHERE id = ?')
      .bind(created.id).first<{ invite_hash: string }>()
    expect(stored?.invite_hash).not.toContain(created.code.replaceAll('-', ''))

    const joined = await roomRequest('/api/rooms/join', { code: created.code }, OTHER_ACCOUNT_ID)
    expect(joined.status).toBe(200)
    expect(await joined.json()).toMatchObject({ room: { id: created.id, owner: false } })

    const ownerPublisher = await publisher(ownerDevice)
    const otherPublisher = await publisher(otherDevice)
    const ownerViewer = await viewer(ACCOUNT_ID)
    const otherViewer = await viewer(OTHER_ACCOUNT_ID)
    const firstMessages = Promise.all([
      roomMessage(ownerViewer, 'owner first contribution'),
      roomMessage(otherViewer, 'member first contribution')
    ])
    ownerPublisher.send(JSON.stringify({ version: 1, type: 'publish', state: publishedState('Primitive', 400) }))
    await firstMessages
    const combinedMessages = Promise.all([
      roomMessage(ownerViewer, 'owner combined contribution'),
      roomMessage(otherViewer, 'member combined contribution')
    ])
    otherPublisher.send(JSON.stringify({ version: 1, type: 'publish', state: publishedState('Partner', 600) }))
    const [combined] = await combinedMessages
    const combinedRoom = combined.room as {
      participants: { participantId: string; online: boolean }[]
      encounters: { totalDamage: number; active: boolean }[]
    }
    expect(combined.type).toBe('room')
    expect(combinedRoom.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: ACCOUNT_ID, online: true }),
      expect.objectContaining({ participantId: OTHER_ACCOUNT_ID, online: true })
    ]))
    expect(combinedRoom.encounters).toEqual([expect.objectContaining({ totalDamage: 1_000, active: true })])
    ownerPublisher.close()
    otherPublisher.close()
    ownerViewer.close()
    otherViewer.close()
  })

  it('lets a member leave and lets only the owner close the room', async () => {
    await seedAccount()
    await seedAccount(OTHER_ACCOUNT_ID)
    const created = await createTestRoom()
    await roomRequest('/api/rooms/join', { code: created.code }, OTHER_ACCOUNT_ID)
    const ownerViewer = await viewer(ACCOUNT_ID)
    const otherViewer = await viewer(OTHER_ACCOUNT_ID)
    const memberClosed = new Promise<CloseEvent>((resolve) => otherViewer.addEventListener('close', resolve, { once: true }))
    const ownerDeparture = roomMessage(ownerViewer, 'member departure')

    const leave = await exports.default.fetch(new Request(
      `https://worker.test/api/rooms/${created.id}/membership`,
      { method: 'DELETE', headers: { cookie: await sessionCookie(OTHER_ACCOUNT_ID), origin: ACTIVITY_ORIGIN } }
    ))
    expect(leave.status).toBe(204)
    expect(await memberClosed).toMatchObject({ code: 4007 })
    expect(await ownerDeparture).toMatchObject({ room: { participants: [expect.objectContaining({ participantId: ACCOUNT_ID })] } })

    const ownerClosed = new Promise<CloseEvent>((resolve) => ownerViewer.addEventListener('close', resolve, { once: true }))
    const close = await exports.default.fetch(new Request(`https://worker.test/api/rooms/${created.id}`, {
      method: 'DELETE', headers: { cookie: await sessionCookie(), origin: ACTIVITY_ORIGIN }
    }))
    expect(close.status).toBe(204)
    expect(await ownerClosed).toMatchObject({ code: 4006 })
    expect(await env.DB.prepare('SELECT 1 FROM room WHERE id = ? AND closed_at IS NULL').bind(created.id).first()).toBeNull()
  })
})

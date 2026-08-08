import { oauthToken, loadAccount, requireSession } from './auth'
import { eraseAccount } from './accountErasure'
import { requireActivityOrigin, requiresActivityOrigin } from './activityOrigin'
import {
  consumeTicket,
  createDeviceSession,
  createViewerSession,
  pairDevice,
  revokeDevice
} from './deviceAuth'
import { createPairing } from './pairing'
import { activeRoom, closeRoom, createRoom, joinRoom, leaveRoom, rotateRoomCode } from './rooms'
import { scheduleExpiredRowCleanup } from './retention'
import { signValue } from './crypto'
import type { Env, SyncHandoff } from './types'
import { errorResponse, HttpError, json } from './validation'

function encodeHandoff(handoff: SyncHandoff): string {
  return btoa(JSON.stringify(handoff)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

async function syncUpgrade(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'upgrade_required', 'A WebSocket upgrade is required')
  }
  const ticket = new URL(request.url).searchParams.get('ticket')
  if (ticket === null || ticket.length === 0 || ticket.length > 256) {
    throw new HttpError(401, 'unauthorized', 'A WebSocket ticket is required')
  }
  const handoff = await consumeTicket(ticket, env)
  const roomKey = handoff.roomId === undefined ? handoff.accountId : `shared:${handoff.roomId}`
  const room = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(roomKey))
  const headers = new Headers(request.headers)
  headers.set('x-eq-sync-handoff', await signValue(encodeHandoff(handoff), env.TICKET_SIGNING_KEY))
  return room.fetch(new Request(request, { headers }))
}

async function me(accountId: string, env: Env): Promise<Response> {
  const account = await loadAccount(accountId, env)
  const rows = await env.DB.prepare(
    `SELECT id, label, created_at FROM device
     WHERE discord_user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 100`
  )
    .bind(accountId)
    .all<{ id: string; label: string; created_at: number }>()
  const devices = rows.results.map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at }))
  return json({ account, devices, paired: devices.length > 0, room: await activeRoom(accountId, env) })
}

async function publicApi(request: Request, env: Env, path: string): Promise<Response | null> {
  if (request.method === 'POST' && path === '/api/oauth/token') return oauthToken(request, env)
  if (request.method === 'POST' && path === '/api/devices/pair') return json(await pairDevice(request, env))
  if (request.method === 'POST' && path === '/api/devices/session') {
    return json(await createDeviceSession(request, env))
  }
  if (request.method === 'GET' && path === '/api/sync') return syncUpgrade(request, env)
  return null
}

async function roomPostApi(request: Request, env: Env, path: string, accountId: string): Promise<Response | null> {
  if (path === '/api/rooms') return json(await createRoom(accountId, request, env), 201)
  if (path === '/api/rooms/join') return json(await joinRoom(accountId, request, env))
  const roomCodeMatch = /^\/api\/rooms\/([^/]+)\/code$/u.exec(path)
  if (roomCodeMatch?.[1] !== undefined) {
    return json(await rotateRoomCode(accountId, decodeURIComponent(roomCodeMatch[1]), env))
  }
  return null
}

async function roomDeleteApi(env: Env, path: string, accountId: string): Promise<Response | null> {
  const roomLeaveMatch = /^\/api\/rooms\/([^/]+)\/membership$/u.exec(path)
  if (roomLeaveMatch?.[1] !== undefined) {
    await leaveRoom(accountId, decodeURIComponent(roomLeaveMatch[1]), env)
    return new Response(null, { status: 204 })
  }
  const roomCloseMatch = /^\/api\/rooms\/([^/]+)$/u.exec(path)
  if (roomCloseMatch?.[1] !== undefined) {
    await closeRoom(accountId, decodeURIComponent(roomCloseMatch[1]), env)
    return new Response(null, { status: 204 })
  }
  return null
}

async function roomApi(request: Request, env: Env, path: string, accountId: string): Promise<Response | null> {
  if (!path.startsWith('/api/rooms')) return null
  if (request.method === 'POST') return roomPostApi(request, env, path, accountId)
  if (request.method === 'DELETE') return roomDeleteApi(env, path, accountId)
  return null
}

async function authenticatedPost(request: Request, env: Env, path: string, accountId: string): Promise<Response | null> {
  if (path === '/api/pairing') return json(await createPairing(accountId, request, env))
  if (path === '/api/viewer/session') return json(await createViewerSession(accountId, env))
  return null
}

async function authenticatedDelete(request: Request, env: Env, path: string, accountId: string): Promise<Response | null> {
  if (path === '/api/me') {
    await eraseAccount(accountId, env)
    return new Response(null, { status: 204 })
  }
  const encodedDeviceId = /^\/api\/devices\/([^/]+)$/u.exec(path)?.[1]
  if (encodedDeviceId === undefined) return null
  await revokeDevice(accountId, decodeURIComponent(encodedDeviceId), env)
  return new Response(null, { status: 204 })
}

async function authenticatedApi(request: Request, env: Env, path: string, accountId: string): Promise<Response> {
  const roomResponse = await roomApi(request, env, path, accountId)
  if (roomResponse !== null) return roomResponse
  if (request.method === 'GET' && path === '/api/me') return me(accountId, env)
  const response = request.method === 'POST'
    ? await authenticatedPost(request, env, path, accountId)
    : request.method === 'DELETE' ? await authenticatedDelete(request, env, path, accountId) : null
  if (response !== null) return response
  throw new HttpError(404, 'not_found', 'API route was not found')
}

async function routeApi(request: Request, env: Env, path: string): Promise<Response> {
  if (requiresActivityOrigin(request.method, path)) requireActivityOrigin(request, env)
  const publicResponse = await publicApi(request, env, path)
  if (publicResponse !== null) return publicResponse
  const accountId = await requireSession(request, env)
  return authenticatedApi(request, env, path, accountId)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    scheduleExpiredRowCleanup(env, ctx)
    const path = new URL(request.url).pathname
    try {
      if (path.startsWith('/api/')) return await routeApi(request, env, path)
      if (env.ASSETS !== undefined) return await env.ASSETS.fetch(request)
      return new Response('Not found', { status: 404 })
    } catch (error) {
      return errorResponse(error)
    }
  }
} satisfies ExportedHandler<Env>

export { SyncRoom } from './SyncRoom'

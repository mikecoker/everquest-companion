import { sha256 } from './crypto'
import { enforceRateLimit } from './rateLimit'
import type { SharedRoomTarget } from './SyncRoom'
import type { Env } from './types'
import { clientIp, HttpError, readJsonObject, requiredString } from './validation'

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROOM_CODE_CHARS = 12
const ROOM_NAME_CHARS = 64

interface RoomRow {
  id: string
  name: string
  owner_discord_user_id: string
  joined_at: number
}

export interface ViewerRoom {
  id: string
  name: string
  owner: boolean
  joinedAt: number
}

function secureRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_CHARS))
  const raw = Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('')
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`
}

function normalizedCode(value: string): string {
  return value.replaceAll('-', '').replaceAll(' ', '').toUpperCase()
}

async function codeHash(code: string, env: Env): Promise<string> {
  return sha256(`room:${normalizedCode(code)}:${env.DEVICE_PEPPER}`)
}

function roomView(row: RoomRow, accountId: string): ViewerRoom {
  return { id: row.id, name: row.name, owner: row.owner_discord_user_id === accountId, joinedAt: row.joined_at }
}

export async function activeRoom(accountId: string, env: Env): Promise<ViewerRoom | null> {
  const row = await env.DB.prepare(
    `SELECT r.id, r.name, r.owner_discord_user_id, rm.joined_at
     FROM room_member rm JOIN room r ON r.id = rm.room_id
     WHERE rm.discord_user_id = ? AND rm.left_at IS NULL AND r.closed_at IS NULL`
  ).bind(accountId).first<RoomRow>()
  return row === null ? null : roomView(row, accountId)
}

async function targetFor(roomId: string, accountId: string, env: Env): Promise<SharedRoomTarget> {
  const row = await env.DB.prepare(
    `SELECT r.name, r.owner_discord_user_id, a.display_name, a.avatar_url
     FROM room r JOIN account a ON a.discord_user_id = ?
     WHERE r.id = ? AND r.closed_at IS NULL`
  ).bind(accountId, roomId).first<{
    name: string
    owner_discord_user_id: string
    display_name: string
    avatar_url: string | null
  }>()
  if (row === null) throw new HttpError(404, 'room_not_found', 'Shared room was not found')
  return {
    roomId,
    name: row.name,
    ownerParticipantId: row.owner_discord_user_id,
    member: {
      participantId: accountId,
      displayName: row.display_name,
      ...(row.avatar_url === null ? {} : { avatarUrl: row.avatar_url })
    }
  }
}

async function attachMembership(roomId: string, accountId: string, env: Env): Promise<void> {
  const target = await targetFor(roomId, accountId, env)
  const accountRoom = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(accountId))
  await accountRoom.attachToSharedRoom(target)
}

function requestedRoomName(source: Record<string, unknown>, displayName: string): string {
  const value = source.name
  if (value === undefined) return `${displayName}'s room`.slice(0, ROOM_NAME_CHARS)
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > ROOM_NAME_CHARS) {
    throw new HttpError(400, 'invalid_request', `name must be 1-${ROOM_NAME_CHARS} characters`)
  }
  return value.trim()
}

async function accountDisplayName(accountId: string, env: Env): Promise<string> {
  const account = await env.DB.prepare('SELECT display_name FROM account WHERE discord_user_id = ?')
    .bind(accountId).first<{ display_name: string }>()
  if (account === null) throw new HttpError(401, 'unauthorized', 'Account no longer exists')
  return account.display_name
}

async function insertRoom(
  accountId: string,
  name: string,
  options: { code: string; env: Env; now: number }
): Promise<string> {
  const { code, env, now } = options
  const roomId = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO room (id, name, owner_discord_user_id, invite_hash, created_at, last_active_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    ).bind(roomId, name, accountId, await codeHash(code, env), now, now),
    env.DB.prepare(
      'INSERT INTO room_member (room_id, discord_user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)'
    ).bind(roomId, accountId, now)
  ])
  return roomId
}

export async function createRoom(accountId: string, request: Request, env: Env): Promise<{ room: ViewerRoom; code: string }> {
  if (await activeRoom(accountId, env) !== null) {
    throw new HttpError(409, 'already_in_room', 'Leave or close the current shared room first')
  }
  const source = await readJsonObject(request)
  const name = requestedRoomName(source, await accountDisplayName(accountId, env))
  const now = Date.now()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = secureRoomCode()
    try {
      const roomId = await insertRoom(accountId, name, { code, env, now })
      await attachMembership(roomId, accountId, env)
      const room = await activeRoom(accountId, env)
      if (room === null) throw new HttpError(500, 'internal', 'Shared room could not be loaded')
      return { room, code }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.toLowerCase().includes('unique')) throw error
    }
  }
  throw new HttpError(503, 'room_unavailable', 'A shared room code could not be allocated')
}

export async function joinRoom(accountId: string, request: Request, env: Env): Promise<{ room: ViewerRoom }> {
  const current = await activeRoom(accountId, env)
  if (current !== null) return { room: current }
  const source = await readJsonObject(request)
  const code = normalizedCode(requiredString(source, 'code', 32))
  if (!/^[A-Z2-9]{12}$/u.test(code)) throw new HttpError(400, 'invalid_room_code', 'Room code is invalid')
  await enforceRateLimit(env, `room-join-account:${accountId}`, { limit: 20, windowMs: 5 * 60 * 1000 })
  await enforceRateLimit(env, `room-join-ip:${clientIp(request)}`, { limit: 40, windowMs: 5 * 60 * 1000 })
  const row = await env.DB.prepare('SELECT id FROM room WHERE invite_hash = ? AND closed_at IS NULL')
    .bind(await codeHash(code, env)).first<{ id: string }>()
  if (row === null) throw new HttpError(400, 'invalid_room_code', 'Room code is invalid')
  await env.DB.prepare(
    `INSERT INTO room_member (room_id, discord_user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(room_id, discord_user_id) DO UPDATE SET joined_at=excluded.joined_at, left_at=NULL`
  ).bind(row.id, accountId, Date.now()).run()
  await attachMembership(row.id, accountId, env)
  const room = await activeRoom(accountId, env)
  if (room === null) throw new HttpError(500, 'internal', 'Shared room could not be loaded')
  return { room }
}

export async function rotateRoomCode(accountId: string, roomId: string, env: Env): Promise<{ code: string }> {
  const code = secureRoomCode()
  const result = await env.DB.prepare(
    'UPDATE room SET invite_hash = ?, last_active_at = ? WHERE id = ? AND owner_discord_user_id = ? AND closed_at IS NULL'
  ).bind(await codeHash(code, env), Date.now(), roomId, accountId).run()
  if (result.meta.changes === 0) throw new HttpError(404, 'room_not_found', 'Owned shared room was not found')
  return { code }
}

export async function leaveRoom(accountId: string, roomId: string, env: Env): Promise<void> {
  const room = await activeRoom(accountId, env)
  if (room?.id !== roomId) throw new HttpError(404, 'room_not_found', 'Shared room was not found')
  if (room.owner) throw new HttpError(409, 'owner_must_close', 'The room owner must close the shared room')
  await env.DB.prepare('UPDATE room_member SET left_at = ? WHERE room_id = ? AND discord_user_id = ? AND left_at IS NULL')
    .bind(Date.now(), roomId, accountId).run()
  const accountRoom = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(accountId))
  const shared = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(`shared:${roomId}`))
  await accountRoom.detachFromSharedRoom(roomId)
  await shared.removeSharedRoomMember(accountId)
}

export async function closeRoom(accountId: string, roomId: string, env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT rm.discord_user_id FROM room_member rm JOIN room r ON r.id = rm.room_id
     WHERE r.id = ? AND r.owner_discord_user_id = ? AND r.closed_at IS NULL AND rm.left_at IS NULL`
  ).bind(roomId, accountId).all<{ discord_user_id: string }>()
  if (rows.results.length === 0) throw new HttpError(404, 'room_not_found', 'Owned shared room was not found')
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('UPDATE room SET closed_at = ?, last_active_at = ? WHERE id = ?').bind(now, now, roomId),
    env.DB.prepare('UPDATE room_member SET left_at = ? WHERE room_id = ? AND left_at IS NULL').bind(now, roomId)
  ])
  await Promise.all(rows.results.map(async ({ discord_user_id: memberId }) => {
    const accountRoom = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(memberId))
    await accountRoom.detachFromSharedRoom(roomId)
  }))
  const shared = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(`shared:${roomId}`))
  await shared.closeSharedRoom()
}

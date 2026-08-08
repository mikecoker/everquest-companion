import { hashDeviceSecret, randomToken, sha256, verifyDeviceSecret } from './crypto'
import { consumePairing } from './pairing'
import { enforceRateLimit } from './rateLimit'
import type { Env, SyncHandoff, SyncRole } from './types'
import { clientIp, HttpError, readJsonObject, requiredString } from './validation'

const TICKET_TTL_MS = 60 * 1000

export async function pairDevice(request: Request, env: Env): Promise<Record<string, string>> {
  const source = await readJsonObject(request)
  await enforceRateLimit(env, `device-pair-ip:${clientIp(request)}`, { limit: 20, windowMs: 5 * 60 * 1000 })
  const code = requiredString(source, 'code', 32).replaceAll('-', '').toUpperCase()
  const labelValue = source.label
  const label = typeof labelValue === 'string' && labelValue.length > 0 ? labelValue.slice(0, 64) : 'EQ Companion'
  const accountId = await consumePairing(code, env)
  const deviceId = crypto.randomUUID()
  const deviceSecret = randomToken()
  const salt = randomToken(16)
  await env.DB.prepare(
    `INSERT INTO device (id, discord_user_id, secret_hash, label, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  )
    .bind(deviceId, accountId, await hashDeviceSecret(deviceSecret, salt, env.DEVICE_PEPPER), label, Date.now())
    .run()
  const account = await env.DB.prepare('SELECT display_name FROM account WHERE discord_user_id = ?')
    .bind(accountId)
    .first<{ display_name: string }>()
  return { deviceId, deviceSecret, discordName: account?.display_name ?? 'Discord user' }
}

async function createTicket(
  accountId: string,
  role: SyncRole,
  subjectId: string,
  env: Env
): Promise<{ ticket: string; expiresAt: number }> {
  const now = Date.now()
  const ticket = randomToken()
  const expiresAt = now + TICKET_TTL_MS
  await env.DB.prepare(
    `INSERT INTO session_ticket (token_hash, discord_user_id, role, subject_id, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  )
    .bind(await sha256(`${ticket}:${env.TICKET_SIGNING_KEY}`), accountId, role, subjectId, expiresAt, now)
    .run()
  return { ticket, expiresAt }
}

export async function createDeviceSession(request: Request, env: Env): Promise<{ ticket: string; expiresAt: number }> {
  const source = await readJsonObject(request)
  const deviceId = requiredString(source, 'deviceId', 128)
  const deviceSecret = requiredString(source, 'deviceSecret', 256)
  await enforceRateLimit(env, `device-session-ip:${clientIp(request)}`, { limit: 60, windowMs: 5 * 60 * 1000 })
  const row = await env.DB.prepare(
    'SELECT discord_user_id, secret_hash, revoked_at FROM device WHERE id = ?'
  )
    .bind(deviceId)
    .first<{ discord_user_id: string; secret_hash: string; revoked_at: number | null }>()
  if (
    row === null ||
    row.revoked_at !== null ||
    !(await verifyDeviceSecret(deviceSecret, row.secret_hash, env.DEVICE_PEPPER))
  ) {
    throw new HttpError(401, 'unauthorized', 'Device credentials are invalid or revoked')
  }
  return createTicket(row.discord_user_id, 'publisher', deviceId, env)
}

export function createViewerSession(accountId: string, env: Env): Promise<{ ticket: string; expiresAt: number }> {
  return createTicket(accountId, 'viewer', accountId, env)
}

export async function revokeDevice(accountId: string, deviceId: string, env: Env): Promise<void> {
  const result = await env.DB.prepare(
    'UPDATE device SET revoked_at = ? WHERE id = ? AND discord_user_id = ? AND revoked_at IS NULL'
  )
    .bind(Date.now(), deviceId, accountId)
    .run()
  if (result.meta.changes === 0) throw new HttpError(404, 'not_found', 'Device was not found')
  const room = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(accountId))
  await room.disconnectPublisher(deviceId)
}

export async function consumeTicket(ticket: string, env: Env, now = Date.now()): Promise<SyncHandoff> {
  const tokenHash = await sha256(`${ticket}:${env.TICKET_SIGNING_KEY}`)
  const row = await env.DB.prepare(
    `UPDATE session_ticket SET consumed_at = ?
     WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING discord_user_id, role, subject_id, expires_at`
  )
    .bind(now, tokenHash, now)
    .first<{ discord_user_id: string; role: string; subject_id: string; expires_at: number }>()
  if (row === null || (row.role !== 'publisher' && row.role !== 'viewer')) {
    throw new HttpError(401, 'unauthorized', 'WebSocket ticket is invalid or expired')
  }
  if (row.role === 'publisher') {
    const active = await env.DB.prepare(
      'SELECT 1 AS valid FROM device WHERE id = ? AND discord_user_id = ? AND revoked_at IS NULL'
    )
      .bind(row.subject_id, row.discord_user_id)
      .first<{ valid: number }>()
    if (active === null) throw new HttpError(401, 'unauthorized', 'Device is revoked')
  }
  return {
    accountId: row.discord_user_id,
    role: row.role,
    subjectId: row.subject_id,
    expiresAt: row.expires_at,
    nonce: tokenHash.slice(0, 24)
  }
}

import { randomToken, sha256 } from './crypto'
import { enforceRateLimit } from './rateLimit'
import type { Env } from './types'
import { clientIp, HttpError } from './validation'

const PAIRING_TTL_MS = 5 * 60 * 1000
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export type PairingCodeSource = () => string

export interface PairingOptions {
  codeSource?: PairingCodeSource
  now?: number
}

function securePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join('')
}

export async function pairingHash(code: string, env: Env): Promise<string> {
  return sha256(`${code.toUpperCase()}:${env.DEVICE_PEPPER}`)
}

export async function createPairing(
  accountId: string,
  request: Request,
  env: Env,
  options: PairingOptions = {}
): Promise<{ code: string; expiresAt: number }> {
  const { codeSource = securePairingCode, now = Date.now() } = options
  await enforceRateLimit(env, `pairing-account:${accountId}`, { limit: 5, windowMs: PAIRING_TTL_MS, now })
  await enforceRateLimit(env, `pairing-ip:${clientIp(request)}`, { limit: 10, windowMs: PAIRING_TTL_MS, now })
  const expiresAt = now + PAIRING_TTL_MS
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = codeSource().toUpperCase()
    if (!/^[A-Z2-9]{8}$/u.test(code)) throw new HttpError(500, 'internal', 'Pairing code generation failed')
    try {
      await env.DB.prepare(
        'INSERT INTO pairing (code_hash, discord_user_id, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)'
      )
        .bind(await pairingHash(code, env), accountId, expiresAt, now)
        .run()
      return { code, expiresAt }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.toLowerCase().includes('unique')) throw error
    }
  }
  throw new HttpError(503, 'pairing_unavailable', 'A pairing code could not be allocated')
}

export async function consumePairing(code: string, env: Env, now = Date.now()): Promise<string> {
  const row = await env.DB.prepare(
    `UPDATE pairing SET consumed_at = ?
     WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING discord_user_id`
  )
    .bind(now, await pairingHash(code, env), now)
    .first<{ discord_user_id: string }>()
  if (row === null) throw new HttpError(400, 'invalid_pairing_code', 'Pairing code is invalid or expired')
  return row.discord_user_id
}

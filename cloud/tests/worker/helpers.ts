import { env } from 'cloudflare:workers'
import { signValue, hashDeviceSecret, randomToken } from '../../worker/crypto'

export const ACCOUNT_ID = '123456789012345678'

export async function seedAccount(accountId = ACCOUNT_ID): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO account (discord_user_id, username, display_name, avatar_url, created_at, last_seen_at)
     VALUES (?, 'primitive', 'Primitive', NULL, 1, 1)`
  )
    .bind(accountId)
    .run()
}

export async function sessionCookie(accountId = ACCOUNT_ID, expiresAt = Date.now() + 60_000): Promise<string> {
  const payload = btoa(JSON.stringify({ sub: accountId, exp: expiresAt }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
  return `eq_activity_session=${await signValue(payload, env.COOKIE_SIGNING_KEY)}`
}

export async function seedDevice(accountId = ACCOUNT_ID): Promise<{ deviceId: string; deviceSecret: string }> {
  const deviceId = crypto.randomUUID()
  const deviceSecret = randomToken()
  const salt = randomToken(16)
  await env.DB.prepare(
    `INSERT INTO device (id, discord_user_id, secret_hash, label, created_at, revoked_at)
     VALUES (?, ?, ?, 'Test desktop', ?, NULL)`
  )
    .bind(deviceId, accountId, await hashDeviceSecret(deviceSecret, salt, env.DEVICE_PEPPER), Date.now())
    .run()
  return { deviceId, deviceSecret }
}

export function jsonRequest(path: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie !== undefined) headers.cookie = cookie
  return new Request(`https://worker.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

export async function message(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 2_000)
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout)
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>)
      },
      { once: true }
    )
  })
}

export const TEST_STATE = {
  publishedAt: 1000,
  character: { id: 'Primitive@freeport', name: 'Primitive', server: 'freeport', level: 50, classes: ['Monk'] },
  combat: { inCombat: true, target: 'a test dummy', totalDamage: 442, dps: 110.5, rows: [] },
  recent: { kills: [], loot: [] }
}

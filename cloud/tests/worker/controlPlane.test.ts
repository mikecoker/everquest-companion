import { env, exports } from 'cloudflare:workers'
import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consumePairing, createPairing, pairingHash } from '../../worker/pairing'
import { oauthToken } from '../../worker/auth'
import { ACCOUNT_ID, ACTIVITY_ORIGIN, jsonRequest, seedAccount, seedDevice, sessionCookie } from './helpers'

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  vi.restoreAllMocks()
})

describe('Discord OAuth and Activity session', () => {
  it('rejects browser mutations from missing or foreign origins', async () => {
    await seedAccount()
    const cookie = await sessionCookie()
    expect((await exports.default.fetch(new Request('https://worker.test/api/pairing', {
      method: 'POST', headers: { cookie }
    }))).status).toBe(403)
    expect((await exports.default.fetch(new Request('https://worker.test/api/pairing', {
      method: 'POST', headers: { cookie, origin: 'https://attacker.example' }
    }))).status).toBe(403)
    expect((await exports.default.fetch(new Request('https://worker.test/api/pairing', {
      method: 'POST', headers: { cookie, origin: ACTIVITY_ORIGIN }
    }))).status).toBe(200)
  })

  it('returns bounded failures when Discord rejects the exchange', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }))
    await expect(oauthToken(jsonRequest('/api/oauth/token', { code: 'bad-code' }), env)).rejects.toMatchObject({
      status: 401,
      code: 'oauth_failed',
      message: 'Discord authorization failed'
    })
  })

  it('establishes identity server-side and sets the iframe-safe cookie', async () => {
    const outbound = vi.spyOn(globalThis, 'fetch')
    outbound.mockResolvedValueOnce(Response.json({ access_token: 'short-lived-token' }))
    outbound.mockResolvedValueOnce(
      Response.json({ id: ACCOUNT_ID, username: 'primitive', global_name: 'Primitive', avatar: 'avatar-hash' })
    )
    const response = await oauthToken(jsonRequest('/api/oauth/token', { code: 'real-code' }), env)
    const body = await response.json()
    expect({ status: response.status, body }).toEqual({ status: 200, body: {
      accessToken: 'short-lived-token',
      account: {
        id: ACCOUNT_ID,
        username: 'primitive',
        displayName: 'Primitive',
        avatarUrl: `https://cdn.discordapp.com/avatars/${ACCOUNT_ID}/avatar-hash.png`
      }
    } })
    expect(response.headers.get('set-cookie')).toMatch(
      /^eq_activity_session=.*; Path=\/; Max-Age=86400; Secure; HttpOnly; SameSite=None; Partitioned$/u
    )
    expect(outbound.mock.calls[1]?.[1]?.headers).toEqual({ authorization: 'Bearer short-lived-token' })
  })
})

describe('pairing', () => {
  it('retries a hash collision and consumes a code only once', async () => {
    await seedAccount()
    const request = new Request('https://worker.test/api/pairing', { headers: { 'cf-connecting-ip': '192.0.2.1' } })
    await env.DB.prepare(
      'INSERT INTO pairing (code_hash, discord_user_id, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)'
    )
      .bind(await pairingHash('ABCDEFGH', env), ACCOUNT_ID, Date.now() + 60_000, Date.now())
      .run()
    const codes = ['ABCDEFGH', 'BCDEFGHJ']
    const result = await createPairing(ACCOUNT_ID, request, env, { codeSource: () => codes.shift()! })
    expect(result.code).toBe('BCDEFGHJ')
    expect(await consumePairing(result.code, env)).toBe(ACCOUNT_ID)
    await expect(consumePairing(result.code, env)).rejects.toMatchObject({ code: 'invalid_pairing_code' })
  })

  it('rejects expired codes and bounds account attempts', async () => {
    await seedAccount()
    const request = new Request('https://worker.test/api/pairing', { headers: { 'cf-connecting-ip': '192.0.2.2' } })
    const expired = await createPairing(ACCOUNT_ID, request, env, { codeSource: () => 'CDEFGHJK', now: 1000 })
    await expect(consumePairing(expired.code, env, 1000 + 5 * 60 * 1000)).rejects.toMatchObject({
      code: 'invalid_pairing_code'
    })
    for (let index = 0; index < 5; index += 1) {
      await createPairing(ACCOUNT_ID, request, env, { codeSource: () => `DEFGHJK${index + 2}` })
    }
    await expect(createPairing(ACCOUNT_ID, request, env, { codeSource: () => 'EFGHJKLM' })).rejects.toMatchObject({
      code: 'rate_limited'
    })
  })
})

describe('devices and tickets', () => {
  it('hashes the issued secret, pairs once, and prevents sessions after revocation', async () => {
    await seedAccount()
    const cookie = await sessionCookie()
    const pairing = await exports.default
      .fetch(jsonRequest('/api/pairing', {}, cookie))
      .then((response) => response.json<{ code: string }>())
    const pairResponse = await exports.default.fetch(jsonRequest('/api/devices/pair', { code: pairing.code, label: 'Laptop' }))
    const device = await pairResponse.json<{ deviceId: string; deviceSecret: string; discordName: string }>()
    expect(device.discordName).toBe('Primitive')
    const stored = await env.DB.prepare('SELECT secret_hash FROM device WHERE id = ?')
      .bind(device.deviceId)
      .first<{ secret_hash: string }>()
    expect(stored?.secret_hash).not.toContain(device.deviceSecret)
    expect((await exports.default.fetch(jsonRequest('/api/devices/pair', { code: pairing.code }))).status).toBe(400)
    expect((await exports.default.fetch(jsonRequest('/api/devices/session', device))).status).toBe(200)
    const revoke = await exports.default.fetch(
      new Request(`https://worker.test/api/devices/${device.deviceId}`, {
        method: 'DELETE', headers: { cookie, origin: ACTIVITY_ORIGIN }
      })
    )
    expect(revoke.status).toBe(204)
    expect((await exports.default.fetch(jsonRequest('/api/devices/session', device))).status).toBe(401)
  })

  it('issues role-scoped, expiring, single-use tickets', async () => {
    await seedAccount()
    const cookie = await sessionCookie()
    const device = await seedDevice()
    const publisher = await exports.default
      .fetch(jsonRequest('/api/devices/session', device))
      .then((response) => response.json<{ ticket: string }>())
    const viewer = await exports.default
      .fetch(jsonRequest('/api/viewer/session', {}, cookie))
      .then((response) => response.json<{ ticket: string }>())
    const first = await exports.default.fetch(`https://worker.test/api/sync?ticket=${publisher.ticket}`, { headers: { upgrade: 'websocket' } })
    expect(first.status).toBe(101)
    expect((await exports.default.fetch(`https://worker.test/api/sync?ticket=${publisher.ticket}`, { headers: { upgrade: 'websocket' } })).status).toBe(401)
    const viewerRow = await env.DB.prepare('SELECT role FROM session_ticket WHERE token_hash IS NOT NULL AND consumed_at IS NULL')
      .first<{ role: string }>()
    expect(viewerRow?.role).toBe('viewer')
    await env.DB.prepare('UPDATE session_ticket SET expires_at = 1 WHERE consumed_at IS NULL').run()
    expect((await exports.default.fetch(`https://worker.test/api/sync?ticket=${viewer.ticket}`, { headers: { upgrade: 'websocket' } })).status).toBe(401)
    first.webSocket?.accept()
    first.webSocket?.close()
  })

  it('reports account/device status and enforces revoke ownership', async () => {
    await seedAccount()
    const cookie = await sessionCookie()
    const device = await seedDevice()
    const me = await exports.default.fetch(new Request('https://worker.test/api/me', { headers: { cookie } }))
    expect(await me.json()).toMatchObject({ paired: true, devices: [{ id: device.deviceId, label: 'Test desktop' }] })
    expect(
      (await exports.default.fetch(new Request('https://worker.test/api/devices/not-owned', {
        method: 'DELETE', headers: { cookie, origin: ACTIVITY_ORIGIN }
      }))).status
    ).toBe(404)
  })
})

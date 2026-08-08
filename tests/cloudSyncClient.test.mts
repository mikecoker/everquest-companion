import assert from 'node:assert/strict'
import test from 'node:test'
import { CloudSyncClient, CloudSyncHttpError } from '../src/main/cloudSync/client'
import { cloudSyncEndpoint, resolveCloudSyncConfig } from '../src/main/cloudSync/config'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('config blocks disabled, E2E, invalid endpoints, and missing credentials', () => {
  const credentials = { deviceId: 'device', deviceSecret: 'secret' }
  assert.deepEqual(resolveCloudSyncConfig({ enabled: false }, false), { enabled: false, reason: 'disabled' })
  assert.deepEqual(resolveCloudSyncConfig({ enabled: true, endpoint: 'https://sync.test', credentials }, true), {
    enabled: false,
    reason: 'e2e'
  })
  assert.deepEqual(resolveCloudSyncConfig({ enabled: true, endpoint: 'ftp://sync.test', credentials }, false), {
    enabled: false,
    reason: 'invalid_endpoint'
  })
  assert.deepEqual(resolveCloudSyncConfig({ enabled: true, endpoint: 'http://sync.test', credentials }, false), {
    enabled: false,
    reason: 'invalid_endpoint'
  })
  assert.deepEqual(resolveCloudSyncConfig({ enabled: true, endpoint: 'https://sync.test' }, false), {
    enabled: false,
    reason: 'missing_credentials'
  })
})

test('config permits secure origins and localhost HTTP only', () => {
  assert.equal(cloudSyncEndpoint(' https://sync.test/ '), 'https://sync.test')
  assert.equal(cloudSyncEndpoint('http://localhost:8787/'), 'http://localhost:8787')
  assert.equal(cloudSyncEndpoint('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  assert.equal(cloudSyncEndpoint('https://user:pass@sync.test'), null)
  assert.equal(cloudSyncEndpoint('https://sync.test/base'), null)
  assert.equal(cloudSyncEndpoint('https://sync.test?secret=x'), null)
})

test('pair and session use exact JSON contracts and validate responses', async () => {
  const requests: { url: string; init?: RequestInit }[] = []
  const replies = [
    jsonResponse({ deviceId: 'device-1', deviceSecret: 'private-secret', discordName: 'Player' }),
    jsonResponse({ ticket: 'short-ticket', expiresAt: 12_345 })
  ]
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    return replies.shift() ?? jsonResponse({}, 500)
  }) as typeof fetch
  const client = new CloudSyncClient('https://sync.test', fetcher)

  assert.deepEqual(await client.pair('ABC-123', 'Gaming PC'), {
    deviceId: 'device-1',
    deviceSecret: 'private-secret',
    discordName: 'Player'
  })
  assert.deepEqual(await client.createSession({ deviceId: 'device-1', deviceSecret: 'private-secret' }), {
    ticket: 'short-ticket',
    expiresAt: 12_345
  })
  assert.equal(requests[0]?.url, 'https://sync.test/api/devices/pair')
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { code: 'ABC-123', label: 'Gaming PC' })
  assert.equal(requests[1]?.url, 'https://sync.test/api/devices/session')
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    deviceId: 'device-1',
    deviceSecret: 'private-secret'
  })
})

test('socket URL contains only the short-lived ticket', () => {
  const client = new CloudSyncClient('https://sync.test')
  const url = new URL(client.socketUrl('ticket-value'))
  assert.equal(url.href, 'wss://sync.test/api/sync?ticket=ticket-value')
  assert.deepEqual([...url.searchParams.keys()], ['ticket'])
  assert.equal(url.href.includes('device'), false)
  assert.equal(url.href.includes('secret'), false)
})

test('invalid success and oversized error bodies become bounded errors', async () => {
  const badClient = new CloudSyncClient('https://sync.test', (async () => jsonResponse({ ticket: '', expiresAt: -1 })) as typeof fetch)
  await assert.rejects(() => badClient.createSession({ deviceId: 'd', deviceSecret: 's' }), (error: unknown) => {
    assert.ok(error instanceof CloudSyncHttpError)
    assert.equal(error.code, 'invalid_response')
    return true
  })

  const long = 'x'.repeat(20_000)
  const errorClient = new CloudSyncClient(
    'https://sync.test',
    (async () => jsonResponse({ error: { code: long, message: long } }, 401)) as typeof fetch
  )
  await assert.rejects(() => errorClient.createSession({ deviceId: 'd', deviceSecret: 's' }), (error: unknown) => {
    assert.ok(error instanceof CloudSyncHttpError)
    assert.equal(error.status, 401)
    assert.equal(error.code, 'request_failed')
    assert.ok(error.message.length <= 256)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
})

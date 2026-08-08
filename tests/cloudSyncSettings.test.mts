import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { CloudSyncSettingsControl } from '../src/main/cloudSync/settingsControl'
import type { StoredCloudSyncPrefs } from '../src/main/cloudSync/settingsControl'
import type { CloudSyncSecretCodec } from '../src/main/cloudSync/secretStorage'
import { decodeCloudSyncSecret, encodeCloudSyncSecret } from '../src/main/cloudSync/secretStorage'
import { pairCloudSyncDevice } from '../src/main/ipc/cloudSyncActions'
import { sanitizeCloudSyncStatus } from '../src/shared/cloudSyncPrefs'

function codec(available = true, failDecrypt = false): CloudSyncSecretCodec {
  return {
    available: () => available,
    encrypt: (value) => Buffer.from(`protected:${value}`),
    decrypt: (value) => {
      if (failDecrypt) throw new Error('key changed')
      return Buffer.from(value).toString().replace(/^protected:/u, '')
    }
  }
}

function harness(initial: StoredCloudSyncPrefs = { enabled: false, endpoint: '' }, e2e = false) {
  let persisted = initial
  const statuses: unknown[] = []
  const control = new CloudSyncSettingsControl({
    read: () => persisted,
    write: (next) => { persisted = next },
    codec: codec(),
    e2e,
    pushStatus: (status) => statuses.push(status)
  })
  return { control, statuses, persisted: () => persisted }
}

test('cloud settings default closed and enabling requires endpoint plus credentials', () => {
  const { control } = harness()
  assert.deepEqual(control.view(), { enabled: false, endpoint: '', paired: false, secretProtected: true })
  assert.equal(control.setEnabled(true).ok, false)
  assert.equal(control.view().enabled, false)
})

test('safeStorage round trips, decrypt failure closes pairing, and plaintext fallback is disclosed', () => {
  const protectedValue = encodeCloudSyncSecret('s3cret', codec())
  assert.equal(protectedValue.kind, 'safeStorage')
  assert.deepEqual(decodeCloudSyncSecret(protectedValue, codec()), { value: 's3cret', protected: true })
  assert.equal(decodeCloudSyncSecret(protectedValue, codec(true, true)), null)
  const plaintext = encodeCloudSyncSecret('fallback', codec(false))
  assert.deepEqual(plaintext, { kind: 'plaintext', value: 'fallback' })
  assert.deepEqual(decodeCloudSyncSecret(plaintext, codec(false)), { value: 'fallback', protected: false })
  const brokenAvailability: CloudSyncSecretCodec = {
    available: () => { throw new Error('keychain unavailable') },
    encrypt: () => { throw new Error('must not run') },
    decrypt: () => { throw new Error('must not run') }
  }
  assert.deepEqual(encodeCloudSyncSecret('fallback', brokenAvailability), { kind: 'plaintext', value: 'fallback' })
  assert.equal(decodeCloudSyncSecret(protectedValue, brokenAvailability), null)
})

test('pair persists credentials without returning a secret and endpoint origin change forgets them', () => {
  const { control, persisted } = harness({ enabled: false, endpoint: 'https://one.example' })
  const paired = control.savePair({ deviceId: 'device', deviceSecret: 'top-secret', discordName: 'Player' })
  assert.equal(paired.prefs.paired, true)
  assert.equal(JSON.stringify(paired).includes('top-secret'), false)
  assert.equal(JSON.stringify(control.view()).includes('device'), false)
  assert.equal(persisted().deviceSecret?.kind, 'safeStorage')
  const changed = control.setEndpoint('https://two.example')
  assert.equal(changed.credentialsCleared, true)
  assert.equal(changed.prefs.paired, false)
  assert.equal(persisted().deviceSecret, undefined)
})

test('enable works only outside e2e and forget notifies runtime synchronously', () => {
  const initial: StoredCloudSyncPrefs = {
    enabled: false,
    endpoint: 'https://sync.example',
    deviceId: 'device',
    deviceSecret: encodeCloudSyncSecret('secret', codec())
  }
  const normal = harness(initial)
  assert.equal(normal.control.setEnabled(true).ok, true)
  assert.equal(normal.control.setEndpoint('https://sync.example/').prefs.enabled, true)
  let observed = false
  normal.control.subscribe((settings) => { observed = !settings.enabled && settings.credentials === undefined })
  normal.control.forget()
  assert.equal(observed, true)
  assert.equal(harness(initial, true).control.setEnabled(true).ok, false)
})

test('e2e pairing refuses before a network call', async () => {
  const { control } = harness({ enabled: false, endpoint: 'https://sync.example' }, true)
  let calls = 0
  const result = await pairCloudSyncDevice(control, {
    e2e: true,
    pair: async () => { calls += 1; throw new Error('must not run') }
  }, '123456', 'desktop')
  assert.equal(result.ok, false)
  assert.equal(calls, 0)
})

test('renderer status is bounded and copies no extra fields', () => {
  const status = sanitizeCloudSyncStatus({ state: 'error', message: 'x'.repeat(1_000), secret: 'nope' })
  assert.equal(status.state, 'error')
  assert.equal(JSON.stringify(status).includes('nope'), false)
  if (status.state === 'error') assert.ok(status.message.length < 1_000)
})

test('Preferences descriptor states the allowlist and exclusions without secret vocabulary', async () => {
  const source = await readFile(new URL('../src/renderer/src/features/preferences/CloudSyncSettings.tsx', import.meta.url), 'utf8')
  assert.match(source, /character, server/)
  assert.match(source, /raw log lines, chat, tells, local paths/)
  assert.match(source, /data-testid="cloud-sync-settings"/)
  assert.doesNotMatch(source, /deviceSecret/)
  const preload = await readFile(new URL('../src/preload/cloudSync.ts', import.meta.url), 'utf8')
  assert.match(preload, /removeListener/)
  assert.doesNotMatch(preload, /deviceSecret/)
})

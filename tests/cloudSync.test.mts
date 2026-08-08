import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLOUD_SYNC_LIMITS,
  CLOUD_SYNC_PROTOCOL_VERSION,
  parseCloudSyncState,
  parseDesktopCloudSyncJson,
  parseDesktopCloudSyncMessage,
  parseServerCloudSyncJson,
  parseServerCloudSyncMessage,
  type CloudSyncState
} from '../src/shared/cloudSync'

function validState(): CloudSyncState {
  return {
    publishedAt: 1_800_000_000_000,
    character: {
      id: 'primitive@freeport',
      name: 'Primitive',
      server: 'freeport',
      level: 42,
      classes: ['Monk', 'Shaman'],
      zone: 'The Overthere'
    },
    combat: {
      inCombat: true,
      target: 'A fierce creature',
      startedAt: 1_799_999_995_000,
      totalDamage: 442,
      dps: 110.5,
      rows: [
        { name: 'Primitive', total: 400, dps: 100, kind: 'self' },
        { name: 'Fluffy', total: 42, dps: 10.5, kind: 'pet' }
      ]
    },
    progression: { level: 42, percent: 73.5, xpPerHour: 4.2, etaMs: 22_714_000 },
    recent: {
      kills: [{ name: 'A fierce creature', ts: 1_799_999_999_000 }],
      loot: [{ item: 'Shiny Thing', ts: 1_800_000_000_000, quantity: 2 }]
    }
  }
}

test('desktop publish JSON round-trips a complete allowlisted state', () => {
  const message = {
    version: CLOUD_SYNC_PROTOCOL_VERSION,
    type: 'publish',
    state: validState()
  }
  assert.deepEqual(parseDesktopCloudSyncJson(JSON.stringify(message)), { ok: true, value: message })
})

test('optional state fields may be absent', () => {
  const state = validState()
  delete state.character.level
  delete state.character.zone
  delete state.combat.target
  delete state.combat.startedAt
  delete state.progression
  state.recent.loot[0] = { item: 'Shiny Thing', ts: 123 }
  assert.deepEqual(parseCloudSyncState(state), { ok: true, value: state })
})

test('malformed JSON and non-object messages fail without throwing', () => {
  const invalidJson = { ok: false, error: { code: 'invalid_json', message: 'Cloud sync message is not valid JSON' } }
  assert.deepEqual(parseDesktopCloudSyncJson('{'), invalidJson)
  assert.deepEqual(parseServerCloudSyncJson('{'), invalidJson)
  assert.equal(parseDesktopCloudSyncMessage(null).ok, false)
  assert.equal(parseDesktopCloudSyncMessage([]).ok, false)
})

test('oversized strings are rejected', () => {
  const state = validState()
  state.character.name = 'x'.repeat(CLOUD_SYNC_LIMITS.maxNameChars + 1)
  assert.equal(parseCloudSyncState(state).ok, false)
})

test('every bounded list rejects overflow instead of clamping', () => {
  const cases: [string, number, (state: CloudSyncState, values: unknown[]) => void, unknown][] = [
    ['classes', CLOUD_SYNC_LIMITS.maxClasses, (state, values) => { state.character.classes = values as string[] }, 'class'],
    [
      'combat rows',
      CLOUD_SYNC_LIMITS.maxCombatRows,
      (state, values) => { state.combat.rows = values as CloudSyncState['combat']['rows'] },
      { name: 'x', total: 1, dps: 1, kind: 'other' }
    ],
    [
      'recent kills',
      CLOUD_SYNC_LIMITS.maxRecentKills,
      (state, values) => { state.recent.kills = values as CloudSyncState['recent']['kills'] },
      { name: 'x', ts: 1 }
    ],
    [
      'recent loot',
      CLOUD_SYNC_LIMITS.maxRecentLoot,
      (state, values) => { state.recent.loot = values as CloudSyncState['recent']['loot'] },
      { item: 'x', ts: 1 }
    ]
  ]
  for (const [label, limit, assign, item] of cases) {
    const state = validState()
    assign(state, Array.from({ length: limit + 1 }, () => item))
    assert.equal(parseCloudSyncState(state).ok, false, label)
  }
})

test('both JSON boundaries reject payloads over the character limit', () => {
  const oversized = ' '.repeat(CLOUD_SYNC_LIMITS.maxJsonChars + 1)
  assert.deepEqual(parseDesktopCloudSyncJson(oversized), {
    ok: false,
    error: { code: 'too_large', message: 'Cloud sync message is too large' }
  })
  assert.deepEqual(parseServerCloudSyncJson(oversized), {
    ok: false,
    error: { code: 'too_large', message: 'Cloud sync message is too large' }
  })
})

test('nonfinite, negative, and out-of-range numbers are rejected', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const state = validState()
    state.combat.dps = bad
    assert.equal(parseCloudSyncState(state).ok, false)
  }

  const percent = validState()
  if (percent.progression) percent.progression.percent = 101
  assert.equal(parseCloudSyncState(percent).ok, false)

  const quantity = validState()
  quantity.recent.loot[0].quantity = 0
  assert.equal(parseCloudSyncState(quantity).ok, false)
})

test('fractional values are rejected in integer-only state fields', () => {
  const mutations: [string, (state: CloudSyncState) => void][] = [
    ['publishedAt', (state) => { state.publishedAt = 1.5 }],
    ['character level', (state) => { state.character.level = 42.5 }],
    ['combat startedAt', (state) => { state.combat.startedAt = 1.5 }],
    ['progression level', (state) => { if (state.progression) state.progression.level = 42.5 }],
    ['progression etaMs', (state) => { if (state.progression) state.progression.etaMs = 1.5 }],
    ['kill timestamp', (state) => { state.recent.kills[0].ts = 1.5 }],
    ['loot timestamp', (state) => { state.recent.loot[0].ts = 1.5 }],
    ['loot quantity', (state) => { state.recent.loot[0].quantity = 1.5 }]
  ]
  for (const [label, mutate] of mutations) {
    const state = validState()
    mutate(state)
    assert.equal(parseCloudSyncState(state).ok, false, label)
  }
})

test('fractional values are rejected in integer-only envelope fields', () => {
  const messages = [
    { parser: parseDesktopCloudSyncMessage, value: { version: 1, type: 'ping', sentAt: 1.5 } },
    { parser: parseServerCloudSyncMessage, value: { version: 1, type: 'ready', sessionId: 's', serverTime: 1.5 } },
    { parser: parseServerCloudSyncMessage, value: { version: 1, type: 'state', revision: 1.5, state: validState() } },
    { parser: parseServerCloudSyncMessage, value: { version: 1, type: 'presence', online: false, lastSeenAt: 1.5 } },
    { parser: parseServerCloudSyncMessage, value: { version: 1, type: 'error', code: 'rate_limited', message: 'wait', retryAfterMs: 1.5 } }
  ]
  for (const { parser, value } of messages) assert.equal(parser(value).ok, false)
})

test('unknown protocol versions, message types, and enum values are rejected', () => {
  assert.deepEqual(parseDesktopCloudSyncMessage({ version: 2, type: 'ping', sentAt: 1 }), {
    ok: false,
    error: { code: 'unsupported_version', message: 'Unsupported cloud sync protocol version' }
  })
  assert.deepEqual(parseDesktopCloudSyncMessage({ version: 1, type: 'raw-log', lines: [] }), {
    ok: false,
    error: { code: 'unknown_type', message: 'Unknown desktop cloud sync message type' }
  })
  assert.deepEqual(parseServerCloudSyncMessage({ version: 2, type: 'presence', online: true }), {
    ok: false,
    error: { code: 'unsupported_version', message: 'Unsupported cloud sync protocol version' }
  })
  assert.deepEqual(parseServerCloudSyncMessage({ version: 1, type: 'raw-log', lines: [] }), {
    ok: false,
    error: { code: 'unknown_type', message: 'Unknown server cloud sync message type' }
  })

  const state = validState() as unknown as Record<string, unknown>
  const combat = state.combat as Record<string, unknown>
  const rows = combat.rows as Record<string, unknown>[]
  rows[0].kind = 'guild'
  assert.equal(parseCloudSyncState(state).ok, false)
})

test('server messages validate every variant', () => {
  const messages = [
    { version: 1, type: 'ready', sessionId: 'session-1', serverTime: 123 },
    { version: 1, type: 'state', revision: 2, state: validState() },
    { version: 1, type: 'presence', online: false, lastSeenAt: 122 },
    { version: 1, type: 'error', code: 'rate_limited', message: 'Slow down', retryAfterMs: 500 }
  ]
  for (const message of messages) assert.equal(parseServerCloudSyncMessage(message).ok, true)
  assert.equal(
    parseServerCloudSyncMessage({ version: 1, type: 'error', code: 'surprise', message: 'no' }).ok,
    false
  )
})

test('extra and prototype-shaped fields never leak into parsed output', () => {
  const input = `{"version":1,"type":"publish","revision":99,"rawLog":"secret","__proto__":{"polluted":true},"state":${JSON.stringify({
    ...validState(),
    chat: 'secret',
    character: { ...validState().character, arbitraryMetadata: { private: true } }
  })}}`
  const parsed = parseDesktopCloudSyncJson(input)
  assert.equal(parsed.ok, true)
  if (!parsed.ok || parsed.value.type !== 'publish') return
  const output = parsed.value as unknown as Record<string, unknown>
  const state = parsed.value.state as unknown as Record<string, unknown>
  const character = parsed.value.state.character as unknown as Record<string, unknown>
  assert.equal('rawLog' in output, false)
  assert.equal('revision' in output, false)
  assert.equal(Object.hasOwn(output, '__proto__'), false)
  assert.equal('chat' in state, false)
  assert.equal('arbitraryMetadata' in character, false)
  assert.equal('polluted' in output, false)
})

test('server JSON parsing returns a fresh allowlisted copy', () => {
  const input = `{"version":1,"type":"state","revision":4,"rawLog":"secret","__proto__":{"polluted":true},"state":${JSON.stringify({
    ...validState(),
    rawLines: ['private'],
    recent: { ...validState().recent, chat: 'secret' }
  })}}`
  const parsed = parseServerCloudSyncJson(input)
  assert.equal(parsed.ok, true)
  if (!parsed.ok || parsed.value.type !== 'state') return
  const output = parsed.value as unknown as Record<string, unknown>
  const state = parsed.value.state as unknown as Record<string, unknown>
  const recent = parsed.value.state.recent as unknown as Record<string, unknown>
  assert.deepEqual(Object.keys(output).sort(), ['revision', 'state', 'type', 'version'])
  assert.equal('rawLog' in output, false)
  assert.equal(Object.hasOwn(output, '__proto__'), false)
  assert.equal('rawLines' in state, false)
  assert.equal('chat' in recent, false)
  assert.equal(Object.getPrototypeOf(parsed.value), Object.prototype)
  assert.equal(Object.getPrototypeOf(parsed.value.state), Object.prototype)
})

test('hostile getters are converted to a parse error', () => {
  const input = Object.defineProperty({}, 'version', {
    get() {
      throw new Error('boom')
    }
  })
  assert.doesNotThrow(() => parseDesktopCloudSyncMessage(input))
  assert.equal(parseDesktopCloudSyncMessage(input).ok, false)
})

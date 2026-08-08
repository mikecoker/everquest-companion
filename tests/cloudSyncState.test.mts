import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCloudSyncState, type CloudSyncStateInputs } from '../src/main/cloudSync/state'
import { parseCloudSyncState } from '../src/shared/cloudSync'
import type { ComboSnap } from '../src/shared/classCombo'
import type { CombatSnapshot, SegmentSummary, SegmentView, SourceKind, SourceView } from '../src/shared/combat'
import type { ProgressionSnap } from '../src/shared/progressionTypes'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.parse('2026-08-01T12:00:00Z')

function progression(): ProgressionSnap {
  const expTs = Array.from({ length: 10 }, (_, i) => T0 + (i + 1) * 5 * MIN)
  return {
    expTs,
    expPct: expTs.map(() => 5),
    expFlag: expTs.map(() => 0),
    killTs: [],
    killZone: [],
    killCredit: [],
    witnessTs: [],
    recentKills: [],
    lootTs: [],
    zoneStart: [T0],
    zoneEnd: [0],
    zoneName: ['The Warrens'],
    offlineStart: [],
    offlineEnd: [],
    offlineCamped: [],
    levelTs: [T0],
    levelValue: [40],
    aaGainTs: [],
    aaGainAmount: [],
    lastTs: T0 + HOUR,
    windowStart: 0,
    dropped: 0
  }
}

function combo(): ComboSnap {
  return {
    ready: true,
    intervals: [],
    current: {
      id: 'ci1',
      startTs: T0,
      endTs: null,
      startLo: T0,
      startHi: T0,
      endLo: null,
      endHi: null,
      startReason: 'who',
      expectedSlots: 3,
      slots: [
        { candidates: ['MNK'], confidence: 1, provenance: 'who', because: [] },
        { candidates: ['SHM'], confidence: 1, provenance: 'who', because: [] },
        { candidates: ['WAR', 'PAL'], confidence: 0.5, provenance: 'inferred', because: [] }
      ],
      levelLo: 40,
      levelHi: 40,
      evidenceCount: 1,
      userLocked: false
    }
  }
}

function source(name: string, kind: SourceKind, total: number): SourceView {
  return { name, kind, total, dps: total / 10, rawLine: 'must not leave' } as unknown as SourceView
}

function combat(rows: SourceView[] = []): CombatSnapshot {
  return {
    selected: {
      name: 'a fierce rat',
      outTotal: 420,
      outDps: 42,
      entities: rows,
      timeline: { secret: true },
      procs: [{ spell: 'secret' }]
    } as unknown as SegmentView,
    segments: [{ kind: 'current', startTs: T0 + 12 * MIN } as SegmentSummary],
    currentTarget: { name: 'a fierce rat', others: 0, lastTs: T0 + HOUR },
    inCombat: true,
    zone: 'Combat fallback zone',
    recent: [{ raw: 'private raw line' }],
    logPath: 'C:\\private\\eqlog.log'
  } as unknown as CombatSnapshot
}

function inputs(): CloudSyncStateInputs {
  return {
    characterId: 'primitive@freeport',
    character: {
      character: {
        name: 'Primitive',
        server: 'freeport',
        logPath: 'C:\\private\\eqlog_Primitive_freeport.txt',
        lastPlayed: T0
      },
      zone: 'The Warrens'
    },
    combo: combo(),
    combat: combat([
      source('Primitive', 'you', 200),
      source('Fluffy', 'pet', 100),
      source('Friend', 'member', 80),
      source('Stranger', 'enemy', 40)
    ]),
    progression: progression(),
    loot: [
      { item: 'Bone Chips', ts: T0 + 45 * MIN, count: 2, source: 'a rat', zone: 'The Warrens' },
      { item: 'Rusty Sword', ts: T0 + 46 * MIN, created: 'private transformation' }
    ]
  }
}

test('returns null without a usable active character identity', () => {
  const absent = inputs()
  absent.character.character = null
  assert.equal(buildCloudSyncState(absent, T0 + HOUR), null)

  const emptyId = inputs()
  emptyId.characterId = ''
  assert.equal(buildCloudSyncState(emptyId, T0 + HOUR), null)
})

test('builds the exact public state from authoritative snapshots', () => {
  const result = buildCloudSyncState(inputs(), T0 + HOUR)
  assert.deepEqual(result, {
    publishedAt: T0 + HOUR,
    character: {
      id: 'primitive@freeport',
      name: 'Primitive',
      server: 'freeport',
      level: 40,
      classes: ['Monk', 'Shaman'],
      zone: 'The Warrens'
    },
    combat: {
      inCombat: true,
      target: 'a fierce rat',
      startedAt: T0 + 12 * MIN,
      totalDamage: 420,
      dps: 42,
      rows: [
        { name: 'Primitive', total: 200, dps: 20, kind: 'self' },
        { name: 'Fluffy', total: 100, dps: 10, kind: 'pet' },
        { name: 'Friend', total: 80, dps: 8, kind: 'party' },
        { name: 'Stranger', total: 40, dps: 4, kind: 'other' }
      ]
    },
    progression: { level: 40, percent: 50, xpPerHour: 50, etaMs: HOUR },
    recent: {
      kills: [],
      loot: [
        { item: 'Bone Chips', ts: T0 + 45 * MIN, quantity: 2 },
        { item: 'Rusty Sword', ts: T0 + 46 * MIN }
      ]
    }
  })
  assert.equal(parseCloudSyncState(result).ok, true)
})

test('caps feeds and combat rows before the rejecting wire boundary', () => {
  const value = inputs()
  value.combat = combat(Array.from({ length: 25 }, (_, i) => source(`row-${i}`, 'you', i)))
  value.progression.recentKills = Array.from({ length: 12 }, (_, i) => ({
    name: `kill-${i}`,
    ts: T0 + i,
    credit: 0,
    zone: 'The Warrens'
  }))
  value.loot = Array.from({ length: 12 }, (_, i) => ({ item: `loot-${i}`, ts: T0 + i }))

  const result = buildCloudSyncState(value, T0 + HOUR)
  assert.ok(result)
  assert.equal(result.combat.rows.length, 20)
  assert.equal(result.recent.kills.length, 10)
  assert.equal(result.recent.kills[0].name, 'kill-2')
  assert.equal(result.recent.loot.length, 10)
  assert.equal(result.recent.loot[0].item, 'loot-2')
})

test('drops invalid peripheral facts without suppressing the valid state', () => {
  const value = inputs()
  value.combat = combat([
    source('x'.repeat(97), 'enemy', 10),
    source('Valid row', 'you', 20)
  ])
  value.combat.currentTarget = { name: 'x'.repeat(97), others: 0, lastTs: T0 }
  value.progression.recentKills = [
    { name: 'x'.repeat(97), ts: T0, credit: 0, zone: 'The Warrens' },
    { name: 'Valid kill', ts: T0 + 1, credit: 0, zone: 'The Warrens' }
  ]
  value.loot = [
    { item: 'Invalid quantity', ts: T0, count: 0 },
    { item: 'x'.repeat(161), ts: T0 + 1 },
    { item: 'Valid loot', ts: T0 + 2 }
  ]

  const result = buildCloudSyncState(value, T0 + HOUR)
  assert.ok(result)
  assert.equal(result.combat.target, undefined)
  assert.deepEqual(result.combat.rows.map((row) => row.name), ['Valid row'])
  assert.deepEqual(result.recent.kills, [{ name: 'Valid kill', ts: T0 + 1 }])
  assert.deepEqual(result.recent.loot, [{ item: 'Valid loot', ts: T0 + 2 }])
})

test('publishes only uniquely resolved classes and requires combo data readiness', () => {
  const value = inputs()
  assert.deepEqual(buildCloudSyncState(value, T0 + HOUR)?.character.classes, ['Monk', 'Shaman'])
  value.combo.ready = false
  assert.deepEqual(buildCloudSyncState(value, T0 + HOUR)?.character.classes, [])
})

test('omits percent and ETA whenever projection evidence is incomplete', () => {
  const cases: [string, (snap: ProgressionSnap) => void][] = [
    ['no ding', (snap) => { snap.levelTs = [] }],
    ['clipped', (snap) => { snap.windowStart = T0 + 1 }],
    ['unstated', (snap) => { snap.expFlag[9] = 1; snap.expPct[9] = -1 }],
    ['overfull', (snap) => { snap.expPct = snap.expPct.map(() => 11) }],
    ['mostly offline', (snap) => {
      snap.offlineStart = [T0]
      snap.offlineEnd = [T0 + 50 * MIN]
      snap.offlineCamped = [1]
      snap.expTs = [T0 + 55 * MIN, T0 + 58 * MIN]
      snap.expPct = [10, 10]
      snap.expFlag = [0, 0]
    }],
    ['no pace', (snap) => {
      snap.expTs = []
      snap.expPct = []
      snap.expFlag = []
      snap.killTs = [T0 + 10 * MIN, T0 + 20 * MIN, T0 + 30 * MIN, T0 + 40 * MIN, T0 + 50 * MIN]
      snap.killZone = [0, 0, 0, 0, 0]
      snap.killCredit = [0, 0, 0, 0, 0]
    }]
  ]

  for (const [label, mutate] of cases) {
    const value = inputs()
    mutate(value.progression)
    const projected = buildCloudSyncState(value, T0 + HOUR)?.progression
    assert.ok(projected, label)
    assert.equal(projected.percent, undefined, label)
    assert.equal(projected.etaMs, undefined, label)
  }
})

test('returns a fresh allowlisted object with no local or prototype-shaped leakage', () => {
  const value = inputs()
  const character = value.character.character
  assert.ok(character)
  Object.assign(character, { rawLine: 'tell secret', arbitrary: { nested: true }, __proto__: { polluted: true } })
  Object.assign(value.progression, { spellMessages: ['secret'], arbitrary: true })
  const result = buildCloudSyncState(value, T0 + HOUR)
  assert.ok(result)

  const serialized = JSON.stringify(result)
  for (const forbidden of ['private', 'secret', 'rawLine', 'spellMessages', 'logPath', 'procs', 'timeline', 'source']) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.equal(Object.getPrototypeOf(result.character), Object.prototype)
  assert.equal(Object.getPrototypeOf(result.combat.rows[0]), Object.prototype)
  assert.equal(Object.hasOwn(result, '__proto__'), false)
})

test('fails closed when the projected state violates the shared contract', () => {
  const value = inputs()
  const character = value.character.character
  assert.ok(character)
  character.name = 'x'.repeat(97)
  assert.equal(buildCloudSyncState(value, T0 + HOUR), null)
  assert.equal(buildCloudSyncState(inputs(), Number.NaN), null)
})

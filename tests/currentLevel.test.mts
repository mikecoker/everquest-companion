// WHAT LEVEL AM I — the golden window for JOS-192's level half.
//
// EQ Legends gives ONE level to a three-class loadout, that level is the MINIMUM of the classes'
// levels, and a loadout swap is never logged. So the ding series states your level only at the
// instant it CHANGES, and the instant it changes most is the one instant it says nothing about:
// swap a level-10 class into a level-11 loadout and the log's last word stays "11".
//
// The character's own `/who` row is the second statement, and the only one a player can produce on
// demand: `[10 PAL/ROG/ENC] Primitive (Froglok)  ZONE: The Ocean of Tears (oot)`.
//
// THE FIXTURE IS THE ONE THAT ALREADY CONTAINS THE CASE. `cw1-who-anchored.log` (Jul 28 14:00–20:45
// of the owner's log, cut through the shared scrub for the class-combo windows) holds, in order:
//   15:51:40  ding, level 11
//   16:46:22  ding, level 11   ← the REPEAT ding that dates the swap (comboIntervals' levelDrop)
//   17:25:15  /who, level 10   ← the game stating a level BELOW the last ding
//   …
//   20:33:52  ding, level 18
//   20:42:43  /who, level 18
// So the whole precedence question is answered against real bytes rather than a hand-authored
// shape: at 17:25:15 the honest answer is 10 and the ding tail says 11.
//
// AND THE DING SERIES IS ASSERTED UNCHANGED, in the same replay, because the rule that keeps it
// dings-only is the one a future edit is most likely to "simplify".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEqTimestamp, parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CharacterModule } from '../src/main/modules/character'
import { LevelingModule } from '../src/main/modules/leveling'
import {
  LEVEL_STALE_MS,
  currentLevelRead,
  dingStatement,
  laterStatement,
  type LevelStatement
} from '../src/shared/currentLevel'
import type { CharacterSnap, ProgressionSnap } from '../src/shared/types'
import type { LogEvent } from '../src/shared/logEvents'
import { readFixture } from './harness.mts'

/** The tailed character — the `/who` rule keys the self row on THIS name and nothing else. */
const SELF = 'Primitive'

const at = (stamp: string): number => parseEqTimestamp(stamp)

/** Replay real lines (optionally up to an instant) through the real parser into both modules. */
function replay(upTo?: number): {
  character: CharacterSnap
  levels: { ts: number; level: number }[]
  revs: number[]
} {
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const character = new CharacterModule()
  const leveling = new LevelingModule()
  character.reset()
  leveling.reset()
  const revs: number[] = []
  let seq = 0
  for (const raw of readFixture('cw1-who-anchored.log')) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    if (upTo !== undefined && ev.ts > upTo) break
    character.onEvent(ev)
    leveling.onEvent(ev)
    const flushed = character.flushDelta()
    if (flushed) revs.push(flushed.seq)
  }
  return { character: character.snapshot().state, levels: leveling.snapshot().state.levels, revs }
}

/** A progression snapshot carrying only what the level read needs: the ding columns and the clock. */
function progression(levels: { ts: number; level: number }[], lastTs: number): ProgressionSnap {
  return {
    expTs: [], expPct: [], expFlag: [],
    killTs: [], killZone: [], killCredit: [], witnessTs: [], recentKills: [],
    lootTs: [], zoneStart: [], zoneEnd: [], zoneName: [],
    offlineStart: [], offlineEnd: [], offlineCamped: [],
    levelTs: levels.map((l) => l.ts),
    levelValue: levels.map((l) => l.level),
    aaGainTs: [], aaGainAmount: [],
    lastTs,
    windowStart: 0,
    dropped: 0
  }
}

// ---------------------------------------------------------------------------
// The fold: two statements, one fact.
// ---------------------------------------------------------------------------

test('a /who row states a level BELOW the last ding, and it wins', () => {
  // The swap, exactly as the log recorded it. The 16:46:22 ding says 11; 39 minutes later the
  // game itself prints `[10 …]`. Anything reading the ding tail here answers 11 and is wrong.
  const row = at('Tue Jul 28 17:25:15 2026')
  const { character, levels } = replay(row)
  assert.deepEqual(character.level, { level: 10, ts: row, source: 'who' })
  assert.equal(levels[levels.length - 1].level, 11, 'the DING series still says 11 — it must')
  assert.equal(dingStatement(progression(levels, row))?.level, 11, 'and the ding read agrees')
})

test('a later ding then wins back', () => {
  // The other direction, so the rule is not "who always beats ding". After the row at 17:25:15
  // the next ding (17:38:04, level 12) is a newer statement and takes over.
  const { character } = replay(at('Tue Jul 28 17:38:04 2026'))
  assert.deepEqual(character.level, { level: 12, ts: at('Tue Jul 28 17:38:04 2026'), source: 'ding' })
})

test('the whole window ends on the last statement the log made', () => {
  const { character, levels } = replay()
  assert.deepEqual(character.level, { level: 18, ts: at('Tue Jul 28 20:42:43 2026'), source: 'who' })
  // Same NUMBER as the 20:33:52 ding — and a different fact, because it is nine minutes newer.
  assert.equal(levels[levels.length - 1].level, 18)
  assert.equal(levels[levels.length - 1].ts, at('Tue Jul 28 20:33:52 2026'))
})

test('THE DING SERIES STAYS DINGS-ONLY — the /who rows never enter it', () => {
  // The rule the level chart, the per-level history and the next-level projection all rest on.
  // Seven `/who` rows in this window; if any of them reached the series it would appear as a
  // level-up that never happened (and, at 17:25:15, as a 39-minute "time to level" across a swap).
  const { levels } = replay()
  const dings = readFixture('cw1-who-anchored.log').filter((l) => l.includes('Welcome to level'))
  assert.equal(levels.length, dings.length, 'one entry per Welcome line, and nothing else')
  assert.deepEqual(
    levels.map((l) => l.level),
    [7, 8, 9, 10, 11, 11, 12, 13, 14, 15, 16, 17, 18],
    'including the 11 → 11 repeat, which is a swap and not a level-up'
  )
})

// ---------------------------------------------------------------------------
// Precedence, stated as its own rule.
// ---------------------------------------------------------------------------

test('latest timestamp wins, and a tie goes to /who', () => {
  const ding: LevelStatement = { level: 50, ts: 1000, source: 'ding' }
  const who: LevelStatement = { level: 11, ts: 1000, source: 'who' }
  assert.deepEqual(laterStatement(ding, who), who, 'same second: the row RE-states, so it is later')
  assert.deepEqual(laterStatement(who, ding), who, 'and the order it arrived in cannot change that')
  assert.deepEqual(laterStatement(who, { ...ding, ts: 2000 }), { ...ding, ts: 2000 }, 'a newer ding wins')
  assert.deepEqual(laterStatement(who, { ...ding, ts: 500 }), who, 'an older one never does')
})

test('an out-of-order statement neither wins nor pushes a delta', () => {
  installCharacterName(SELF)
  const mod = new CharacterModule()
  mod.reset()
  const ev = (kind: 'level' | 'selfWho', ts: number, level: number): LogEvent =>
    kind === 'level'
      ? { kind: 'level', seq: ts, ts, raw: '', level }
      : { kind: 'selfWho', seq: ts, ts, raw: '', level, classes: ['PAL'] }

  mod.onEvent(ev('level', 2000, 50))
  assert.ok(mod.flushDelta(), 'the first statement is news')
  mod.onEvent(ev('selfWho', 1000, 11))
  assert.equal(mod.flushDelta(), null, 'an OLDER row changes nothing, so nothing is pushed')
  assert.deepEqual(mod.snapshot().state.level, { level: 50, ts: 2000, source: 'ding' })
})

test('a row restating the same level DOES push — the age is part of the fact', () => {
  installCharacterName(SELF)
  const mod = new CharacterModule()
  mod.reset()
  mod.onEvent({ kind: 'level', seq: 1, ts: 1000, raw: '', level: 50 })
  mod.flushDelta()
  mod.onEvent({ kind: 'selfWho', seq: 2, ts: 9000, raw: '', level: 50, classes: ['PAL'] })
  const d = mod.flushDelta()
  assert.deepEqual(d?.delta.level, { level: 50, ts: 9000, source: 'who' })
})

test('the seq is the module’s OWN revision, and it never goes backwards', () => {
  // The JOS-87 rule, second application (see the module header). `useModule` dedupes on this and
  // a correction-shaped input — here `setCharacter`, and the level fact on an otherwise idle log —
  // advances no LogEvent seq at all.
  const { revs } = replay()
  assert.ok(revs.length > 0, 'the window pushes deltas at all')
  for (let i = 1; i < revs.length; i++) {
    assert.ok(revs[i] > revs[i - 1], `revision ${String(i)} must be strictly increasing`)
  }

  const mod = new CharacterModule()
  mod.reset()
  const before = mod.snapshot().seq
  mod.setCharacter({ name: 'Primitive', server: 'freeport', logPath: 'x' })
  const pushed = mod.flushDelta()
  assert.ok(pushed && pushed.seq > before, 'a character set with NO log event still advances it')
  // …and a reset (a character switch) does not restart the counter, or a live window would drop
  // every delta after it as a duplicate.
  const beforeReset = mod.snapshot().seq
  mod.reset()
  assert.ok(mod.snapshot().seq > beforeReset)
})

test('an epoch clears the level — the wiped character’s level is not this one’s', () => {
  installCharacterName(SELF)
  const mod = new CharacterModule()
  mod.reset()
  mod.onEvent({ kind: 'level', seq: 1, ts: 1000, raw: '', level: 30 })
  mod.onEvent({ kind: 'zone', seq: 2, ts: 1100, raw: '', zone: 'West Commonlands' })
  mod.flushDelta()
  mod.onEvent({ kind: 'epoch', seq: 3, ts: 2000, raw: '', reason: 'launch' } as LogEvent)
  const d = mod.flushDelta()
  assert.equal(mod.snapshot().state.level, undefined, 'the level is gone')
  assert.equal(mod.snapshot().state.zone, undefined, 'and so is the zone')
  assert.ok(d, 'and the renderer is TOLD, rather than left holding a dead character’s level')
  assert.equal(d.delta.level, undefined)
})

// ---------------------------------------------------------------------------
// The read: provenance, age, and the hedge.
// ---------------------------------------------------------------------------

test('the read states which line said it and how long ago', () => {
  const row = at('Tue Jul 28 17:25:15 2026')
  const { character, levels } = replay(row)
  const read = currentLevelRead(character.level, progression(levels, row + 90_000))
  assert.ok(read)
  assert.equal(read.level, 10)
  assert.equal(read.source, 'who')
  assert.equal(read.ageMs, 90_000)
  assert.equal(read.stale, false)
  assert.equal(read.from, '/who')
  assert.equal(read.cue, '/who', 'a row is always cued — it is the player seeing their own move land')
  assert.equal(read.title, 'Your own /who row stated this level, 1m ago.')
})

test('a level nothing has restated in hours HEDGES, and says what to do', () => {
  const { character, levels } = replay(at('Tue Jul 28 17:38:04 2026'))
  const ding = character.level
  assert.equal(ding?.source, 'ding')
  const fresh = currentLevelRead(ding, progression(levels, ding.ts + LEVEL_STALE_MS - 1000))
  assert.equal(fresh?.stale, false)
  assert.equal(fresh?.cue, '', 'a level you dinged to recently is simply your level')
  const old = currentLevelRead(ding, progression(levels, ding.ts + 3 * LEVEL_STALE_MS))
  assert.equal(old?.stale, true)
  assert.equal(old.cue, '18h 0m ago')
  assert.match(old.title, /^Your last level-up reported this level, 18h 0m ago\./)
  assert.match(old.title, /loadout swap since then would have printed nothing/)
  assert.match(old.title, /\/who on yourself/, 'the hedge names the move that fixes it')
})

test('the age is measured on the LOG clock and never goes negative', () => {
  // Wall time would call a freshly-loaded three-week-old log three weeks stale the instant it
  // opened; and a snapshot whose `lastTs` has not caught up to the statement is a fold in
  // progress, not a level from the future.
  const fact: LevelStatement = { level: 42, ts: 5_000_000, source: 'ding' }
  assert.equal(currentLevelRead(fact, progression([], 4_000_000))?.ageMs, 0)
  assert.equal(currentLevelRead(fact, progression([], 5_000_000))?.ageMs, 0)
})

test('with no statement at all the read is null, and the ding tail stands in until one lands', () => {
  assert.equal(currentLevelRead(undefined, progression([], 0)), null, 'nothing stated ⇒ no chip')
  // The fallback is the SAME fact from the other module — the character module folds the very
  // same `level` events — so it is a hydration-order shim, never a second source of truth.
  const levels = [{ ts: 1000, level: 7 }, { ts: 2000, level: 8 }]
  const read = currentLevelRead(undefined, progression(levels, 2000))
  assert.equal(read?.level, 8)
  assert.equal(read.source, 'ding')
})

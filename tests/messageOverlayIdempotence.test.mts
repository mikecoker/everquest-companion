// ============================================================================
// messageOverlayIdempotence.test.mts — the same log, folded again, states the same counts (JOS-231).
// ============================================================================
//
// THE DEFECT. The observed-message overlay is a FOLD: it re-mines the whole log at every launch
// and its counts are a pure function of the bytes. What it was SEEDED with, though, was a flat
// pile of `<userData>/message-overlay.json` — the previous launch's identical fold — so every
// count the log accounts for was added to a snapshot that already contained it. MEASURED in the
// running app: 22 -> 44 -> 88 across three cold launches, doubling forever. Every verdict rests
// on those counts (`n >= 2` is what promotes a message to VERIFIED), so the registry drifted from
// "what the log says" toward "how many times the app has started".
//
// The checkpoint (JOS-208, since removed) masked it: a restored launch mined only the tail.
// With the checkpoint gone every launch is cold, which is also what makes this cheap to prove.
//
// THE FIX AND WHAT THIS PINS. Counts are filed per SOURCE — the character id whose log produced
// them — and `beginSource(key)` DISCARDS that key's bucket before its log is folded again. So a
// re-fold REPLACES a log's contribution instead of accumulating on top of it, and the seed keeps
// carrying everything a fold cannot re-derive (another character's bucket; the committed
// baseline). Four things are asserted here:
//
//   1. one miner, the same window mined twice → byte-identical counts;
//   2. THE ACCEPTANCE: three simulated cold launches over the same log, wired the way
//      `wiring.ts` + `pipeline.ts` wire the real one (baseline seed, persisted register,
//      corrections derived from the seed BEFORE the fold) → byte-identical overlays;
//   3. a second character's log adds a bucket and disturbs neither the first's counts nor the
//      baseline's — the reason the seed was not simply deleted;
//   4. THE TRIPWIRE: re-seeding a fold with its own previous output (the old shape, reproduced
//      by filing it under a foreign key) DOES double the counts — so these tests would notice.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { applyOverlayCorrections, loadSpellDb } from '../src/main/data/spellDb'
import {
  BASELINE_SOURCE,
  MessageOverlayMiner,
  persistableSources,
  type OverlaySeed,
  type OverlaySourceCounts
} from '../src/main/data/messageOverlay'
import { BuffsModule } from '../src/main/modules/buffs'
import baselineJson from '../src/main/data/messageOverlay.baseline.json'
import { FIXTURES } from './harness.mjs'
import type { MessageOverlay } from '../src/shared/types'

/** The committed baseline — `data/overlayPersistence.ts` reaches for Electron and cannot load here. */
const BASELINE = baselineJson as unknown as MessageOverlay

/** Two real windows, standing in for two characters' logs. Both mine dozens of associations. */
const LOG_A = 'w5-priming.log'
const LOG_B = 'w8-wears-off.log'

const CHAR_A = 'Primitive@freeport'
const CHAR_B = 'Alt@freeport'

function readLog(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
}

/**
 * ONE COLD LAUNCH, wired as the app wires it: the committed baseline plus the persisted buckets
 * seed the miner, the effective spell DB's corrections are derived from that seed BEFORE anything
 * is folded (`wiring.ts effectiveSpellDb` — nothing recomputes them afterwards), the character's
 * bucket is opened (`session.ts resetWorldFor`), and the whole log is folded.
 *
 * Returns what the app would then serve and what it would then WRITE — `persistableSources` is
 * the shipped filter `saveUserOverlay` applies, not a copy of it.
 */
function coldLaunch(
  persisted: OverlaySourceCounts[],
  charKey: string,
  lines: string[]
): { overlay: MessageOverlay; persisted: OverlaySourceCounts[] } {
  const seeds: OverlaySeed[] = [
    { key: BASELINE_SOURCE, counts: BASELINE },
    ...persisted.map((s) => ({ key: s.key, counts: s }))
  ]
  const db = loadSpellDb()
  const seedMiner = new MessageOverlayMiner(db.byKey)
  for (const seed of seeds) seedMiner.merge(seed.counts, seed.key)
  applyOverlayCorrections(db, seedMiner.deriveLandingCorrections())
  installSpellDb(db)

  const mod = new BuffsModule(db, seeds)
  mod.reset()
  mod.beginOverlaySource(charKey)
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return { overlay: mod.overlaySnapshot(), persisted: persistableSources(mod.overlayRegister()) }
}

/** Total observations across every message — the one number the defect doubled. */
function totalCount(overlay: MessageOverlay): number {
  return overlay.messages.reduce((a, m) => a + m.total, 0)
}

/** One bucket's total, for the per-source claims. */
function sourceTotal(sources: OverlaySourceCounts[], key: string): number {
  const s = sources.find((x) => x.key === key)
  assert.ok(s, `expected a bucket for ${key}`)
  return s.messages.reduce((a, m) => a + m.spells.reduce((b, sp) => b + sp.count, 0), 0)
}

// ------------------------------------------------------------------ 1. the miner, on its own

test('a miner that mines the same window twice states it once — byte-identical counts', () => {
  const db = loadSpellDb()
  installSpellDb(db)
  const lines = readLog(LOG_A)

  const mine = (miner: MessageOverlayMiner): string => {
    miner.beginSource(CHAR_A)
    // Drive the miner directly with the same events the module would offer it, so this test is
    // about the accumulator rather than about the module's event table.
    let seq = 0
    for (const raw of lines) {
      const ev = parseEvent(raw, seq++)
      if (!ev) continue
      if (ev.kind === 'castBegin') miner.observeCast(ev.spell, ev.ts)
      else if (ev.kind === 'buffApply' || ev.kind === 'spellEmote') {
        miner.observeMessage(ev.raw.slice(ev.raw.indexOf('] ') + 2), ev.ts, 'landing')
      } else if (ev.kind === 'buffWearOff' || ev.kind === 'buffFade') {
        miner.observeMessage(ev.raw.slice(ev.raw.indexOf('] ') + 2), ev.ts, 'wearsOff')
      }
    }
    return JSON.stringify(miner.build())
  }

  const miner = new MessageOverlayMiner(db.byKey)
  const first = mine(miner)
  const second = mine(miner)
  assert.ok(JSON.parse(first).messages.length > 0, 'the window teaches the miner something')
  assert.equal(second, first, 'the second fold of the same bytes REPLACED the first, it did not add to it')
})

// ------------------------------------------------------------- 2. THE ACCEPTANCE: cold launches

test('three cold launches over the same log state the same counts (22 -> 22 -> 22, not 22 -> 44 -> 88)', () => {
  const lines = readLog(LOG_A)

  const first = coldLaunch([], CHAR_A, lines)
  const second = coldLaunch(first.persisted, CHAR_A, lines)
  const third = coldLaunch(second.persisted, CHAR_A, lines)

  const mined = sourceTotal(first.persisted, CHAR_A)
  assert.ok(mined > 20, `the window has to mine something worth counting (mined ${mined})`)

  assert.equal(JSON.stringify(second.overlay), JSON.stringify(first.overlay), 'launch 2 == launch 1')
  assert.equal(JSON.stringify(third.overlay), JSON.stringify(first.overlay), 'launch 3 == launch 1')
  assert.equal(sourceTotal(second.persisted, CHAR_A), mined, 'and the bucket it writes back is the same size')
  assert.equal(sourceTotal(third.persisted, CHAR_A), mined)
  // The totals are the same number, said the way the ticket says it.
  assert.deepEqual(
    [totalCount(first.overlay), totalCount(second.overlay), totalCount(third.overlay)],
    [totalCount(first.overlay), totalCount(first.overlay), totalCount(first.overlay)]
  )
})

test('the register is per source, and the committed baseline is never written back', () => {
  const first = coldLaunch([], CHAR_A, readLog(LOG_A))
  assert.deepEqual(
    first.persisted.map((s) => s.key),
    [CHAR_A],
    'one bucket, named for the character whose log produced it'
  )
  assert.equal(
    first.persisted.some((s) => s.key === BASELINE_SOURCE),
    false,
    'the baseline is re-seeded from the bundle every launch — a copy in userData would only go stale'
  )
})

// -------------------------------------------------- 3. a second character, and the seed's purpose

test('a second character adds a bucket and disturbs neither the first character nor the baseline', () => {
  const linesA = readLog(LOG_A)
  const linesB = readLog(LOG_B)

  const a1 = coldLaunch([], CHAR_A, linesA)
  const minedA = sourceTotal(a1.persisted, CHAR_A)

  // Play the alt: A's log is NOT folded this launch, so A's knowledge can only come from the seed.
  const b1 = coldLaunch(a1.persisted, CHAR_B, linesB)
  assert.deepEqual(b1.persisted.map((s) => s.key).sort(), [CHAR_B, CHAR_A].sort())
  assert.equal(sourceTotal(b1.persisted, CHAR_A), minedA, "the alt's launch carried A's bucket through untouched")

  // Re-launch as the alt: idempotent again, now with a foreign bucket in the seed.
  const b2 = coldLaunch(b1.persisted, CHAR_B, linesB)
  assert.equal(JSON.stringify(b2.overlay), JSON.stringify(b1.overlay), 'the alt relaunches to the same overlay')

  // …and back to the main: its bucket is REBUILT by its own fold, to exactly what it was.
  const a2 = coldLaunch(b2.persisted, CHAR_A, linesA)
  assert.equal(sourceTotal(a2.persisted, CHAR_A), minedA, 'switching back re-folds A to the same counts, not to double')
  assert.equal(sourceTotal(a2.persisted, CHAR_B), sourceTotal(b1.persisted, CHAR_B), "and leaves B's alone")
})

// --------------------------------------------------------------------------- 4. THE TRIPWIRE

test('TRIPWIRE: re-seeding a fold with its own output under a foreign key DOES double — the old shape', () => {
  const lines = readLog(LOG_A)
  const first = coldLaunch([], CHAR_A, lines)
  const minedA = sourceTotal(first.persisted, CHAR_A)

  // The pre-JOS-231 shape, exactly: the previous launch's counts go back in as an undifferentiated
  // import (here, a key the fold will not claim), and the fold then re-states them on top.
  const asFlatPile = first.persisted.map((s) => ({ ...s, key: 'flat-pile' }))
  const second = coldLaunch(asFlatPile, CHAR_A, lines)

  assert.equal(sourceTotal(second.persisted, CHAR_A), minedA, 'the fold itself still states the log once')
  assert.equal(
    totalCount(second.overlay),
    totalCount(first.overlay) + minedA,
    'but the served overlay counts the log twice — which is the defect, and this test can see it'
  )
})

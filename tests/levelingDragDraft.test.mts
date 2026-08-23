// DRAG-SELECT EQUIVALENCE + THE COST OF ANSWERING A RANGE (JOS-290).
//
// WHAT CHANGED AND WHAT THIS FILE IS DEFENDING.
//
// The owner reported that drag-selecting a period over the leveling graph is slow. MEASURED
// first, on the owner's real 1.64M-line log, before anything was written:
//
//   • `rangeStats` is NOT the cost, and it does not even run during a drag — `useLevelingCharts`
//     derives the scope from the COMMITTED selection, so the numbers land on pointer-up. The
//     numbers below re-measure that claim every run.
//   • The cost was the CHANNEL: the draft band was React state in `LevelingView`, so every
//     pointermove re-rendered the whole tab. CPU-profiled at 250.3 ms of main thread per move
//     (60 real moves over a frozen copy of the owner's log); 9.4 ms after the fix, which is
//     26.7x. `selectionDraft.ts`'s header carries the full attribution.
//
// So the fast path this ticket produced is a RENDERING path, and the equivalence that has to be
// proven is that it selects the SAME INSTANTS the old one did. The JOS-283 pattern, applied to
// exactly the thing that moved: re-derive every answer the OLD way (the inline min/max the move
// and up handlers each spelled out for themselves) and compare — not just the range, but the
// whole `RangeStats` that range produces over the real golden windows, deep-equal, field for
// field. If `draftRange` ever disagreed with the formula it replaced, the band would draw one
// rectangle and the panel would describe another, which is the worst bug this surface could ship.
//
// The measurement is PRINTED every run (the JOS-283 rule) and the assertion is a loose ceiling,
// so a loaded machine reports rather than flakes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEvent } from '../src/main/log/parser'
import { EpochDetector } from '../src/main/log/epochDetector'
import { ProgressionModule } from '../src/main/modules/progression'
import { rangeStats } from '../src/shared/progressionStats'
import type { ProgressionSnap } from '../src/shared/progressionTypes'
import { readFixture } from './harness.mts'
import {
  createDraftStore,
  draftRange,
  sameDraft,
  type DraftRange
} from '../src/renderer/src/features/leveling/selectionDraft'

/** The owner's live log. Absent on CI and on a fresh machine — those runs use the fixtures. */
const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

/** The six golden windows `tests/progressionWindows.test.mts` pins `rangeStats` against. */
const GOLDEN = [
  'wl40-farm-run.log',
  'wl41-multizone.log',
  'wl42-idle-gap.log',
  'wl43-capped-no-pct.log',
  'wl44-swap-boundary.log',
  'wl45-kill-credit.log'
] as const

/** Replay raw lines through the real parser + EpochDetector + ProgressionModule, as index.ts wires it. */
function replay(lines: string[]): ProgressionSnap {
  const mod = new ProgressionModule()
  mod.reset()
  const epoch = new EpochDetector()
  epoch.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev, false)
    const e = epoch.observe(ev)
    if (e) mod.onEvent(e, false)
  }
  return mod.snapshot().state
}

/**
 * THE SLOW PATH: the range a drag covered, spelled the way `useChartSelection` spelled it before
 * JOS-290 — inline, twice (once in `onPointerMove` for the band, once in `onPointerUp` for the
 * commit). Copied VERBATIM from the pre-change file so the comparison is against what shipped,
 * not against a paraphrase of it.
 */
function legacyRange(originTs: number, ts: number): DraftRange {
  return { t0: Math.min(originTs, ts), t1: Math.max(originTs, ts) }
}

/** The snapshot's own bounds — where a drag on this record can start and end. */
function boundsOf(snap: ProgressionSnap): { lo: number; hi: number } {
  const firsts = [snap.expTs[0], snap.killTs[0], snap.lootTs[0], snap.zoneStart[0]].filter(
    (v): v is number => v !== undefined
  )
  return { lo: Math.min(...firsts), hi: snap.lastTs }
}

/** Deterministic PRNG — a randomized suite that cannot differ between two runs of the same code. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1. THE STORE'S CONTRACT — `useSyncExternalStore`'s requirements, stated as a test.

test('the draft store hands back a STABLE reference until it is set', () => {
  const store = createDraftStore()
  assert.equal(store.get(), null)
  assert.equal(store.get(), store.get(), 'a fresh object per read would re-render forever')
  store.set({ t0: 10, t1: 20 })
  const first = store.get()
  assert.equal(store.get(), first)
  assert.deepEqual(first, { t0: 10, t1: 20 })
})

test('an EQUAL set notifies nobody — a pointer moving inside one pixel is zero renders', () => {
  const store = createDraftStore()
  let notified = 0
  store.subscribe(() => notified++)
  store.set({ t0: 10, t1: 20 })
  assert.equal(notified, 1)
  store.set({ t0: 10, t1: 20 }) // same instants, a fresh object
  assert.equal(notified, 1, 'an equal value must not notify')
  store.set({ t0: 10, t1: 21 })
  assert.equal(notified, 2)
  store.set(null)
  assert.equal(notified, 3, 'clearing the band IS a change')
  store.set(null)
  assert.equal(notified, 3)
})

test('a subscriber that unsubscribes while being notified does not shorten the walk', () => {
  const store = createDraftStore()
  const seen: string[] = []
  const offA = store.subscribe(() => {
    seen.push('a')
    offA()
  })
  store.subscribe(() => seen.push('b'))
  store.set({ t0: 1, t1: 2 })
  assert.deepEqual(seen, ['a', 'b'])
  store.set({ t0: 3, t1: 4 })
  assert.deepEqual(seen, ['a', 'b', 'b'], 'only the survivor is notified the second time')
})

test('sameDraft treats null as a value, not as an absence', () => {
  assert.ok(sameDraft(null, null))
  assert.ok(!sameDraft(null, { t0: 1, t1: 2 }))
  assert.ok(!sameDraft({ t0: 1, t1: 2 }, null))
  assert.ok(sameDraft({ t0: 1, t1: 2 }, { t0: 1, t1: 2 }))
  assert.ok(!sameDraft({ t0: 1, t1: 2 }, { t0: 1, t1: 3 }))
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// 2. THE EQUIVALENCE — fast path == slow path, over the golden windows and randomized drags.

test('the drag path selects the SAME instants the inline formula did, and the same RangeStats', () => {
  let compared = 0
  let statsCompared = 0
  for (const fixture of GOLDEN) {
    const snap = replay(readFixture(fixture))
    const { lo, hi } = boundsOf(snap)
    const span = Math.max(1, hi - lo)
    const rand = rng(0x5eed ^ fixture.length)
    // Every drag a user can make on this window: both directions, both edges, the degenerate
    // click-width one, and 120 randomized pairs — plus the clamped ends, which is where a
    // rewritten min/max would most plausibly have gone wrong.
    const pairs: [number, number][] = [
      [lo, hi],
      [hi, lo],
      [lo, lo],
      [hi, hi],
      [lo + span / 3, lo + span / 3]
    ]
    for (let i = 0; i < 120; i++) {
      pairs.push([lo + rand() * span, lo + rand() * span])
    }
    for (const [origin, at] of pairs) {
      const fast = draftRange(origin, at)
      const slow = legacyRange(origin, at)
      assert.deepStrictEqual(fast, slow, `${fixture}: drag ${origin} -> ${at}`)
      // Ordered, whichever way the pointer travelled — the property the band and the commit
      // both depend on.
      assert.ok(fast.t0 <= fast.t1, `${fixture}: range is ordered`)
      compared++
      // …AND THE ANSWER THE PANEL PRINTS. A range that is equal but produces a different
      // RangeStats would be impossible; asserting it anyway is what makes this a regression
      // gate on the whole seam rather than on one arithmetic expression.
      assert.deepStrictEqual(
        rangeStats({ snap, range: fast }),
        rangeStats({ snap, range: slow }),
        `${fixture}: RangeStats over ${String(fast.t0)}..${String(fast.t1)}`
      )
      statsCompared++
    }
  }
  console.log(`drag ranges compared fast-vs-slow: ${compared}; full RangeStats deep-equalled: ${statsCompared}`)
  assert.ok(compared >= 750, `only ${compared} comparisons — the golden windows did not replay`)
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// 3. THE MEASUREMENT — printed every run, asserted loosely.

test('answering a dragged range is cheap enough to do on pointer-up', () => {
  // The commit path, over the WIDEST record available. On the owner's machine that is the real
  // log; everywhere else it is the widest golden window, which is a smaller claim honestly made.
  const real = existsSync(LOG)
  const snap = real
    ? replay(readFileSync(LOG, 'utf8').split(/\r?\n/))
    : replay(readFixture('wl42-idle-gap.log'))
  const { lo, hi } = boundsOf(snap)
  const cols = snap.expTs.length + snap.killTs.length + snap.lootTs.length + snap.witnessTs.length
  // A 120-move sweep: the shape a drag makes, origin pinned, the far edge crossing the plot.
  const range = (i: number): { t0: number; t1: number } => ({ t0: lo, t1: lo + ((hi - lo) * i) / 120 })
  for (let i = 1; i <= 10; i++) rangeStats({ snap, range: range(i) }) // warm
  const t0 = performance.now()
  for (let i = 1; i <= 120; i++) rangeStats({ snap, range: range(i) })
  const per = (performance.now() - t0) / 120
  console.log(
    `rangeStats over ${real ? 'THE REAL LOG' : 'wl42'}: ${per.toFixed(3)} ms per range, ` +
      `${cols} sample rows / ${snap.zoneName.length} zone intervals / ${((hi - lo) / 3.6e6).toFixed(1)} h span`
  )
  // The columns are CAPPED (EXP_CAP/KILL_CAP 40k, ZONE_CAP 4k), which is why this is a constant
  // rather than a function of how long the owner has played — the ticket's "O(full-log) fold per
  // pixel" cannot happen through this door. A loose ceiling: this is a tripwire against someone
  // making the query quadratic later, not a benchmark of the machine it runs on.
  assert.ok(per < 50, `a range answer took ${per.toFixed(1)} ms — the query is no longer a binary search`)
})

// THE FRACTIONAL LEVEL CURVE (JOS-292) — its anchors, its accumulation, the four refusals, and
// the proof that drawing it one vertex per pixel column is the same picture as drawing it one
// vertex per log line.
//
// METHODOLOGY (AGENTS.md): every claim below is made against a VERBATIM span of the owner's real
// log, replayed through the REAL parseEvent + ProgressionModule — the same three fixtures the
// progression suite already hand-read (WL40 the dense farm run, WL44 the loadout swap) plus the
// committed e2e window, which is the one that carries stated AND unstated lines in the same
// series. The two refusals the fixtures cannot produce (`clipped` needs a 40k-row eviction,
// `overfull` needs the game to disagree with itself) are constructed from hand-written columns,
// and that is said where it happens.
//
// WHAT WOULD BE THE WORST BUG HERE, which is what most of this file is aimed at: a pixel that
// claims a bar position the log never stated. That has four shapes — accumulating through an
// unstated line, accumulating across an unlogged loadout swap, accumulating from an anchor whose
// samples have aged out, and a down-sampler that INVENTS a vertex rather than dropping one. Each
// gets its own section.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEvent } from '../src/main/log/parser'
import { EpochDetector } from '../src/main/log/epochDetector'
import { ProgressionModule } from '../src/main/modules/progression'
import type { ProgressionSnap } from '../src/shared/progressionTypes'
import { readFixture } from './harness.mts'
import { buildLevelSegments, type LevelPoint, type LevelSegment } from '../src/renderer/src/features/leveling/levelSeries'
import { windowOver } from '../src/renderer/src/features/leveling/chartWindow'
import { CHART_W, xOf, type ChartScale } from '../src/renderer/src/features/leveling/levelChartGeometry'
import { PAD_X } from '../src/renderer/src/features/leveling/zoneBands'
import {
  curveAt,
  downsampleCurve,
  levelCurveFull,
  type CurvePoint,
  type CurveRun,
  type ExpColumns,
  type LevelCurve
} from '../src/renderer/src/features/leveling/levelCurve'

/** The owner's live log. Absent on CI and on a fresh machine — those runs use the fixtures. */
const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

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
 * The ding runs, off the snapshot's own mirror of the level series.
 *
 * The app builds these from the `leveling` module (LevelingView `buildLevelSegments(sortLevels(…))`)
 * and the progression module mirrors the same two columns on purpose (progression.ts's header) —
 * so this is the same series through the door that lets one replay answer both halves.
 */
function segmentsOf(snap: ProgressionSnap): LevelSegment[] {
  const pts: LevelPoint[] = snap.levelTs.map((ts, i) => ({ ts, level: snap.levelValue[i] }))
  return buildLevelSegments(pts)
}

/** The domain the tab draws at `All`, and the scale the chart maps it with. */
function scaleOf(snap: ProgressionSnap): ChartScale {
  const firsts = [snap.expTs[0], snap.killTs[0], snap.lootTs[0], snap.zoneStart[0], snap.levelTs[0]].filter(
    (v): v is number => v !== undefined
  )
  const win = windowOver(Math.min(...firsts), snap.lastTs)
  return { ...win, w: CHART_W, padX: PAD_X }
}

interface Case {
  name: string
  snap: ProgressionSnap
  segments: LevelSegment[]
  scale: ChartScale
  full: LevelCurve
}

function fixtureCase(name: string): Case {
  const snap = replay(readFixture(name))
  const segments = segmentsOf(snap)
  const scale = scaleOf(snap)
  return { name, snap, segments, scale, full: levelCurveFull({ snap, segments, t0: scale.t0, t1: scale.t1 }) }
}

/** Every drawn vertex, across every run. */
function allPoints(curve: LevelCurve): CurvePoint[] {
  return curve.runs.flatMap((r) => r.points)
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1. THE ANCHOR AND THE ACCUMULATION — WL40, the dense farm run (Sun Aug 02 15:12→17:33).
//    Ten dings, 324 stated percentages, not one unstated line. If the arithmetic is right
//    anywhere it is right here, and the y values are re-derived independently below rather
//    than read back out of the thing under test.

test('WL40: every run starts ON its ding and rises only by the percentages the log stated', () => {
  const c = fixtureCase('wl40-farm-run.log')
  assert.equal(c.full.gaps.length, 0, 'the farm run states every one of its percentages')
  assert.ok(c.full.runs.length >= 10, `only ${c.full.runs.length} runs — the fixture did not replay`)

  let vertices = 0
  for (const run of c.full.runs) {
    const anchor = run.points[0]
    assert.ok(
      c.snap.levelTs.includes(anchor.ts) && anchor.y === c.snap.levelValue[c.snap.levelTs.indexOf(anchor.ts)],
      `a run must open on a ding at that ding's own level (got ${String(anchor.y)} at ${String(anchor.ts)})`
    )
    // INDEPENDENT RE-DERIVATION: level + Σ stated percent strictly after the ding, walked here
    // rather than trusting the module's own running total.
    let equiv = 0
    let seen = 0
    for (let i = 0; i < c.snap.expTs.length; i++) {
      const ts = c.snap.expTs[i]
      if (ts <= anchor.ts || ts >= run.endTs) continue
      assert.equal(c.snap.expFlag[i] & 1, 0, 'WL40 states every percentage')
      equiv += c.snap.expPct[i] / 100
      seen++
      const p = run.points[seen]
      assert.equal(p.ts, ts, 'one vertex per stated line, in log order')
      assert.ok(Math.abs(p.y - (anchor.y + equiv)) < 1e-9, `vertex ${String(seen)} is the running sum`)
    }
    vertices += seen
  }
  // A FLOOR over the whole window, not one per run, and deliberately under the fixture's 324
  // stated lines: the run the fixture ENDS on holds none at all, and every line sharing a
  // ding's own second is excluded from both bars by the strictly-between rule above (287 of
  // 324 survive that today). An exact count would rot the moment the extractor moved a boundary.
  assert.ok(vertices >= 250, `only ${String(vertices)} stated vertices — the fixture did not replay`)
})

test('WL40: a bar fills to about one level, and the run steps up AT the ding that closed it', () => {
  const c = fixtureCase('wl40-farm-run.log')
  // Every run but the last closes on the next ding — the load-bearing arithmetic WL40 was cut
  // for ("Σ percent between consecutive dings ≈ 1.0 level"), read off the drawn geometry.
  let closed = 0
  for (const run of c.full.runs) {
    const last = run.points[run.points.length - 1]
    const prev = run.points[run.points.length - 2]
    if (!c.snap.levelTs.includes(last.ts) || last.ts === run.points[0].ts) continue
    assert.equal(last.ts, run.endTs, 'the closing ding is where the run ends')
    assert.equal(last.y, run.points[0].y + 1, 'the ding steps the curve up exactly one level')
    // The percentage stated in the bar, just before the ding: ~1.0, never wildly under or over.
    const filled = prev.y - run.points[0].y
    assert.ok(filled > 0.8 && filled < 1.0, `a full bar states ${(filled * 100).toFixed(1)}% of itself`)
    closed++
  }
  assert.ok(closed >= 9, `only ${String(closed)} closed bars — the fixture did not replay`)
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// 2. THE UNSTATED SPAN — the committed e2e window, the one series carrying both kinds of line
//    (212 stated, 129 unstated, three dings). THE RULE: after the first unstated line in a bar
//    the true position is `Σstated + something unknown and non-negative`, so it is BOUNDED, not
//    known. The run stops there and nothing is drawn until the next anchor.

test('an unstated line ends its bar’s run, and no vertex is ever drawn inside a gap', () => {
  const c = fixtureCase('e2e-leveling.log')
  const unstated = c.full.gaps.filter((g) => g.kind === 'unstated')
  assert.ok(unstated.length > 0, 'this window has unstated experience lines in it')

  for (const g of unstated) {
    // The gap opens AT an unstated line — not at a rounded-off boundary.
    const at = c.snap.expTs.indexOf(g.t0)
    assert.ok(at >= 0 && (c.snap.expFlag[at] & 1) !== 0, 'a gap opens on the unstated line that caused it')
  }
  for (const p of allPoints(c.full)) {
    for (const g of c.full.gaps) {
      assert.ok(!(p.ts > g.t0 && p.ts < g.t1), `a vertex at ${String(p.ts)} sits inside a ${g.kind} gap`)
    }
  }
})

test('NOTHING is interpolated through an unstated line — every one of them is inside a refusal', () => {
  const c = fixtureCase('e2e-leveling.log')
  const firstDing = c.snap.levelTs[0]
  let covered = 0
  let atDing = 0
  let beforeAnchor = 0
  for (let i = 0; i < c.snap.expTs.length; i++) {
    if ((c.snap.expFlag[i] & 1) === 0) continue
    const ts = c.snap.expTs[i]
    if (ts < firstDing) {
      beforeAnchor++ // nothing is drawn before the first ding at all — there is no anchor to sum from
      continue
    }
    // A line in the SAME SECOND as a ding is excluded from both bars by design (levelEta's rule,
    // restated in walkBar): it is the carry-over the log does not attribute either way.
    if (c.snap.levelTs.includes(ts)) {
      atDing++
      continue
    }
    const at = curveAt(c.full, ts)
    assert.ok(at?.kind === 'refused', `the unstated line at ${String(ts)} must fall inside a refusal`)
    covered++
  }
  console.log(
    `e2e-leveling unstated lines: ${String(covered)} inside a refusal, ${String(atDing)} in a ding's own second, ` +
      `${String(beforeAnchor)} before the first ding`
  )
  assert.ok(covered > 0, 'the window has unstated lines after its first ding')
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// 3. THE LOADOUT SWAP — WL44 (Fri Jul 31 16:19 level 50 → Sun Aug 02 02:26 level 13). The swap
//    itself is NEVER logged, so nothing can date it and every exp line in the span might belong
//    to either bar. The span refuses wholesale, and NO stroke crosses it.

test('WL44: the swap span is refused wholesale, and no run bridges it', () => {
  const c = fixtureCase('wl44-swap-boundary.log')
  const swap = c.full.gaps.filter((g) => g.kind === 'swapped')
  assert.equal(swap.length, 1, 'this window holds exactly one loadout swap')
  const g = swap[0]
  assert.equal(g.level, 50, 'the gap carries the last level the log reported before it')

  const post = c.full.dings.find((d) => d.afterSwap)
  assert.ok(post, 'the post-swap ding is marked as the discontinuity it is')
  assert.equal(g.t0, c.snap.levelTs[0], 'the gap opens at the last pre-swap ding')
  assert.equal(g.t1, post.ts, 'and closes at the first ding of the new loadout')
  assert.equal(post.level, 11, 'which is the level the game re-reported for the new loadout')

  // NOT ONE VERTEX inside it — the refusal is about accumulation, not only about the stroke.
  for (const p of allPoints(c.full)) {
    assert.ok(!(p.ts > g.t0 && p.ts < g.t1), `a vertex at ${String(p.ts)} accumulated across the swap`)
  }
  // …and no run spans it either: a run that started before and ended after would draw a line
  // straight through, which is the exact picture `drawSegments` was fixed not to draw.
  for (const run of c.full.runs) {
    const spans = run.points[0].ts <= g.t0 && Math.max(run.endTs, run.points[run.points.length - 1].ts) >= g.t1
    assert.ok(!spans, 'no run may cover both sides of the swap')
  }
  // The stated lines INSIDE the span are real and are deliberately drawn by nothing.
  let inside = 0
  for (let i = 0; i < c.snap.expTs.length; i++) {
    if (c.snap.expTs[i] > g.t0 && c.snap.expTs[i] < g.t1 && (c.snap.expFlag[i] & 1) === 0) inside++
  }
  console.log(`wl44: ${String(inside)} stated percentages sit inside the unlogged swap and are drawn by nothing`)
  assert.ok(inside > 0, 'the span really does carry stated lines — the refusal is costing something')
})

test('WL44: the post-swap loadout accumulates normally on the other side', () => {
  const c = fixtureCase('wl44-swap-boundary.log')
  const post = c.full.runs.filter((r) => r.points[0].y === 11 || r.points[0].y === 12)
  assert.ok(post.length >= 1, 'the new loadout has bars of its own')
  for (const run of post) {
    assert.ok(run.points.length >= 2, 'a post-swap bar draws the percentages stated inside it')
    for (let i = 1; i < run.points.length; i++) {
      assert.ok(run.points[i].y >= run.points[i - 1].y, 'the curve never descends inside a run')
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// 4. THE TWO REFUSALS NO FIXTURE CAN PRODUCE. `clipped` needs 40k rows to age out and `overfull`
//    needs the game to state more than a bar's worth with no ding — HAND-WRITTEN columns, said
//    out loud (AGENTS.md's awaiting-sample law: this is a shape the code must handle, and the
//    test says plainly that no real bytes are behind it).

const D0 = Date.parse('2026-08-02T15:00:00')
const M = 60_000

function columns(rows: { at: number; pct?: number }[], windowStart = 0): ExpColumns {
  return {
    expTs: rows.map((r) => D0 + r.at * M),
    expPct: rows.map((r) => r.pct ?? -1),
    expFlag: rows.map((r) => (r.pct === undefined ? 1 : 0)),
    windowStart
  }
}

const oneDing = (level: number): LevelSegment[] => [{ points: [{ ts: D0, level }], afterSwap: false }]

test('a bar whose anchor predates the retention floor refuses WHOLESALE (clipped)', () => {
  const snap = columns([{ at: 1, pct: 10 }, { at: 2, pct: 10 }], D0 + 30_000)
  const curve = levelCurveFull({ snap, segments: oneDing(20), t0: D0 - M, t1: D0 + 10 * M })
  assert.equal(curve.runs.length, 0, 'nothing is drawn from a sum that is missing its start')
  assert.deepEqual(curve.gaps.map((g) => g.kind), ['clipped'])
  assert.equal(curve.gaps[0].level, 20, 'the level is still known — only the position in the bar is not')
})

test('percentages exceeding a whole level with no ding refuse from that line on (overfull)', () => {
  const snap = columns([{ at: 1, pct: 60 }, { at: 2, pct: 60 }, { at: 3, pct: 5 }])
  const curve = levelCurveFull({ snap, segments: oneDing(20), t0: D0 - M, t1: D0 + 10 * M })
  assert.equal(curve.runs.length, 1)
  assert.deepEqual(
    curve.runs[0].points.map((p) => p.y),
    [20, 20.6],
    'the part that was stated is still drawn; the line that broke the model is not'
  )
  assert.equal(curve.runs[0].endTs, D0 + 2 * M, 'the run holds flat to the instant the model broke')
  assert.deepEqual(curve.gaps.map((g) => g.kind), ['overfull'])
  assert.equal(curve.gaps[0].t0, D0 + 2 * M)
})

test('the live bar holds flat to the end of the drawn domain, and never past a refusal', () => {
  const open = levelCurveFull({
    snap: columns([{ at: 1, pct: 25 }]),
    segments: oneDing(20),
    t0: D0 - M,
    t1: D0 + 10 * M
  })
  assert.equal(open.runs[0].endTs, D0 + 10 * M, 'nothing has happened since, which is what a plateau says')
  assert.equal(open.hiY, 20.25)

  const cut = levelCurveFull({
    snap: columns([{ at: 1, pct: 25 }, { at: 2 }]),
    segments: oneDing(20),
    t0: D0 - M,
    t1: D0 + 10 * M
  })
  assert.equal(cut.runs[0].endTs, D0 + 2 * M, 'the plateau stops where the evidence does')
  assert.deepEqual(cut.gaps.map((g) => [g.kind, g.t1]), [['unstated', D0 + 10 * M]])
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// 4b. THE SWAP THAT LANDS ON THE LEVEL YOU WERE ALREADY AT (JOS-331) — section 3's refusal, in
//     the one shape `buildLevelSegments` cannot flag. Hand-written columns because the point is
//     the SHAPE, and the real occurrence of it is a moving target in a live log (the owner's is
//     Tue Jul 28 2026: `Welcome to level 11!` at 15:51:40 and again at 16:46:22, with 95.302% of
//     a bar stated in between and the series carrying on to 12). This is the regression test —
//     the live-log tripwire in section 5 is what FOUND it, and only after the window re-scaled.

test('two dings at the SAME level are one segment — the blind spot this refusal covers', () => {
  const segs = buildLevelSegments([
    { ts: D0, level: 11 },
    { ts: D0 + 3 * M, level: 11 }
  ])
  // Not an accusation, a statement of fact about the upstream contract: the split is on a STRICT
  // decrease, so an equal-level re-report is invisible there and `afterSwap` stays false. Which
  // is exactly why levelCurve.isUnannouncedRestart has to test the levels itself.
  assert.equal(segs.length, 1, 'the strict-decrease split does not see an equal-level re-report')
  assert.equal(segs[0].afterSwap, false)
})

test('a ding that re-reports the level it was already at refuses its span, and never descends', () => {
  const snap = columns([{ at: 1, pct: 40 }, { at: 2, pct: 40 }, { at: 4, pct: 10 }])
  const segments = buildLevelSegments([
    { ts: D0, level: 11 },
    { ts: D0 + 3 * M, level: 11 }
  ])
  const curve = levelCurveFull({ snap, segments, t0: D0 - M, t1: D0 + 10 * M })

  // The span between the two level-11 reports refuses WHOLESALE, in `swapped`'s own word: no
  // level was gained at the second one, so nothing dates the restart and the 80% stated inside
  // might belong to either bar — WL44's argument exactly, at an equal level instead of a lower.
  assert.deepEqual(
    curve.gaps.map((g) => [g.kind, g.t0, g.t1, g.level]),
    [['swapped', D0, D0 + 3 * M, 11]]
  )
  // THE BUG THIS IS AGAINST: the old code closed the first bar ON that re-report, so the run rose
  // to 11.8 and then dropped to 11 in one stroke — a pixel claiming the bar emptied.
  for (const run of curve.runs) {
    for (let i = 1; i < run.points.length; i++) {
      assert.ok(run.points[i].y >= run.points[i - 1].y, 'no run may descend')
    }
    for (const p of run.points) {
      assert.ok(!(p.ts > D0 && p.ts < D0 + 3 * M), `a vertex at ${String(p.ts)} accumulated across the restart`)
    }
  }
  // The bar AFTER the re-report is ordinary and is still drawn — the refusal is one span, not a
  // poison pill for the rest of the series.
  assert.equal(curve.runs.length, 1, 'the post-restart bar draws normally')
  assert.deepEqual(curve.runs[0].points.map((p) => p.y), [11, 11.1])
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// 5. THE DOWN-SAMPLER, against a SLOW FULL-RESOLUTION REFERENCE over the real capped columns.
//
//    The claim being proven is not "close enough". It is that per pixel column the reduced path
//    covers the SAME vertical extent as the full one and that every vertex it keeps is a vertex
//    the log produced — i.e. the reduction can only DROP samples, never move or average one. The
//    reference is recomputed here from the full curve by brute force, per column, per run.

/** Every column an ascending point list touches, with the min and max y inside each. */
function columnExtent(points: readonly CurvePoint[], scale: ChartScale, colW = 1): Map<number, [number, number]> {
  const by = new Map<number, [number, number]>()
  for (const p of points) {
    const col = Math.floor(xOf(scale, p.ts) / colW)
    const cur = by.get(col)
    if (!cur) by.set(col, [p.y, p.y])
    else by.set(col, [Math.min(cur[0], p.y), Math.max(cur[1], p.y)])
  }
  return by
}

/**
 * The owner's live log, replayed AT MOST ONCE per process.
 *
 * 135 MB through the real parser is ~2.5 s and three tests below want the same snapshot, so the
 * replay is cached rather than repeated. `undefined` is "not tried yet", `null` is "there is no
 * live log here" — which is every machine but the owner's, CI included.
 */
let realLogCase: Case | null | undefined
function theRealLog(): Case | null {
  if (realLogCase !== undefined) return realLogCase
  if (!existsSync(LOG)) {
    realLogCase = null
    return realLogCase
  }
  const snap = replay(readFileSync(LOG, 'utf8').split(/\r?\n/))
  const segments = segmentsOf(snap)
  const scale = scaleOf(snap)
  realLogCase = {
    name: 'THE REAL LOG',
    snap,
    segments,
    scale,
    full: levelCurveFull({ snap, segments, t0: scale.t0, t1: scale.t1 })
  }
  return realLogCase
}

/** The fixtures + (on the owner's machine) the real log, which is the only place the columns
 *  are actually at their cap. */
function downsampleCases(): Case[] {
  const cases = ['wl40-farm-run.log', 'wl44-swap-boundary.log', 'e2e-leveling.log'].map(fixtureCase)
  const real = theRealLog()
  if (real) cases.push(real)
  return cases
}

/**
 * One run, reduced vs full. Its own function so the nesting stays inside the repo's measured
 * `max-depth 3` — and because the four claims below are the whole substance of the reduction.
 * Returns how many columns it compared exactly.
 */
function assertRunReduced(ref: CurveRun, got: CurveRun, scale: ChartScale, label: string): number {
  assert.equal(got.endTs, ref.endTs, `${label}: the held tail is untouched`)
  // 1. SUBSET, in order: the reduction only ever drops. Compared by REFERENCE, so a vertex that
  // was recomputed to the same numbers would still fail — nothing may be rebuilt, only kept.
  let at = 0
  for (const p of got.points) {
    while (at < ref.points.length && ref.points[at] !== p) at++
    assert.ok(at < ref.points.length, `${label}: a vertex was INVENTED, not kept`)
  }
  // 2. ENDPOINTS survive — a run that lost its anchor would enter the plot in mid-air.
  assert.equal(got.points[0], ref.points[0], `${label}: the anchor survives`)
  assert.equal(got.points[got.points.length - 1], ref.points[ref.points.length - 1], `${label}: the last vertex survives`)
  // 3. THE PICTURE: identical vertical extent in every column the run touches.
  const refCols = columnExtent(ref.points, scale)
  const gotCols = columnExtent(got.points, scale)
  const keys = (m: Map<number, [number, number]>): number[] => [...m.keys()].sort((a, b) => a - b)
  assert.deepEqual(keys(gotCols), keys(refCols), `${label}: the same columns are drawn in`)
  for (const [col, extent] of refCols) assert.deepEqual(gotCols.get(col), extent, `${label} column ${String(col)}`)
  // 4. THE BUDGET: at most two vertices per occupied column, which is the whole point.
  assert.ok(
    got.points.length <= refCols.size * 2,
    `${label}: ${String(got.points.length)} vertices over ${String(refCols.size)} columns`
  )
  return refCols.size
}

/**
 * THE PRECONDITION, ASSERTED DIRECTLY (JOS-331).
 *
 * `downsamplePoints` keeps the FIRST and LAST vertex of each pixel column, which reproduces that
 * column's vertical extent only while a run never descends. A descending run breaks it SILENTLY:
 * the column holding the descent reports a maximum that is not the column's maximum, and whether
 * anyone notices depends on where the column boundaries happen to fall — which is why the real
 * defect this test now guards lived in the log for three weeks and surfaced only when the `All`
 * window re-scaled and moved the grid underneath it.
 *
 * So the invariant gets its own test, ahead of the one that depends on it. When the next data
 * shape breaks it, this fails by name instead of as a mystery column-extent mismatch.
 */
test('no full-resolution run ever descends — the invariant first+last per column is exact under', () => {
  let vertices = 0
  for (const c of downsampleCases()) {
    for (let i = 0; i < c.full.runs.length; i++) {
      const pts = c.full.runs[i].points
      for (let k = 1; k < pts.length; k++) {
        assert.ok(
          pts[k].y >= pts[k - 1].y,
          `${c.name} run ${String(i)}: the curve DESCENDS ${String(pts[k - 1].y)} → ${String(pts[k].y)} ` +
            `at ${new Date(pts[k].ts).toISOString()} — a pixel claiming the bar emptied`
        )
      }
      vertices += pts.length
    }
  }
  assert.ok(vertices > 500, `only ${String(vertices)} vertices checked — the cases did not replay`)
})

test('per-pixel down-sampling draws the same picture as one vertex per log line', () => {
  let columnsChecked = 0
  let dropped = 0
  let kept = 0
  for (const c of downsampleCases()) {
    const small = downsampleCurve(c.full, c.scale)
    // Everything BUT the vertices is untouched — a reduction that quietly moved a gap or lost a
    // ding marker would be a different chart wearing the same name.
    assert.deepEqual(small.gaps, c.full.gaps, `${c.name}: gaps`)
    assert.deepEqual(small.dings, c.full.dings, `${c.name}: dings`)
    assert.equal(small.runs.length, c.full.runs.length, `${c.name}: run count`)
    assert.equal(small.hiY, c.full.hiY, `${c.name}: y extent`)
    for (let i = 0; i < c.full.runs.length; i++) {
      columnsChecked += assertRunReduced(c.full.runs[i], small.runs[i], c.scale, `${c.name} run ${String(i)}`)
      dropped += c.full.runs[i].points.length - small.runs[i].points.length
      kept += small.runs[i].points.length
    }
  }
  console.log(`down-sampling: ${String(kept)} vertices kept, ${String(dropped)} dropped, ${String(columnsChecked)} columns compared exact`)
  assert.ok(columnsChecked > 100, `only ${String(columnsChecked)} columns compared — the cases did not replay`)
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// 6. THE COST. The premise this ticket was re-briefed on is that the exp column is CAPPED, so
//    building the curve is a constant-ish pass rather than a function of how long the owner has
//    played. Measured over the widest record available and PRINTED every run (the JOS-283 rule);
//    the assertion is a loose tripwire against someone making this quadratic later, not a
//    benchmark of the machine.

test('building the curve is cheap enough to do on every snapshot and every window change', () => {
  const c = theRealLog() ?? fixtureCase('wl44-swap-boundary.log')
  const real = c.name === 'THE REAL LOG'
  const { snap, segments, scale } = c
  const args = { snap, segments, t0: scale.t0, t1: scale.t1 }
  for (let i = 0; i < 5; i++) downsampleCurve(levelCurveFull(args), scale)
  const t0 = performance.now()
  const N = 40
  let vertices = 0
  for (let i = 0; i < N; i++) vertices = downsampleCurve(levelCurveFull(args), scale).runs.reduce((n, r) => n + r.points.length, 0)
  const per = (performance.now() - t0) / N
  const fullVertices = levelCurveFull(args).runs.reduce((n, r) => n + r.points.length, 0)
  console.log(
    `levelCurve over ${real ? 'THE REAL LOG' : 'wl44'}: ${per.toFixed(3)} ms per build, ` +
      `${String(snap.expTs.length)} exp rows / ${String(snap.levelTs.length)} dings ⇒ ` +
      `${String(fullVertices)} full-resolution vertices down to ${String(vertices)} drawn`
  )
  assert.ok(per < 60, `a curve build took ${per.toFixed(1)} ms — the pass is no longer linear over a capped column`)
  assert.ok(vertices <= fullVertices, 'the reduction never grows the path')
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// 7. THE READOUT READS THE PIXELS. `curveAt` is what the hover layer prints, and the standing
//    sin on this chart is a readout that contradicts the picture (levelCharts.tsx's honesty fix).

test('curveAt answers from the drawn geometry, refusals included', () => {
  const c = fixtureCase('wl44-swap-boundary.log')
  const g = c.full.gaps.find((x) => x.kind === 'swapped')
  assert.ok(g)
  const mid = g.t0 + (g.t1 - g.t0) / 2
  assert.deepEqual(curveAt(c.full, mid), { kind: 'refused', refusal: 'swapped', level: 50 })

  const run = c.full.runs.find((r) => r.points.length > 3)
  assert.ok(run)
  const p = run.points[2]
  const at = curveAt(c.full, p.ts)
  assert.equal(at?.kind, 'stated')
  assert.ok(at?.kind === 'stated' && at.y === p.y, 'the readout names the vertex under the cursor')
  assert.ok(at.kind === 'stated' && at.level === Math.floor(p.y), 'and the level it belongs to')

  assert.equal(curveAt(c.full, c.scale.t0 - 1_000_000), null, 'before anything is drawn there is no answer')
})

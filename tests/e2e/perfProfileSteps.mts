/**
 * perfProfileSteps.mts — the FILE half of the Performance spec: everything asserted about
 * <userData>/perf-startup.json once the app that wrote it has exited.
 *
 * SPLIT OUT of tests/e2e/perf.e2e.mts when JOS-57's scope addition (the stutter probe and the
 * cold-read delta) pushed that file past the repo's 400-code-line ceiling — a split, not a widened
 * threshold, and along a seam the spec already had: what stays there DRIVES A WINDOW, what lives
 * here READS A FILE. tests/e2e/buffRestartSteps.mts is the precedent for a spec's steps living in
 * a module beside it.
 *
 * IDENTITIES ONLY, never today's numbers: a launch is asserted to have STATED its measurements and
 * to have stated them consistently. How blocked, or how stuttery, one machine got is the bench's
 * question (npm run bench:replay) against a known log on one machine — never a spec's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, note } from './appHarness.mjs'
import {
  PERF_LAG_PROBE_INTERVAL_MS,
  STARTUP_STUTTER_INTERVAL_MS,
  STARTUP_STUTTER_LATE_MS
} from '../../src/shared/perf'

/**
 * The strictly-sequential head of the boot, asserted as a LIST: a profile whose phases arrived
 * in a different order would still be "monotonic" by timestamp alone, so the order is checked
 * as well as the timestamps.
 */
const SEQUENTIAL_PHASES = [
  'storeLoaded',
  'dataLoaded',
  'appReady',
  'protocols',
  'windowCreated',
  'tailAttached'
]
/** …and the tail, which RACES: the window paints while the historical scan is still folding, so
 *  either of these can land first depending on how much log there is. */
const CONCURRENT_PHASES = ['replayDone', 'rendererHydrated']

interface Phase {
  phase: string
  atMs: number
  durationMs: number
}
interface BlockStats {
  samples: number
  maxBlockMs: number
  blocksOver50Ms: number
}
/** What the duty-cycled replay spent, as the profile states it (JOS-50). */
interface ReplayStats {
  slices: number
  workMs: number
  restMs: number
}
/** The system-stutter proxy's own answer (JOS-57 scope addition), in milliseconds. */
interface StutterStats {
  samples: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  lateTicks: number
  latePct: number
}
interface Profile {
  startedAt: number
  version: string
  phases: Phase[]
  totalMs: number
  eventsReplayed?: number
  block?: BlockStats
  replay?: ReplayStats
  stutter?: StutterStats
  newBytes?: number
  firstMbMs?: number
  complete: boolean
}
/** THE FILE. Written on every launch, HUD or no HUD — this is the "the launch you wish you had
 *  profiled is the one that already happened" promise, asserted against real bytes. */
export function stepProfileFile(userData: string, firstRun: boolean): void {
  const path = join(userData, 'perf-startup.json')
  let profile: Profile | null = null
  try {
    profile = JSON.parse(readFileSync(path, 'utf8')) as Profile
  } catch (err) {
    check('every launch writes <userData>/perf-startup.json', false, String(err))
    return
  }
  if (!check('every launch writes <userData>/perf-startup.json', profile.phases.length > 0)) return

  const names = profile.phases.map((p) => p.phase)
  check(
    'it records the sequential half of the boot, in order',
    JSON.stringify(names.slice(0, SEQUENTIAL_PHASES.length)) === JSON.stringify(SEQUENTIAL_PHASES),
    names.join(' → ')
  )
  check(
    '…and both of the phases that race, in whichever order this launch produced',
    [...names.slice(SEQUENTIAL_PHASES.length)].sort().join(',') === [...CONCURRENT_PHASES].sort().join(','),
    names.slice(SEQUENTIAL_PHASES.length).join(' → ')
  )
  const marks = profile.phases.map((p) => p.atMs)
  check(
    'the phase marks are MONOTONIC — no phase lands before the one it follows',
    marks.every((at, i) => i === 0 || at >= (marks[i - 1] ?? 0)),
    marks.map((m) => Math.round(m)).join(', ')
  )
  const summed = profile.phases.reduce((n, p) => n + p.durationMs, 0)
  check(
    'the durations account for the whole launch, exactly (nothing is NaN or negative)',
    profile.phases.every((p) => Number.isFinite(p.durationMs) && p.durationMs >= 0) &&
      Math.abs(summed - profile.totalMs) < 1,
    `Σ ${String(Math.round(summed))}ms vs total ${String(Math.round(profile.totalMs))}ms`
  )
  check('…and states the launch it describes', profile.complete && profile.startedAt > 0, JSON.stringify({ complete: profile.complete, startedAt: profile.startedAt }))
  check(
    'the replay states how many events it folded, beside how long it took',
    typeof profile.eventsReplayed === 'number' && profile.eventsReplayed >= 0,
    `${String(profile.eventsReplayed)} events`
  )
  // THE PROBES GET THE PROBES' WINDOW, the duty ledger gets the replay's — see `probeWindowMs`.
  stepBlockProbe(profile.block, probeWindowMs(profile))
  stepReplayDuty(profile.replay, replayWindowMs(profile))
  stepStutterProbe(profile.stutter, probeWindowMs(profile))
  stepColdRead(profile, firstRun)
}

/**
 * COULD THE PROBE HAVE TICKED AT ALL? — the one question both probe steps have to answer before
 * they may assert anything, and the answer this file used to get wrong (JOS-279).
 *
 * Three verdicts rather than two, because a timer is not a stopwatch:
 *   'silent' — the window is shorter than one interval, so a tick is IMPOSSIBLE and stats would
 *     be a measurement nobody took (world-model law 1). The absence is the assertion.
 *   'either' — the window has only just passed the interval. The first tick was DUE inside it,
 *     but Windows' timer quantum is 15.625 ms and a timer may only ever fire late, so whether it
 *     landed before the window closed is the OS's business, not the app's. Both answers are
 *     honest here and the run says which it saw.
 *   'measured' — the window outlived the interval by more than that slack, so a probe that
 *     recorded nothing is a probe that never ran, which IS the regression these steps exist for.
 *
 * The grace is `STARTUP_STUTTER_LATE_MS` for both probes deliberately: it is this repo's own
 * measured answer to "how late may a tick be before it means anything" (shared/perf.ts), it is
 * comfortably past one quantum, and inventing a second such number here would be a spec
 * disagreeing with the code it tests.
 */
function probeVerdict(samples: number, windowMs: number, intervalMs: number): 'silent' | 'either' | 'measured' {
  if (windowMs < intervalMs) return 'silent'
  if (samples === 0 && windowMs < intervalMs + STARTUP_STUTTER_LATE_MS) return 'either'
  return 'measured'
}

/**
 * THE SYSTEM-STUTTER PROXY (JOS-57 scope addition), asserted exactly as its two neighbours are: as
 * IDENTITIES about a file a real launch wrote, never as this machine's numbers. Whether a computer
 * stutters is what the FLEET is being asked; what a spec can pin is that the launch measured its
 * own clock and that what it wrote about it is internally consistent.
 */
function stepStutterProbe(stutter: StutterStats | undefined, probeMs: number): void {
  // Same honesty rule the block probe follows: a per-spec fixture folds in milliseconds, and a
  // window that held no ticks must report NOTHING rather than a distribution of zeroes.
  const samples = stutter?.samples ?? 0
  const window = `probe window ${String(Math.round(probeMs))}ms vs ${String(STARTUP_STUTTER_INTERVAL_MS)}ms beat · ${String(samples)} ticks`
  const verdict = probeVerdict(samples, probeMs, STARTUP_STUTTER_INTERVAL_MS)
  if (verdict === 'silent') {
    check(
      'a probe window shorter than one heartbeat states NO drift figures rather than inventing them',
      samples === 0,
      window
    )
    return
  }
  if (verdict === 'either') {
    note(`the stutter probe's first beat was due inside a window this short — no ticks banked (${window})`)
    return
  }
  const ok = check(
    'the launch states what its own clock did while it read — the always-on stutter probe',
    samples > 0,
    stutter ? `${String(stutter.samples)} heartbeat ticks` : `absent · ${window}`
  )
  if (ok && stutter) stutterIdentities(stutter)
}

/** The stutter reading's internal consistency, once a window that HAD to hold ticks held some. */
function stutterIdentities(stutter: StutterStats): void {
  check(
    '…as an ordered distribution: p50 ≤ p95 ≤ the worst tick, none of them negative',
    stutter.p50Ms >= 0 && stutter.p50Ms <= stutter.p95Ms && stutter.p95Ms <= stutter.maxMs,
    `p50 ${String(stutter.p50Ms)}ms · p95 ${String(stutter.p95Ms)}ms · max ${String(stutter.maxMs)}ms`
  )
  check(
    '…and the late-tick rate is the count it came from, never a number beside it',
    stutter.lateTicks >= 0 &&
      stutter.lateTicks <= stutter.samples &&
      Math.abs(stutter.latePct - Math.round((stutter.lateTicks / stutter.samples) * 100)) < 1,
    `${String(stutter.lateTicks)}/${String(stutter.samples)} = ${String(stutter.latePct)}%`
  )
}

/**
 * THE COLD-READ HALF (JOS-57 scope addition) — and the assertion that matters is about the FIRST
 * launch, which is the one case a fleet reading could most easily fake.
 *
 * A fresh userData has no mark from a previous clean shutdown, so "how many bytes were new" has no
 * answer, and the profile must say nothing rather than 0. A SECOND launch against the same
 * userData is the other half of the loop and is asserted by the caller re-running this spec's
 * launch — see `main()`.
 */
function stepColdRead(profile: Profile, firstRun: boolean): void {
  if (firstRun) {
    check(
      'a first run reports NO cold-read delta — there is no previous clean exit to measure from',
      profile.newBytes === undefined,
      `newBytes ${String(profile.newBytes)}`
    )
  } else {
    check(
      'the SECOND launch reports one, because the first one left a mark on its way out',
      typeof profile.newBytes === 'number' && profile.newBytes >= 0,
      `newBytes ${String(profile.newBytes)}`
    )
  }
  // The cold-disk hint is only asked of a log at least a megabyte long, so its ABSENCE is correct
  // on a fixture and only its sanity can be pinned here.
  check(
    'the first-megabyte hint is a duration when it is there at all, never a negative or a NaN',
    profile.firstMbMs === undefined || (Number.isFinite(profile.firstMbMs) && profile.firstMbMs >= 0),
    `firstMbMs ${String(profile.firstMbMs)}`
  )
}

/**
 * How long the replay ACTUALLY ran: `replayDone` minus `tailAttached`, both absolute marks.
 *
 * NOT `replayDone.durationMs`, which is the gap to whatever mark PRECEDED it — and `replayDone`
 * races `rendererHydrated` (see CONCURRENT_PHASES). When the renderer wins that race the replay's
 * duration column is the sliver between the two, not the replay. MEASURED the hard way: the first
 * version of the check below used `durationMs`, passed solo, and failed under a full parallel run
 * as `93ms folding + 67ms resting ≤ 16ms replay` — the load reordered the race, and the assertion
 * had been reading a number that only looks like the one it wanted.
 */
function replayWindowMs(profile: Profile): number {
  const at = (phase: string): number => profile.phases.find((p) => p.phase === phase)?.atMs ?? 0
  return Math.max(0, at('replayDone') - at('tailAttached'))
}

/**
 * How long the two always-on PROBES actually ran: `appReady` minus `replayDone`. NOT the replay.
 *
 * THE FIVE-SIGHTING HEARTBEAT FLAKE (JOS-279, AGENTS.md's ledger) was this distinction, missing.
 * Both probes are opened by the `appReady` mark and closed by the `replayDone` one — one place,
 * `src/main/perf.ts markStartupPhase` — and `appReady` lands THREE phases before `tailAttached`
 * (protocols, windowCreated, tailAttached). So the window in which a beat could have ticked is
 * strictly LONGER than the fold, by however long it took to register the protocols and open a
 * window; measured on this machine that is a few tens of milliseconds, and the fixture folds in
 * ~120 ms. Gating "no ticks" on the fold therefore claimed a precondition the probe had never
 * been under: the run read `replay 118ms < 125ms beat`, believed no beat could have landed, and
 * failed on the tick the probe had legitimately banked ~40 ms before the replay even started.
 * Every one of the five sightings reads that way (115, 118, 118, 123 vs 125).
 *
 * The fix is not a tolerance — it is asking the question about the window that is actually being
 * measured. `stepReplayDuty` keeps `replayWindowMs`, because the duty ledger really is timed
 * across `tailAttached` → `replayDone` and nothing else.
 */
function probeWindowMs(profile: Profile): number {
  const at = (phase: string): number => profile.phases.find((p) => p.phase === phase)?.atMs ?? 0
  return Math.max(0, at('replayDone') - at('appReady'))
}

/**
 * THE DUTY LEDGER (JOS-50), asserted the same way and for the same reason as the block probe: as
 * IDENTITIES about a file a real launch wrote, never as this machine's numbers.
 *
 * What a spec can honestly claim here is that the launch STATED its duty and that the statement is
 * internally consistent — work and rest are non-negative, they fit inside the phase they describe,
 * and a fold that yielded at all did not somehow rest a negative amount. Whether 60% was actually
 * held on a 100 MB log is the bench's budget, on one machine, against a known input.
 */
function stepReplayDuty(replay: ReplayStats | undefined, windowMs: number): void {
  const ok = check(
    'the launch states how the replay split its time between folding and resting',
    replay !== undefined,
    replay ? `${String(replay.slices)} slices` : 'absent'
  )
  if (!ok || !replay) return
  const sane =
    Number.isFinite(replay.workMs) &&
    Number.isFinite(replay.restMs) &&
    replay.workMs >= 0 &&
    replay.restMs >= 0 &&
    Number.isInteger(replay.slices) &&
    replay.slices >= 0
  check(
    '…and the two of them fit inside the window they describe (nothing invented, nothing negative)',
    // +1 ms of slack: the marks are rounded to a tenth and the ledger is timed inside them.
    sane && replay.workMs + replay.restMs <= windowMs + 1,
    `${String(Math.round(replay.workMs))}ms folding + ${String(Math.round(replay.restMs))}ms resting ≤ ${String(Math.round(windowMs))}ms tailAttached→replayDone`
  )
  check(
    'a replay that never yielded never rested either — a rest without a slice would be fiction',
    replay.slices > 0 || replay.restMs === 0,
    `${String(replay.slices)} slices · ${String(Math.round(replay.restMs))}ms rest`
  )
}

/**
 * THE ALWAYS-ON BLOCK PROBE (docs/plans/chunked-replay.md §2), asserted additively beside the
 * phases it shares a file with. Unlike the HUD's probe this one is not opt-in and has no switch to
 * forget, so its absence from a real boot IS the regression. Identities only: how blocked this
 * particular machine got is not something a spec can assert — the bench (`npm run bench:replay`)
 * owns that budget, against a known log, on one machine.
 */
function stepBlockProbe(block: BlockStats | undefined, probeMs: number): void {
  // THE PROBE'S WINDOW IS `appReady` → `replayDone` (never the replay alone — see
  // `probeWindowMs`), and it ticks on a 500 ms interval. A per-spec fixture folds in single-digit
  // milliseconds (wave E2), so a launch against one legitimately produces ZERO samples — and a
  // profile that then stated `maxBlockMs: 0` would be inventing a measurement nobody took
  // (world-model law 1). So the presence of the stats is asserted only when the window actually
  // outlived a tick; below that, their absence is the correct answer and the run says so. The
  // BUDGET on those numbers was never this spec's anyway: `npm run bench:replay` owns it, against
  // a ~100 MB log, on one machine.
  const samples = block?.samples ?? 0
  const window = `probe window ${String(Math.round(probeMs))}ms vs ${String(PERF_LAG_PROBE_INTERVAL_MS)}ms tick · ${String(samples)} samples`
  const verdict = probeVerdict(samples, probeMs, PERF_LAG_PROBE_INTERVAL_MS)
  if (verdict === 'silent') {
    check(
      'a probe window shorter than one probe tick states NO block figures rather than inventing zeroes',
      samples === 0,
      window
    )
    return
  }
  if (verdict === 'either') {
    note(`the block probe's first tick was due inside a window this short — no samples banked (${window})`)
    return
  }
  const ok = check(
    'the launch also states how blocked the main loop got — the always-on startup probe',
    samples > 0,
    block ? `${String(block.samples)} probe ticks` : `absent · ${window}`
  )
  if (ok && block) blockIdentities(block)
}

/** The block reading's internal consistency, once a window that HAD to hold ticks held some. */
function blockIdentities(block: BlockStats): void {
  const sane =
    Number.isFinite(block.maxBlockMs) && block.maxBlockMs >= 0 && Number.isInteger(block.blocksOver50Ms)
  check(
    '…as a worst single stall and a count of the ones past the HUD’s own warn threshold',
    sane && block.blocksOver50Ms >= 0 && block.blocksOver50Ms <= block.samples,
    `max ${String(block.maxBlockMs)}ms · ${String(block.blocksOver50Ms)}/${String(block.samples)} over 50ms`
  )
}

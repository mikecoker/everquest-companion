/**
 * startupDiscriminators.test.mts — the two facts JOS-57's scope addition put on the startup
 * reading (owner, 2026-08-11), from the probe that measures them to the counters that store them.
 *
 * WHY THEY EXIST, because the tests below only make sense against the question: every number the
 * fleet startup reading carried before this scaled with the WHOLE log, and the first-start-stutter
 * report (…8QQC) describes a launch that is slow for reasons a whole-log number cannot see. So the
 * reading gained the two discriminators that separate in-process cost from system pressure:
 *
 *   * NEW BYTES SINCE THE LAST CLEAN SHUTDOWN — how much of the read was pages nobody had touched,
 *     which is what the on-access-virus-scanner hypothesis actually predicts on;
 *   * THE SYSTEM-STUTTER PROXY — the drift of a fixed heartbeat across the same fold, which spikes
 *     when the MACHINE stutters even though our own worst block stays small;
 *   * and the cold-disk hint beside them, time to the first megabyte.
 *
 * A SEPARATE FILE for the reason `usageStartup.test.mts` is one: both `tests/perf.test.mts` and
 * `tests/telemetryProducers.test.mts` sit at the repo's 400-code-line ceiling, and a split by
 * SUBJECT is the answer to that rather than a widened threshold. What is NOT here is the read
 * half — the digest and the tab — which lives in `usageStartup.test.mts` beside the sections it
 * renders.
 *
 * Pure: no Electron, no clock, no network, so it never skips.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProfile,
  foldStutterSamples,
  STARTUP_STUTTER_INTERVAL_MS,
  STARTUP_STUTTER_LATE_MS,
  STARTUP_STUTTER_MIN_SAMPLES,
  parseStartupProfile,
  STARTUP_PHASES,
  type StartupMark
} from '../src/shared/perf'
import {
  bucketOf,
  NEW_BYTES_EDGES,
  STUTTER_MS_EDGES,
  type TelemetryBatch,
  type TelemetryEvent
} from '../src/shared/telemetry'
import { startupReplayStats, type StartupReplayInput } from '../src/shared/telemetryStartup'
import { newBytesSince } from '../src/main/log/coldRead'
import { validateTelemetryEvent } from '../src/shared/telemetryValidate'
import { rollupBatch, BLOCK_MS_EDGES, USAGE_METRICS } from '../src/shared/telemetryRollup'

// ---- the probe ---------------------------------------------------------------------------

test('the stutter probe folds a DISTRIBUTION, and its cadence is chosen against the timer quantum', () => {
  // 125 ms is eight of Windows' 15.625 ms quanta. That is the whole reason it is not 100: a timer
  // ends at the next tick edge (AGENTS.md's measured law), so an interval that is not a multiple
  // of the quantum reports a constant baseline drift on a perfectly healthy machine, and the two
  // lowest buckets would be spent before any real stutter arrived.
  assert.equal(STARTUP_STUTTER_INTERVAL_MS % 15.625, 0)
  // "Late" sits past one quantum, so a tick that merely landed on the next edge is not a stutter.
  assert.ok(STARTUP_STUTTER_LATE_MS > 15.625)

  const s = foldStutterSamples([1, 1, 2, 2, 3, 40, 4, 2, 1, 90])
  assert.equal(s.samples, 10)
  assert.equal(s.p50Ms, 2)
  assert.equal(s.p95Ms, 90, 'nearest-rank: the p95 of ten samples is the tenth')
  assert.equal(s.maxMs, 90)
  assert.equal(s.lateTicks, 2, 'the 40 ms and the 90 ms ticks; nothing under the threshold')
  assert.equal(s.latePct, 20)

  // AT the threshold counts, just under it does not — a boundary asserted rather than assumed.
  assert.equal(foldStutterSamples([STARTUP_STUTTER_LATE_MS]).lateTicks, 1)
  assert.equal(foldStutterSamples([STARTUP_STUTTER_LATE_MS - 0.001]).lateTicks, 0)

  // A window that held no ticks reports zeros BESIDE `samples: 0` — nothing measured is not a
  // smooth launch, and `samples` is the only thing that can tell a reader which one it is.
  assert.deepEqual(foldStutterSamples([]), {
    samples: 0,
    p50Ms: 0,
    p95Ms: 0,
    maxMs: 0,
    lateTicks: 0,
    latePct: 0
  })
  // A C++ boundary and scheduling noise both exist: junk is dropped, negatives clamp.
  assert.equal(foldStutterSamples([NaN, Infinity, -3, 8]).samples, 2)
})

/** Every phase, 100 ms apart — a complete launch, for the profile assertions below. */
function fullChain(): StartupMark[] {
  return STARTUP_PHASES.map((phase, i) => ({ phase, atMs: (i + 1) * 100 }))
}

test('the local profile states all three, raw — and omits each one it did not measure', () => {
  const stutter = { samples: 48, p50Ms: 1, p95Ms: 62, maxMs: 300, lateTicks: 5, latePct: 10 }
  const profile = buildProfile(fullChain(), {
    startedAt: 1,
    version: '0.8.0',
    stutter,
    newBytes: 4_194_304,
    firstMbMs: 812.44
  })
  assert.deepEqual(profile.stutter, stutter)
  // RAW bytes on disk, deliberately: this file describes the user's own launch to the user, and
  // the bucketing exists to stop a fingerprint leaving the machine — not to stop them reading it.
  assert.equal(profile.newBytes, 4_194_304)
  assert.equal(profile.firstMbMs, 812.4)

  const unmeasured = buildProfile(fullChain(), { startedAt: 1, version: '0.8.0' })
  assert.equal(unmeasured.newBytes, undefined, 'no mark to compare against is not zero new bytes')
  assert.equal(unmeasured.stutter, undefined)
  assert.equal(unmeasured.firstMbMs, undefined)

  // Read back off disk: all six stutter fields or none, the rule its two neighbours already keep.
  const round = parseStartupProfile(JSON.parse(JSON.stringify(profile)) as unknown)
  assert.deepEqual(round?.stutter, stutter)
  assert.equal(round?.newBytes, 4_194_304)
  const half = { ...profile, stutter: { samples: 3, p50Ms: 1 } }
  assert.equal(parseStartupProfile(JSON.parse(JSON.stringify(half)) as unknown)?.stutter, undefined)
  // …and a profile written before any of this existed simply reports none of it.
  const old = { ...profile, stutter: undefined, newBytes: undefined, firstMbMs: undefined }
  const parsed = parseStartupProfile(JSON.parse(JSON.stringify(old)) as unknown)
  assert.equal(parsed?.newBytes, undefined)
  assert.equal(parsed?.firstMbMs, undefined)
})

// ---- the delta rule ----------------------------------------------------------------------

test('the cold-read delta REFUSES the two questions it cannot answer', () => {
  // The ordinary case: an evening of play appended 2 MB while the app was closed, and this launch
  // read all of them off a disk that has not seen them since.
  assert.equal(newBytesSince({ offset: 68_000_000 }, 70_097_152), 2_097_152)
  // A launch that read nothing new is a real, measured ZERO — the app was reopened immediately.
  assert.equal(newBytesSince({ offset: 70_097_152 }, 70_097_152), 0)

  // NO MARK — a first run, or the launch after a crash. Nothing to measure from, so nothing is
  // claimed. This is the one that must never become 0: it would say the launch had nothing new to
  // read, which on a fresh install is the exact opposite of the truth.
  assert.equal(newBytesSince(undefined, 70_097_152), undefined)
  // A MARK PAST THE END — the log rotated or was truncated under it. The fold read the WHOLE file,
  // which the reading already states as its size; a clamped 0 here would contradict it.
  assert.equal(newBytesSince({ offset: 90_000_000 }, 70_097_152), undefined)
  // A store somebody hand-edited is the second door, not the only one.
  assert.equal(newBytesSince({ offset: NaN }, 10), undefined)
  assert.equal(newBytesSince({ offset: 1 }, NaN), undefined)
})

// ---- the producer ------------------------------------------------------------------------

/** The six original inputs, so each test below can vary exactly the one field it is about. */
const BASE: StartupReplayInput = {
  replayMs: 6_000,
  eventsReplayed: 400_000,
  workMs: 4_000,
  restMs: 2_000,
  maxBlockMs: 40,
  blocksOver50: 0,
  logBytes: 71_000_000
}

test('a byte DELTA becomes a bucket, and "no mark" stays absent rather than becoming zero', () => {
  const bucketFor = (newBytes: number): number | undefined =>
    startupReplayStats({ ...BASE, newBytes }).newBytesBucket

  // Half-open `[lo, hi)` on its own ladder — the log-size edges would report almost every evening
  // of play as bucket 0, which is why this measurement has its own.
  assert.equal(bucketFor(0), 0)
  for (const [i, edge] of NEW_BYTES_EDGES.entries()) {
    assert.equal(bucketFor(edge), i + 1, `${String(edge)} opens bucket ${String(i + 1)}`)
    assert.equal(bucketFor(edge - 1), i, `${String(edge - 1)} is still bucket ${String(i)}`)
  }
  assert.equal(bucketFor(9_000_000_000), NEW_BYTES_EDGES.length, 'the top bucket is open')

  // THE ABSENCES, which are the point of the field: a launch with no previous clean shutdown to
  // compare against, and one whose log ROTATED under the mark, both report NOTHING. A zero there
  // would be the only number in this reading that states a fact nobody measured.
  assert.ok(!('newBytesBucket' in startupReplayStats(BASE)))
  assert.ok(!('newBytesBucket' in startupReplayStats({ ...BASE, newBytes: -12 })))
  assert.ok(!('newBytesBucket' in startupReplayStats({ ...BASE, newBytes: NaN })))
})

test('the stutter reading is BUILT into buckets, and the first-MB hint rides as a duration', () => {
  const s = startupReplayStats({
    ...BASE,
    stutter: { p50Ms: 1.4, p95Ms: 62, latePct: 17 },
    firstMbMs: 812.6
  })
  assert.deepEqual(s.stutter, {
    p50Bucket: bucketOf(1, STUTTER_MS_EDGES),
    p95Bucket: bucketOf(62, STUTTER_MS_EDGES),
    latePct: 17
  })
  assert.equal(s.stutter?.p50Bucket, 0, '1 ms is under the first edge — a healthy machine')
  assert.equal(s.stutter?.p95Bucket, 5, '62 ms is the 50-100 ms bucket — the tail that matters')
  // A duration, not a bucket: the SERVER decides how coarsely to remember it (the same division of
  // labour `replayMs` keeps), so the client sends the millisecond it measured.
  assert.equal(s.firstMbMs, 813)
  // A rate that came back over 100 is a broken clock, and is clamped to what the schema allows so
  // that a producer can never build an event its own validator would refuse.
  assert.equal(startupReplayStats({ ...BASE, stutter: { p50Ms: 1, p95Ms: 2, latePct: 900 } }).stutter?.latePct, 100)
  // …and the original six are untouched by any of it.
  assert.equal(s.replayMs, 6_000)
  assert.equal(s.dutyPct, 67)
})

// ---- the validator -----------------------------------------------------------------------

/** The six fields as they appear on the wire — the base every case below layers onto. */
const WIRE = {
  replayMs: 6_000,
  eventsReplayed: 400_000,
  dutyPct: 67,
  maxBlockMs: 40,
  blocksOver50: 0,
  logSizeBucket: 2
}

const startupOf = (over: Record<string, unknown>): Record<string, unknown> | undefined => {
  const res = validateTelemetryEvent({ t: 'sessionHeartbeat', uptimeMs: 1, startup: { ...WIRE, ...over } })
  assert.ok(res.ok && res.value.t === 'sessionHeartbeat')
  return res.value.startup as unknown as Record<string, unknown> | undefined
}

test('each new field is INDEPENDENTLY optional — which is what makes the client safe to ship first', () => {
  // THE DEPLOY-SKEW ARGUMENT, mechanically: the ingest Lambda is deployed by hand and the app
  // updates itself, so a shipped client regularly talks to an older copy of this contract. A new
  // optional FIELD is free (the validator constructs its result field by field, so an older server
  // drops it and accepts the batch); a new EVENT KIND would fail the whole batch. These three took
  // the first deal, and the assertion is that each of them survives its neighbours being absent.
  assert.equal(startupOf({})?.newBytesBucket, undefined)
  assert.equal(startupOf({ newBytesBucket: 3 })?.newBytesBucket, 3)
  assert.equal(startupOf({ firstMbMs: 812 })?.firstMbMs, 812)
  assert.deepEqual(startupOf({ stutter: { p50Bucket: 0, p95Bucket: 5, latePct: 17 } })?.stutter, {
    p50Bucket: 0,
    p95Bucket: 5,
    latePct: 17
  })
  // Null reads as absent, exactly as it does for `linesParsed` and for the group as a whole.
  assert.equal(startupOf({ newBytesBucket: null, stutter: null, firstMbMs: null })?.stutter, undefined)
  // The six still arrive unchanged with all three present — nothing here rewrites the reading.
  assert.equal(startupOf({ newBytesBucket: 3, firstMbMs: 1 })?.replayMs, 6_000)
})

test('the stutter trio is ALL THREE OR NONE, and every new field refuses a value out of range', () => {
  const bad = (over: Record<string, unknown>, field: string): void => {
    const res = validateTelemetryEvent({
      t: 'sessionEnd',
      durationMs: 1,
      viewsVisited: 0,
      startup: { ...WIRE, ...over }
    })
    assert.ok(!res.ok, `${field} must be refused`)
    assert.equal(res.field, field)
  }
  // A percentile with no companion percentile cannot say whether the distribution moved or only
  // its tail — which is the entire reason a distribution is measured instead of a maximum.
  bad({ stutter: { p95Bucket: 5, latePct: 1 } }, 'startup.stutter.p50Bucket')
  bad({ stutter: { p50Bucket: 0, latePct: 1 } }, 'startup.stutter.p95Bucket')
  bad({ stutter: { p50Bucket: 0, p95Bucket: 5 } }, 'startup.stutter.latePct')
  bad({ stutter: 7 }, 'startup.stutter')
  // A BUCKET INDEX, never a raw value dressed up as one: the ladder has eight buckets, so eight is
  // the largest legal index and a millisecond count in that slot is refused.
  bad({ stutter: { p50Bucket: 0, p95Bucket: 62, latePct: 1 } }, 'startup.stutter.p95Bucket')
  bad({ stutter: { p50Bucket: 0, p95Bucket: 5, latePct: 101 } }, 'startup.stutter.latePct')
  bad({ newBytesBucket: 4_194_304 }, 'startup.newBytesBucket')
  bad({ newBytesBucket: -1 }, 'startup.newBytesBucket')
  bad({ firstMbMs: -1 }, 'startup.firstMbMs')

  // …and nothing outside the schema survives the trip, however it is spelled — the same negative
  // assertion the six fields have carried since JOS-57, now over a NESTED object.
  const extra = startupOf({
    stutter: { p50Bucket: 0, p95Bucket: 5, latePct: 1, logPath: 'C:/Users/x/eqlog.txt' },
    charName: 'Primitive'
  })
  assert.ok(!('charName' in (extra ?? {})))
  assert.ok(!('logPath' in ((extra?.stutter ?? {}) as Record<string, unknown>)))
})

// ---- the rollup --------------------------------------------------------------------------

const batchOf = (events: TelemetryEvent[]): TelemetryBatch => ({
  v: 1,
  env: {
    analyticsId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    appVersion: '0.8.0',
    channel: 'prod',
    platform: 'win32',
    tzOffsetBucket: -7
  },
  events: events.map((ev) => ({ ts: 1, ev }))
})

test('the new counters are written per build, and a reading without them writes none of them', () => {
  const full = {
    ...WIRE,
    newBytesBucket: 3,
    stutter: { p50Bucket: 0, p95Bucket: 5, latePct: 17 },
    firstMbMs: 812
  }
  const rolled = rollupBatch(
    batchOf([
      { t: 'sessionEnd', durationMs: 60_000, viewsVisited: 1, startup: full } as TelemetryEvent,
      { t: 'sessionEnd', durationMs: 60_000, viewsVisited: 1, startup: full } as TelemetryEvent
    ]),
    { firstOfDay: false, newInstall: false, upgraded: false }
  )
  const rowOf = (metric: string, dim: string): number =>
    rolled.counters.find((c) => c.metric === metric && c.dim === dim)?.n ?? 0

  // NOT versioned — how much a player's log grew between two launches is a fact about the player's
  // evening, exactly as its size is a fact about the player. It reads beside `startupLogSize`.
  assert.equal(rowOf(USAGE_METRICS.startupNewBytes, '3'), 2)
  // Versioned — "did the build we shipped get out of the machine's way" is a comparison.
  assert.equal(rowOf(USAGE_METRICS.startupStutterP50, '0.8.0:0'), 2)
  assert.equal(rowOf(USAGE_METRICS.startupStutterP95, '0.8.0:5'), 2)
  assert.equal(rowOf(USAGE_METRICS.startupStutterLatePct, '0.8.0'), 34)
  // The cold-disk hint borrows the BLOCK ladder: 812 ms is its 500-1000 ms bucket.
  assert.equal(
    rowOf(USAGE_METRICS.startupFirstMbMs, `0.8.0:${String(bucketOf(812, BLOCK_MS_EDGES))}`),
    2
  )
  // THE HISTOGRAM IS ITS OWN DENOMINATOR, which is why no `startupStutters` counter exists: one
  // row per launch that measured one, always written, even for a launch whose `latePct` was 0 and
  // whose summed row `add()` therefore refuses.
  assert.equal(rowOf(USAGE_METRICS.startupStutterP95, '0.8.0:5'), rowOf(USAGE_METRICS.startupReplays, '0.8.0'))

  // A reading carrying only the original six writes only the original six rows: an OLD client
  // talking to a NEW server is a non-event, and the new metrics stay absent rather than zero.
  const old = rollupBatch(
    batchOf([{ t: 'sessionHeartbeat', uptimeMs: 1, startup: WIRE } as TelemetryEvent]),
    { firstOfDay: false, newInstall: false, upgraded: false }
  )
  assert.equal(old.counters.some((c) => c.metric.startsWith('startupStutter')), false)
  assert.equal(old.counters.some((c) => c.metric === USAGE_METRICS.startupNewBytes), false)
  assert.equal(old.counters.some((c) => c.metric === USAGE_METRICS.startupFirstMbMs), false)
  assert.equal(old.counters.some((c) => c.metric === USAGE_METRICS.startupReplays), true)
})

test('a fold too short to describe reports NO stutter reading — the minimum is a stated number', () => {
  // The client-side rule lives in `src/main/perf.ts` (`stutterReading`), and what this pins is the
  // constant it rests on: 20 ticks at 125 ms is 2.5 s of folding. A p95 over four samples is the
  // largest of four numbers wearing a statistic's name, and the wire has no `samples` field to
  // qualify it with — so a reading that arrives has to be one that can stand alone.
  assert.ok(STARTUP_STUTTER_MIN_SAMPLES >= 20)
  assert.ok(STARTUP_STUTTER_MIN_SAMPLES * STARTUP_STUTTER_INTERVAL_MS >= 2_500)
})

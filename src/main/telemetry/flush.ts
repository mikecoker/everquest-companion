// telemetry/flush.ts — the session lifecycle and the flush loop that now actually sends.
//
// TWO TIMERS, and they answer different questions, which is why they are not one:
//
//   * THE HEARTBEAT (5 min) is COLLECTION. It records `sessionHeartbeat` into the local ring so
//     "how long do sessions actually last" survives a process that is killed rather than closed
//     — a `sessionEnd` that never fires is exactly the data point you most want. It runs
//     whenever the user's switch is on, endpoint or no endpoint, because nothing it does leaves
//     the machine.
//
//   * THE FLUSH (60 s) is NETWORK. It starts only when `telemetryFlushEnabled` says so: not
//     under e2e, not without an endpoint, not with the switch off, and NOT BEFORE THE FIRST-RUN
//     NOTICE HAS RENDERED. Same discipline as `startQueueFlush` — one predicate (net.ts),
//     shared by the starter and the worker, because two copies of a network gate is how one of
//     them drifts.
//
// Both timers are `unref`'d, so neither can be the reason the process stays alive.
//
// WIRED INTO STARTUP from `src/main/index.ts` (the composition root), immediately beside
// `startQueueFlush()`, and stopped from `window-all-closed` beside `stopQueueFlush()`.

import { E2E } from '../e2e'
import { logInfo } from '../errorLog'
import {
  bucketOf,
  COLD_START_MS_EDGES,
  type StartupReplayStats,
  type TelemetryBatch,
  type TelemetryPrefs
} from '../../shared/telemetry'
import {
  TELEMETRY_API_URL,
  postTelemetryBatch,
  telemetryCollectEnabled,
  telemetryFlushEnabled,
  telemetryPermanentRefusal
} from './net'
import {
  beginSession,
  endSession,
  ensureAnalyticsId,
  markNoticeShown,
  pendingBatch,
  recordEvent,
  sessionUptimeMs,
  setTelemetryEnabled,
  takeLinesParsed,
  takeStartupReplay,
  viewsVisited
} from './collector'
import { markFunnelStep } from './funnels'
import { takeHealth } from './health'
import { readRing, writeRing } from './ring'
import { getTelemetryPrefs } from '../store'

/** Batch cadence. Counts, not click streams — 60 s is the plan's number (T5). */
export const FLUSH_INTERVAL_MS = 60 * 1000
/** Session heartbeat cadence (T5): the "is anyone using it right now" pulse. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000

/**
 * Send the batch this tick has to send, and return it once the server has ACCEPTED it (null
 * for every other outcome — gate shut, nothing buffered, refused, or never answered).
 *
 * The gate is re-read here rather than trusted from `startTimers`: the switch can go off, and
 * the notice can be answered, between one tick and the next.
 */
export async function flushTelemetry(): Promise<TelemetryBatch | null> {
  if (!telemetryFlushEnabled(E2E, TELEMETRY_API_URL, getTelemetryPrefs())) return null
  const batch = pendingBatch()
  if (batch === null) return null
  const { status } = await postTelemetryBatch(batch)
  const accepted = status >= 200 && status < 300
  // "Not now" (0 offline, 429 daily cap, 503 kill switch) keeps the buffer for the next tick.
  if (!accepted && !telemetryPermanentRefusal(status)) return null
  return retireBatch(batch, accepted)
}

/**
 * Take the sent records out of the ring, and remember the batch for the Preferences viewer.
 *
 * OPT-OUT WINS A RACE WITH THE WIRE. The user can press the switch while a POST is in flight,
 * and `setTelemetryEnabled(false)` drops the ring and the id; writing the ring back here would
 * RESURRECT the file — with the batch they just opted out of sitting in it as `lastBatch`. So
 * the switch is re-read after the await and an opted-out install is left exactly as it is.
 *
 * The retire is `slice(n)` from the FRONT, which is right because records are appended at the
 * back and the batch is always the whole ring as it was read. The one imprecise case is a ring
 * that hit its cap mid-flight: the cap drops from the front too, so a few unsent records can go
 * with the sent ones. Losing a handful of counters is the documented cost of this feature; the
 * alternative (matching records by identity) buys nothing a counter feed can spend.
 */
function retireBatch(batch: TelemetryBatch, accepted: boolean): TelemetryBatch | null {
  if (!telemetryCollectEnabled(getTelemetryPrefs())) return null
  const ring = readRing()
  writeRing({
    ...ring,
    events: ring.events.slice(batch.events.length),
    lastBatch: accepted ? batch : ring.lastBatch
  })
  return accepted ? batch : null
}

/**
 * The optional `startup` field, spread into whichever session report drains it — `{}` when there
 * is nothing to report, so the property is ABSENT rather than `undefined`. That matters twice: the
 * validator's `startup === undefined` arm and JSON's own omission both mean "no reading", and an
 * explicit `startup: undefined` key would be a third spelling of it in the payload viewer.
 */
function startupField(): { startup?: StartupReplayStats } {
  const startup = takeStartupReplay()
  return startup === undefined ? {} : { startup }
}

/**
 * DRAIN THE HEALTH COUNTERS ONTO A SESSION REPORT (JOS-96), beside the two drains above and for
 * the same reason: whichever of `sessionHeartbeat` / `sessionEnd` fires first takes them, so a
 * session that does both reports each error exactly once and a killed session loses at most its
 * last window.
 *
 * IT IS RECORDED EVEN WHEN EVERYTHING IS ZERO, and that is the decision the whole readout rests
 * on. `healthCounters` is dimmed by VERSION in the rollup, so the report itself — not the errors
 * in it — is what says "a client on this build is capable of reporting". Emitting only on a bad
 * session would make a healthy build look exactly like a build that predates this code, and the
 * panel could never honestly separate "no errors" from "no data". The cost is one extra ring
 * record per five minutes, which is nothing; the alternative costs the question its answer.
 *
 * It is a SEPARATE `recordEvent` rather than a field on the session event because `healthCounters`
 * is an existing kind in the shipped contract — the ingest Lambda already validates it — so this
 * needs no wire change at all, and the deploy-skew rule (shared/telemetry.ts) is satisfied without
 * an additive field. An older Lambda accepts the batch and folds it under the OLD dims; it never
 * 400s, so nothing is ever dropped while the deploys are out of step.
 */
function reportHealth(): void {
  recordEvent({ t: 'healthCounters', ...takeHealth() })
}

let heartbeat: ReturnType<typeof setInterval> | null = null
let flushTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start collection for this session. Idempotent.
 *
 * `coldStartMs` is how long the app took to become usable — measured by the caller (the
 * composition root knows when the process began and when the window was created; this module
 * does not) and bucketed here so the raw millisecond never enters the ring.
 */
export function startTelemetry(coldStartMs: number): void {
  if (heartbeat !== null) return
  const prefs = getTelemetryPrefs()
  if (!prefs.enabled) return
  ensureAnalyticsId()
  beginSession()
  recordEvent({ t: 'sessionStart', coldStartMsBucket: bucketOf(coldStartMs, COLD_START_MS_EDGES) })
  // THE FIRST-RUN FUNNEL'S STEP 1, and it is a launch rather than the id-minting call that
  // produces it: `ensureAnalyticsId` mints again after a rotation or an off/on, and each of those
  // would otherwise look like a fresh installation. The once-ever mark (funnels.ts) is what makes
  // this the FIRST launch of this install, and it survives both of those events.
  markFunnelStep('first-run', 'installed')
  startTimers(prefs)
}

/** Both timers, once the decision to run them has been made. */
function startTimers(prefs: TelemetryPrefs): void {
  heartbeat = setInterval(() => {
    // The heartbeat is also what DRAINS the parsed-line delta (collector.ts): the counter is
    // reported by the same event that proves the session was still alive to do the parsing, so a
    // killed process loses at most the last five minutes of it.
    recordEvent({
      t: 'sessionHeartbeat',
      uptimeMs: sessionUptimeMs(),
      linesParsed: takeLinesParsed(),
      // …and this launch's startup replay, on the first heartbeat after it finished (JOS-57).
      // Drained, so exactly one report carries it: one launch is one reading.
      ...startupField()
    })
    reportHealth()
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()
  ensureFlushTimer(prefs)
}

/**
 * The network half, started only when the gate is open — and startable LATER IN THE SAME
 * SESSION, which is the whole reason it is its own function.
 *
 * On a first run the app starts with `noticeShown: false`, so the gate is shut when
 * `startTimers` runs; it opens a few seconds later when the notice renders and is answered.
 * Before this existed, that first session collected but never sent, and the counters only began
 * to move on the NEXT launch — a silent off-by-one-session in every install's first day.
 *
 * A timer that can only ever no-op is still not created (the `startQueueFlush` precedent).
 */
function ensureFlushTimer(prefs: TelemetryPrefs): void {
  if (flushTimer !== null) return
  if (!telemetryFlushEnabled(E2E, TELEMETRY_API_URL, prefs)) return
  flushTimer = setInterval(() => {
    void flushTelemetry()
  }, FLUSH_INTERVAL_MS)
  flushTimer.unref()
  logInfo('[everquest-companion] telemetry: flush loop started')
}

function clearTimers(): void {
  if (heartbeat !== null) clearInterval(heartbeat)
  if (flushTimer !== null) clearInterval(flushTimer)
  heartbeat = null
  flushTimer = null
}

/**
 * The user switched it ON from Preferences, part-way through a session that started with it
 * off. Starts the session and its timers — but records NO `sessionStart`, deliberately: this
 * session began before collection did, and there is no honest cold-start figure for it. A
 * bucketed guess would be indistinguishable from a measurement in the aggregate, which is
 * exactly the kind of number world-model law 1 exists to refuse.
 *
 * (The e2e spec is what found this: enabling from the pane used to leave the heartbeat dead
 * until the next launch, so a session the user had explicitly opted into produced view dwells
 * but no session at all.)
 */
export function resumeTelemetry(): void {
  const prefs = getTelemetryPrefs()
  if (!prefs.enabled) return
  if (heartbeat !== null) {
    // Already collecting — this call came from the first-run notice being answered, which is
    // the moment the NETWORK gate opens for a session that is already under way.
    ensureFlushTimer(prefs)
    return
  }
  beginSession()
  startTimers(prefs)
}

/** The user switched it OFF mid-session. Stops the timers WITHOUT a `sessionEnd` — a session
 *  they opted out of is not a session we get to write a closing record for. */
export function pauseTelemetry(): void {
  clearTimers()
  endSession()
}

/**
 * Apply the switch AND bring this session's timers into line with it. The one place both the
 * Preferences toggle and the first-run notice go through, so the two can never diverge.
 */
export function applyTelemetryEnabled(enabled: boolean): TelemetryPrefs {
  const next = setTelemetryEnabled(enabled)
  if (next.enabled) resumeTelemetry()
  else pauseTelemetry()
  return next
}

/** The first-run notice was answered (or dismissed, which keeps it on — T1). */
export function answerNotice(keepEnabled: boolean): TelemetryPrefs {
  markNoticeShown()
  return applyTelemetryEnabled(keepEnabled)
}

/** Close the session: record `sessionEnd`, stop both timers. Safe to call more than once. */
export function stopTelemetry(): void {
  const uptime = sessionUptimeMs()
  if (uptime > 0) {
    recordEvent({
      t: 'sessionEnd',
      durationMs: uptime,
      viewsVisited: viewsVisited(),
      // The tail of the line delta: everything parsed since the last heartbeat. Without it every
      // session under five minutes would report zero lines, and short sessions are common.
      linesParsed: takeLinesParsed(),
      // …and the startup reading, if no heartbeat got there first — which is the common case,
      // since most sessions end before the five-minute mark.
      ...startupField()
    })
    // The tail of the health deltas, on the same terms as the line delta beside it. Inside the
    // `uptime > 0` guard deliberately: a process that never started collecting has no session to
    // report the health OF, and a bare `healthReports` row from it would inflate the denominator
    // every rate on the panel is divided by.
    reportHealth()
  }
  clearTimers()
  endSession()
}

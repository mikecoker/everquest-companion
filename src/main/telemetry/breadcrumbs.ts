// ============================================================================
// telemetry/breadcrumbs.ts — the last ten parser event KINDS, and nothing else (JOS-100).
// ============================================================================
//
// An error report says WHAT broke. A breadcrumb ring says WHAT THE APP WAS DOING when it did,
// which is the difference between "a TypeError in foldEvent" and "a TypeError in foldEvent,
// three damage lines after a zone change". That second sentence is a bug someone can reproduce.
//
// IT IMPORTS NOTHING, exactly like `./health.ts`, and for a stricter version of the same reason.
// health.ts is a leaf so `errorLog.ts` can bump a counter without closing a cycle; this file is
// a leaf so it can be called from `LogBus.emit` — the hottest function in the process — without
// dragging the store, the collector or Electron into that call stack.
//
// ---------------------------------------------------------------------------------------
// THE PERFORMANCE LAW, AND HOW THIS OBEYS IT
// ---------------------------------------------------------------------------------------
// `linesPending` (collector.ts) is a plain integer add because it fires once per parsed line,
// and the startup replay folds 1.35M of them. This fires on the same path. So:
//
//   * ZERO ALLOCATION PER EVENT. Two preallocated arrays of fixed length and a cursor. A push
//     is three slot writes and a modulo. Nothing is created, nothing is copied, and the ring
//     never grows, so it cannot make garbage for a GC to collect mid-replay.
//   * NO CLOCK READ PER EVENT. This is the decision worth reading twice. `Date.now()` per event
//     would be ~1.35M syscall-ish reads during a replay to produce offsets nobody would look at
//     unless the app crashed. Every `LogEvent` ALREADY CARRIES `ts` — the log's own timestamp,
//     parsed once, on the event — so the offsets come out of arithmetic the app had already
//     done, for free.
//   * NO STRING WORK. The kind is stored BY REFERENCE (the event's own `kind` string, which is
//     a literal from the parser); nothing is concatenated, formatted or interned.
//
// WHAT THAT COSTS, STATED RATHER THAN HIDDEN: offsets are in LOG TIME, measured back from the
// NEWEST breadcrumb. During a live tail log time and wall time agree to within a second and the
// number reads exactly as "how long before the crash". During a REPLAY it reads as the spacing
// of the historical lines being folded — which is the honest measurement for a replay-mode
// crash, since wall time there would say "0 ms" for all ten and mean nothing.
//
// ---------------------------------------------------------------------------------------
// A KIND IS NOT CONTENT, and that is the whole reason this is allowed to exist
// ---------------------------------------------------------------------------------------
// `damage` says a damage line was parsed. It does not say who hit what, for how much, in which
// zone, or with what. There is no parameter on `noteEventKind` that a name, an amount or a line
// could travel in even if a caller wanted to pass one — the same shape argument health.ts makes
// for its five counters. The vocabulary is the closed `LogEventKind` enum, and the wire
// validator refuses anything outside it.

/** Breadcrumbs kept. Ten is what a person reads; it is also `MAX_BREADCRUMBS` on the wire,
 *  restated rather than imported so this module keeps its no-imports property. */
const RING = 10

/** Offsets are rounded to this, and capped at `MAX_OFFSET_MS`. COARSE on purpose: the question
 *  a breadcrumb answers is "just before, or a while before", never "at 1,247 ms". */
const OFFSET_ROUND_MS = 100
const MAX_OFFSET_MS = 10 * 60_000

/** One breadcrumb as the wire carries it. Mirrors `TelemetryBreadcrumb` (shared/telemetry.ts). */
export interface Breadcrumb {
  kind: string
  offsetMs: number
}

// Preallocated and never reallocated. `kinds` holds references to the parser's own literals.
const kinds: string[] = new Array<string>(RING).fill('unknown')
const stamps = new Float64Array(RING)
/** Next slot to write. `written` is the total ever pushed, so `written < RING` means partial. */
let cursor = 0
let written = 0

/**
 * WHICH HALF OF THE APP IS RUNNING. Taken from the registry's replay BRACKET
 * (`beginReplay`/`endReplay`, src/main/modules/registry.ts) rather than from a per-event `live`
 * flag, because JOS-60 already settled that question: a replay is a STATE, not a flag on each
 * event, and two sources of truth for it is how one of them ends up wrong. Defaults to live,
 * which is what a process that has never started a replay is.
 */
let replaying = false

/**
 * COUNT ONE PARSED EVENT. Called from `LogBus.emit` — the one choke point both feeders and the
 * derived-event drain pass through. See the header for why this is three writes and no clock.
 *
 * `ts` is the event's OWN timestamp (`LogEvent.ts`), already parsed. Nothing about the event
 * other than its kind is retained, and `kind` is a member of a closed enum.
 */
export function noteEventKind(kind: string, ts: number): void {
  kinds[cursor] = kind
  stamps[cursor] = ts
  cursor = (cursor + 1) % RING
  if (written < RING) written++
}

/** The registry entered or left a historical replay. */
export function noteReplaying(active: boolean): void {
  replaying = active
}

/** `'replay'` while the registry's bracket is open, `'live'` otherwise. */
export function currentMode(): 'live' | 'replay' {
  return replaying ? 'replay' : 'live'
}

/**
 * The ring, NEWEST FIRST, with offsets measured back from the newest entry — so the first
 * breadcrumb always reads `0` and the rest say how long before it they happened.
 *
 * Allocation happens HERE and only here: this runs once per captured error, not once per event.
 *
 * A NON-MONOTONIC STAMP READS AS ZERO rather than as a negative number. Log timestamps have
 * one-second resolution and a derived event inherits its parent's `ts`, so two crumbs sharing a
 * second (or arriving very slightly out of order across an epoch boundary) is ordinary — and a
 * negative offset would be refused by the wire validator, costing the whole report over a
 * rounding artefact.
 */
export function readBreadcrumbs(): Breadcrumb[] {
  if (written === 0) return []
  const out: Breadcrumb[] = []
  const newestAt = (cursor - 1 + RING) % RING
  const newest = stamps[newestAt]
  for (let i = 0; i < written; i++) {
    const at = (newestAt - i + RING) % RING
    const raw = newest - stamps[at]
    const offset = Number.isFinite(raw) && raw > 0 ? Math.round(raw / OFFSET_ROUND_MS) * OFFSET_ROUND_MS : 0
    out.push({ kind: kinds[at], offsetMs: Math.min(offset, MAX_OFFSET_MS) })
  }
  return out
}

/** Drop everything. Called on the collector's session boundaries, beside `resetHealth` — a
 *  switch turned off must not leave a session's crumbs waiting to ride the next report. */
export function resetBreadcrumbs(): void {
  cursor = 0
  written = 0
  replaying = false
  kinds.fill('unknown')
  stamps.fill(0)
}

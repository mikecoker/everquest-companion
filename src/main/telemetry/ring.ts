// telemetry/ring.ts — `<userData>/telemetry.json`, the local event ring.
//
// TWO HALVES, split for the same reason `storeMigrations.ts` splits its runner from its file
// I/O: the RING ITSELF is pure and node-testable (`pushCapped`, `parseRingFile`), and the file
// half is a thin, Electron-dependent shell over it.
//
// WHY NOT electron-store (a decision, not an oversight — the same one feedback/state.ts made):
// the store-migration law exists so the SETTINGS file written by any past build loads in
// today's build, indefinitely. Buffered telemetry is disposable by design — the whole feature
// is "counts we would like to have" — and paying the migration tax for it would be wrong twice
// over. So: its own file, its own tiny `version` integer, corrupt ⇒ start from empty.
//
// The user's PREFERENCES (enabled / noticeShown / analyticsId) do live in the settings store,
// behind schema migration 5 → 6, because those are not disposable: forgetting that a user
// turned analytics off would be the worst bug this feature could have.
//
// Everything resolves through `app.getPath('userData')`, so channel.ts's decision redirects it
// automatically: the dev app, the installed app and an e2e run can never share a ring.
//
// THE FILE HALF IS ITSELF SPLIT NOW (JOS-265), for the third time and the same reason: the
// DURABILITY of the write — temp, flush, rename, clean up, and back off when the volume is full —
// lives in `./durableWrite.ts`, which imports `node:fs` and nothing else and is therefore
// node-testable. What is left here is only what needs `app` or the logger.

import { app } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  TELEMETRY_BUFFER_CAP,
  type TelemetryBatch,
  type TelemetryRecord
} from '../../shared/telemetry'
import { validateRecord } from '../../shared/telemetryValidate'
import { logError, logInfo } from '../errorLog'
// The durability half, in its own Electron-free leaf (JOS-265). Its header carries the whole
// argument — the error store's ENOSPC exemplars, why there is no writer queue and no lock retry,
// and what the fsync is for. This file keeps only the decisions that need `app` or a logger.
import { createWriteGate, tempPathFor, writeFileDurable } from './durableWrite'

/** Bumped only if this file's shape changes. Unreadable/older ⇒ start empty, never migrate. */
export const TELEMETRY_RING_VERSION = 1

const RING_FILE = 'telemetry.json'

export interface TelemetryRing {
  version: number
  /** Oldest first. At most `TELEMETRY_BUFFER_CAP`; the oldest is dropped, never the newest. */
  events: TelemetryRecord[]
  /**
   * The last batch this install actually SENT — written only after the server accepted it
   * (flush.ts `retireBatch`), and kept so Preferences can show it verbatim (T4). Null until the
   * first accepted batch, and the pane says which of the two silences that is.
   */
  lastBatch: TelemetryBatch | null
}

export function emptyRing(): TelemetryRing {
  return { version: TELEMETRY_RING_VERSION, events: [], lastBatch: null }
}

/**
 * Append with the cap applied — THE ring's whole behavior, as a pure function.
 *
 * A full ring drops the OLDEST record. That is the honest choice for a counter feed: the
 * newest events describe the session someone is actually having, and refusing to record
 * anything once 500 have piled up would silently stop measuring exactly the long sessions
 * most worth measuring. Never mutates its input.
 */
export function pushCapped(
  events: readonly TelemetryRecord[],
  next: TelemetryRecord,
  cap = TELEMETRY_BUFFER_CAP
): TelemetryRecord[] {
  if (cap <= 0) return []
  const out = [...events, next]
  return out.length <= cap ? out : out.slice(out.length - cap)
}

/**
 * Shape check, not a migration: anything unexpected means "start fresh". Individual records are
 * re-validated through the SHARED validator, so a hand-edited file cannot smuggle a field the
 * schema does not have into a batch — the ring is an input like any other.
 */
export function parseRingFile(raw: unknown): TelemetryRing | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== TELEMETRY_RING_VERSION) return null
  if (!Array.isArray(o.events)) return null
  const events: TelemetryRecord[] = []
  for (const entry of o.events) {
    const rec = validateRecord(entry)
    if (rec.ok) events.push(rec.value)
  }
  return {
    version: TELEMETRY_RING_VERSION,
    events: events.slice(Math.max(0, events.length - TELEMETRY_BUFFER_CAP)),
    // The last-sent batch is display-only; a malformed one is simply forgotten.
    lastBatch: null
  }
}

// ------------------------------------------------------------------ the file half

function ringPath(): string {
  return join(app.getPath('userData'), RING_FILE)
}

let cached: TelemetryRing | null = null

/**
 * THE ONE WRITER'S FAILURE STATE (JOS-265). Module-level because there is exactly one ring file
 * and exactly one process writing it — the same reason `cached` is module-level.
 */
const writeGate = createWriteGate()

/** Read (and memoize) the ring. Missing or corrupt ⇒ empty, and nothing is written until the
 *  first record arrives — a user who turned analytics off never grows the file at all. */
export function readRing(): TelemetryRing {
  if (cached) return cached
  const path = ringPath()
  if (existsSync(path)) {
    try {
      const parsed = parseRingFile(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (parsed) {
        cached = parsed
        return cached
      }
      logInfo('[everquest-companion] telemetry.json unreadable/foreign - starting from empty')
    } catch (err) {
      logError('main:telemetryRing', { message: 'telemetry.json parse failed; starting empty', err })
    }
  }
  cached = emptyRing()
  return cached
}

/**
 * Persist durably (temp file + flush + rename), and STOP TRYING for a while when the disk says no.
 *
 * THE CACHE IS SET FIRST, BEFORE THE GATE IS ASKED, and that order is the entire reason a paused
 * writer costs nothing: memory is this ring's truth (every reader — `pendingBatch`,
 * `telemetryPayload`, the next `recordEvent` — comes through `readRing`, which returns `cached`),
 * so a skipped write loses only the crash-safety of a file that was refusing to be written
 * anyway. NOTHING about what is collected changes; the first write that lands persists the lot.
 *
 * `now` is a parameter for the same reason the rest of this app takes one — the pause is a clock
 * decision and a clock decision should be drivable.
 */
export function writeRing(next: TelemetryRing, now = Date.now()): void {
  cached = next
  if (!writeGate.ready(now)) return
  const dir = app.getPath('userData')
  try {
    writeFileDurable(dir, join(dir, RING_FILE), JSON.stringify(next, null, 2))
    if (writeGate.succeeded()) {
      logInfo('[everquest-companion] telemetry.json is writable again; the buffer was persisted')
    }
  } catch (err) {
    // THE PAYLOAD IS BYTE-IDENTICAL TO THE ONE 0.18-0.23 FILED, deliberately: the error store's
    // fingerprint is built from the message and the frames, so keeping this string exact means the
    // fleet's existing `telemetry.json write failed` families keep aggregating across the fix
    // instead of splitting in two — and `errorRepeat`'s identical-line cap still recognises the
    // line. The pause is narrated to the console instead, where a varying number costs nothing.
    logError('main:telemetryRing', { message: 'telemetry.json write failed', err })
    const { delayMs } = writeGate.failed(now)
    logInfo(
      `[everquest-companion] telemetry.json is unwritable; pausing the buffer's writes for ${Math.round(delayMs / 1000)}s`
    )
  }
}

/**
 * DROP EVERYTHING, now — the buffer AND the file. This is what "turn it off" means, and what a
 * rotation means: a switch that left 500 events sitting on disk would be a switch that lied.
 */
export function dropRing(): void {
  cached = emptyRing()
  // A pause is failure state about the OLD file. Dropping it frees space and gives the next write
  // a genuinely different situation, so it starts from a clean gate rather than serving out a
  // fifteen-minute wait the user's switch has just made meaningless.
  writeGate.reset()
  const path = ringPath()
  try {
    rmSync(path, { force: true })
    // AND THE SCRATCH FILE (JOS-265). A write that failed part-way leaves `telemetry.json.tmp`
    // holding up to a full ring of events. Deleting only the live file would leave those events on
    // disk after "turn it off" — the same lie this function exists to prevent, in another filename.
    rmSync(tempPathFor(path), { force: true })
  } catch (err) {
    logError('main:telemetryRing', { message: 'telemetry.json delete failed', err })
  }
}

/** Test/dev seam: forget the memoized ring so the next read hits disk again. */
export function resetRingCache(): void {
  cached = null
  writeGate.reset()
}

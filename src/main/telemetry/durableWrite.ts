// telemetry/durableWrite.ts — the two mechanics that keep `telemetry.json` intact on a volume
// that is refusing writes, extracted here so both can be driven from a node test.
//
// WHAT THE EVIDENCE ACTUALLY SAID (JOS-265). The fleet filed ~350 `telemetry.json write failed`
// occurrences across 0.18-0.23, and every exemplar pulled out of the error store carried the SAME
// code: `ENOSPC`. All four of the largest 0.22 families (~100 + 29 + 28 + 27 occurrences) — from
// `recordEvent` under the report timers and from `retireBatch` after a flush — say ENOSPC and
// nothing else. Not EBUSY, not EPERM, not EACCES, not ENOENT. So the two mechanisms the ticket
// first suspected are both ruled out by the codes rather than by argument:
//
//   * NOT CONCURRENT WRITERS. There are exactly two call sites (`collector.recordEvent`,
//     `flush.retireBatch`), both synchronous, both on the main process's one thread. Sync fs calls
//     cannot interleave with each other there, and an interleaved write would not report ENOSPC.
//     A serialising queue would have been a lock around something already serial.
//   * NOT A LOCKED FILE. An antivirus or indexer holding the file shows up as EBUSY/EPERM/EACCES
//     on the rename. Nothing in the store shows those, so there is no transient lock to retry
//     through, and a bounded lock-retry is not written here: it would be a fix for a failure this
//     app is not having.
//
// The volume is full. That cannot be fixed from in here. What CAN be fixed is the damage this app
// does while it is full, and there were two kinds:
//
//   1. THE LEAKED TEMP FILE. The write was already atomic (temp + rename), so a failed write never
//      truncated the live file — but the partial temp was LEFT ON DISK, holding up to a full
//      ring's worth of bytes on the volume that had just said it had none. It was reclaimed only
//      by a later successful write, which is precisely the write that could not happen. The temp
//      is now removed on the failure path and the bytes go straight back.
//   2. THE DOOMED-WRITE STORM. Every recorded event re-ran the whole serialise/open/write cycle
//      and re-filed the same failure; one install produced ~100 occurrences of a single
//      fingerprint that way, and each occurrence also appended a line to `errors.log` on the same
//      full disk. `createWriteGate` is `deadPipe.ts`'s latch (JOS-197) with a timer instead of a
//      latch: after a failure the writer stops touching the disk for a spell that doubles up to a
//      cap, and one success clears it. NOTHING ABOUT COLLECTION CHANGES — the ring in memory takes
//      every event exactly as it did before, and the first write that lands persists all of them.
//      Only the attempts that were going to fail are skipped.
//
// AND ONE THING THE EVIDENCE IMPLIES RATHER THAN STATES: `fsync` before the rename. Two installs
// filed `telemetry.json parse failed; starting empty`, which a temp-and-rename write is supposed
// to make impossible — but renaming a file whose bytes are still only in the page cache is exactly
// how an "atomic" write still ends up truncated after an unclean shutdown, and a machine with a
// full disk is a machine having a bad day. One extra syscall, on a file written a handful of times
// per timer round (JOS-269 stretched those rounds to 5 and 10 minutes, so the syscall is rarer
// still), buys the guarantee the rename was already claiming.
//
// THIS FILE IMPORTS `node:fs` AND NOTHING ELSE — no Electron, no app paths, no logger — so
// `ring.ts`'s file half stays the thin shell its header promises, and this half is node-testable
// (`tests/telemetryRingDurability.test.mts`).

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Every `node:fs` call this module makes, as ONE injectable object.
 *
 * It exists so a test can fail an individual step the way a full disk fails it — ENOSPC part-way
 * through the write, or on the flush, or on the rename — and then read back what was left on a
 * REAL directory. Injecting the seam is the only way to reproduce a full volume portably, and it
 * is the whole acceptance criterion of JOS-265.
 */
export interface DurableIo {
  mkdir(dir: string): void
  /** Create/truncate for writing, returning the descriptor. */
  open(path: string): number
  write(fd: number, data: string): void
  /** Force the bytes out of the page cache. THE step a plain temp+rename is missing. */
  fsync(fd: number): void
  close(fd: number): void
  rename(from: string, to: string): void
  /** Best-effort unlink; missing is not an error. */
  remove(path: string): void
}

/** The real thing. */
export const nodeIo: DurableIo = {
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true })
  },
  open: (path) => openSync(path, 'w'),
  write: (fd, data) => {
    writeFileSync(fd, data, 'utf8')
  },
  fsync: (fd) => {
    fsyncSync(fd)
  },
  close: (fd) => {
    closeSync(fd)
  },
  rename: (from, to) => {
    renameSync(from, to)
  },
  remove: (path) => {
    rmSync(path, { force: true })
  }
}

/** The scratch file a durable write goes through. Exported because `dropRing` has to delete it:
 *  a failed write can leave one holding events, and "off" that leaves events in a sibling file
 *  is the switch lying in a different filename. */
export function tempPathFor(path: string): string {
  return `${path}.tmp`
}

/**
 * WRITE THE WHOLE FILE OR LEAVE THE OLD ONE ALONE — and leave nothing behind either way.
 *
 * Order matters at every step: the descriptor is closed BEFORE the temp is removed (Windows will
 * not unlink a file with an open handle), the flush happens BEFORE the rename (that is the point
 * of it), and the rename happens LAST so the live path only ever names a complete file.
 *
 * Rethrows whatever failed. The caller decides what a failed telemetry write is worth — from here
 * it is not knowable, and this module has no logger to decide it with.
 */
export function writeFileDurable(dir: string, path: string, data: string, io: DurableIo = nodeIo): void {
  const tmp = tempPathFor(path)
  io.mkdir(dir)
  let fd: number | null = null
  try {
    fd = io.open(tmp)
    io.write(fd, data)
    io.fsync(fd)
    io.close(fd)
    fd = null
    io.rename(tmp, path)
  } catch (err) {
    if (fd !== null) {
      try {
        io.close(fd)
      } catch {
        // The descriptor is lost either way; the throw below is the failure worth reporting.
      }
    }
    try {
      io.remove(tmp)
    } catch {
      // Nothing further to try. A later successful write truncates it anyway.
    }
    throw err
  }
}

// ------------------------------------------------------------------ the storm gate

/**
 * First pause after a failed write.
 *
 * RE-DERIVED, AND DELIBERATELY UNCHANGED, WHEN THE CADENCES MOVED (JOS-269: flush 60 s → 5 min,
 * heartbeat 5 min → 10 min). The old sentence justified 30 s as "long enough that a 5-minute
 * heartbeat and a flush cannot both re-file the same failure", which read as if this constant were
 * a function of those two periods. It is not, and the new numbers make that plain: what this pause
 * has to swallow is a BURST OF WRITES THAT ARRIVE TOGETHER, not the gap between two timers.
 *
 * The bursts are the same two they always were, and both are sub-second:
 *   * a heartbeat tick fires three `recordEvent` writes back to back (`sessionHeartbeat`,
 *     `healthCounters`, and any error reports), and — because 10 min is a MULTIPLE of the 5-minute
 *     flush — the flush's `retireBatch` write lands in the same timer turn. Four doomed writes
 *     inside a millisecond; 30 s coalesces them into one filed failure, with three orders of
 *     magnitude to spare;
 *   * user activity (view switches, feature flips, funnel steps) writes on no schedule at all,
 *     and a person clicking around a full disk was the shape behind the ~100-occurrence
 *     fingerprint in the fleet evidence above.
 *
 * The longer cadences make this gate LESS load-bearing, never more: the timers now touch the disk
 * a fifth as often, so the doomed-write rate they contribute fell with them. 30 s stays because it
 * is still the shortest pause that flattens a burst while a freed disk is noticed on the very next
 * write — and moving it would change durability behaviour in a ticket that is only allowed to
 * change cadence.
 */
export const WRITE_RETRY_BASE_MS = 30_000
/** The ceiling the doubling stops at. A session that has been failing for a quarter of an hour is
 *  not about to be rescued by trying more often. (The ladder now CLIMBS more slowly in wall-clock
 *  terms — it advances one rung per failed write, and the timers supply those five times less
 *  often — which is the gate working, not drifting: fewer attempts is fewer occurrences filed.) */
export const WRITE_RETRY_MAX_MS = 15 * 60_000

/** How long to wait after `n` consecutive failures: 30s, 1m, 2m, 4m… capped. `n <= 0` is "now". */
export function retryDelayMs(
  consecutiveFailures: number,
  base = WRITE_RETRY_BASE_MS,
  max = WRITE_RETRY_MAX_MS
): number {
  if (consecutiveFailures <= 0) return 0
  const doubled = base * 2 ** (consecutiveFailures - 1)
  return Number.isFinite(doubled) ? Math.min(doubled, max) : max
}

export interface WriteGate {
  /** May the caller touch the disk at `now`? False during a pause — the caller does nothing. */
  ready(now: number): boolean
  /** A write landed. Clears the pause; returns true if this success ENDED one, so the caller can
   *  say so exactly once rather than on every subsequent write. */
  succeeded(): boolean
  /** A write threw. Opens (or lengthens) the pause and reports what it chose. */
  failed(now: number): { failures: number; delayMs: number }
  /** Forget everything — for the switch being flipped, and for tests. */
  reset(): void
  /** Consecutive failures since the last success. Diagnostics only. */
  failures(): number
}

/**
 * One writer's failure state. A closure rather than module state so the caller owns exactly one
 * (and a test can own a dozen), and so nothing here is shared between the ring and any future file
 * that wants the same protection.
 */
export function createWriteGate(base = WRITE_RETRY_BASE_MS, max = WRITE_RETRY_MAX_MS): WriteGate {
  let failures = 0
  let nextAttemptAt = 0
  return {
    ready: (now) => failures === 0 || now >= nextAttemptAt,
    succeeded: () => {
      const endedAPause = failures > 0
      failures = 0
      nextAttemptAt = 0
      return endedAPause
    },
    failed: (now) => {
      failures += 1
      const delayMs = retryDelayMs(failures, base, max)
      nextAttemptAt = now + delayMs
      return { failures, delayMs }
    },
    reset: () => {
      failures = 0
      nextAttemptAt = 0
    },
    failures: () => failures
  }
}

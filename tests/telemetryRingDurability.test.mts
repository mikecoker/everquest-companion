// ============================================================================
// telemetryRingDurability.test.mts — JOS-265: the local telemetry file survives its writers.
// ============================================================================
//
// THE DEFECT, read off the error store rather than guessed. `telemetry.json write failed` grew to
// ~350 occurrences across 0.18-0.23, and EVERY exemplar carries the same code: `ENOSPC`. The four
// largest 0.22 families — 0ae22c6118280de3 (~100, `recordEvent` under the error-report timer),
// 1a2752392e3f33db (29, `retireBatch` after a flush), c4e559b721fd8969 (28, the health timer),
// 7dbdfd323e09a8d8 (27, the heartbeat) — differ only in which caller was holding the pen. The
// volume is full. There is no EBUSY, no EPERM, no EACCES, no ENOENT anywhere in the set, so there
// is no lock to retry through and no missing directory to create; and with both writers being
// synchronous calls on the main process's one thread there was never an interleaving to serialise
// either. The suite therefore drives a FULL DISK, not a race.
//
// WHAT IS PINNED HERE, each one a thing 0.23 got wrong or did not do:
//
//   1. A failed write leaves NO scratch file behind. 0.23 left `telemetry.json.tmp` holding a
//      partial ring on the volume that had just reported it had no room — the single worst thing
//      to do to a full disk, and it was reclaimed only by a later successful write, which is
//      exactly the write that could not happen.
//   2. A failed write leaves the LIVE file exactly as it was. (0.23 got this right; it is pinned
//      because it is the property everything else is arranged around.)
//   3. The bytes are FLUSHED before the rename. 0.23 renamed a file that could still be entirely
//      in the page cache, which is how two installs came to file `telemetry.json parse failed;
//      starting empty` against a write that called itself atomic.
//   4. A writer that has just failed STOPS TOUCHING THE DISK for a spell. 0.23 re-ran the whole
//      cycle for every event and re-filed the failure each time; that is how one install produced
//      ~100 occurrences of one fingerprint, each of them also appending to `errors.log` on the
//      same full disk.
//   5. It comes back on its own. One success clears the pause completely.
//
// And two SOURCE pins on `ring.ts`, because the two rules that make (4) safe cannot be observed
// from outside a process with Electron in it: the in-memory ring is updated BEFORE the gate is
// consulted (so a pause costs persistence and never an event), and the failure payload keeps the
// exact message string the fleet's existing fingerprints were built from.
//
// No Electron and no network: this suite never skips. It writes into a real temp directory so the
// "what was left on disk" assertions are answered by the filesystem, and injects the failures
// through `DurableIo` because a genuinely full volume is not something a test may arrange.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createWriteGate,
  nodeIo,
  retryDelayMs,
  tempPathFor,
  writeFileDurable,
  WRITE_RETRY_BASE_MS,
  WRITE_RETRY_MAX_MS,
  type DurableIo
} from '../src/main/telemetry/durableWrite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A real, empty directory to write into. Removed by the test that made it. */
function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'eqc-ring-'))
}

/** The error a full volume throws, spelled the way `node:fs` spells it. */
function enospc(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device, write')
  err.code = 'ENOSPC'
  return err
}

/** Wrap the real io, recording the call order and optionally failing one step the way a full
 *  volume fails it — part of the data written, THEN the error. */
function io(record: string[], fail?: { at: keyof DurableIo; partial?: boolean }): DurableIo {
  const step =
    <K extends keyof DurableIo>(name: K, run: DurableIo[K]): DurableIo[K] =>
      ((...args: unknown[]) => {
        record.push(name)
        if (fail?.at === name) {
          if (fail.partial === true && name === 'write') {
            const [fd, data] = args as [number, string]
            nodeIo.write(fd, data.slice(0, Math.floor(data.length / 2)))
          }
          throw enospc()
        }
        return (run as (...a: unknown[]) => unknown)(...args)
      }) as DurableIo[K]
  return {
    mkdir: step('mkdir', nodeIo.mkdir),
    open: step('open', nodeIo.open),
    write: step('write', nodeIo.write),
    fsync: step('fsync', nodeIo.fsync),
    close: step('close', nodeIo.close),
    rename: step('rename', nodeIo.rename),
    remove: step('remove', nodeIo.remove)
  }
}

// ---- 1-3. THE WRITE ITSELF -------------------------------------------------------------------

test('THE FULL DISK: a write that runs out of space mid-file leaves no scratch file behind', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'telemetry.json')
    writeFileDurable(dir, path, '{"version":1,"events":[],"lastBatch":null}', io([]))

    // Now the volume fills up half way through the next write — the ENOSPC exemplars' shape.
    const calls: string[] = []
    assert.throws(
      () => {
        writeFileDurable(dir, path, JSON.stringify({ version: 1, events: Array.from({ length: 200 }, (_, i) => i) }), io(calls, { at: 'write', partial: true }))
      },
      (err: NodeJS.ErrnoException) => err.code === 'ENOSPC'
    )

    // THE POINT: the partial temp is gone, so the bytes went back to the volume that has none.
    assert.equal(existsSync(tempPathFor(path)), false, 'the scratch file must not survive a failed write')
    assert.deepEqual(readdirSync(dir), ['telemetry.json'], 'nothing but the live file is left in userData')
    // And the descriptor was closed before the unlink was attempted — on Windows the unlink of an
    // open handle fails, so the ORDER is what makes the line above true, not a lucky platform.
    assert.ok(calls.indexOf('close') < calls.indexOf('remove'), `close must precede remove; got ${calls.join(',')}`)

    // AND THE LIVE FILE IS UNTOUCHED — still the last thing that was written whole.
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, events: [], lastBatch: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE FULL DISK: a failed RENAME is survivable the same way', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'telemetry.json')
    writeFileDurable(dir, path, '{"version":1,"events":[],"lastBatch":null}', io([]))
    assert.throws(() => {
      writeFileDurable(dir, path, '{"version":1,"events":[1,2,3],"lastBatch":null}', io([], { at: 'rename' }))
    })
    assert.equal(existsSync(tempPathFor(path)), false)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, events: [], lastBatch: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE FLUSH: the bytes are forced out of the cache BEFORE the rename publishes them', () => {
  const dir = scratchDir()
  try {
    const calls: string[] = []
    const path = join(dir, 'telemetry.json')
    writeFileDurable(dir, path, '{"version":1}', io(calls))
    assert.deepEqual(calls, ['mkdir', 'open', 'write', 'fsync', 'close', 'rename'])
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1 })
    // Written whole, and the temp did not outlive the write.
    assert.deepEqual(readdirSync(dir), ['telemetry.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 4-5. THE STORM GATE ---------------------------------------------------------------------

test('THE STORM: after a failed write the ring stops touching the disk until the pause is up', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'telemetry.json')
    const gate = createWriteGate()
    const calls: string[] = []
    const full = io(calls, { at: 'write' })

    // t=0: one attempt, one failure, one pause.
    let attempts = 0
    const attempt = (now: number, disk: DurableIo): boolean => {
      if (!gate.ready(now)) return false
      attempts += 1
      try {
        writeFileDurable(dir, path, '{"version":1,"events":[]}', disk)
        gate.succeeded()
        return true
      } catch {
        gate.failed(now)
        return false
      }
    }

    assert.equal(attempt(0, full), false)
    assert.equal(attempts, 1)

    // The heartbeat, the health report, the error report and a flush all record events over the
    // next half minute — 0.23 wrote (and re-filed) four more times. Now: not one syscall.
    const after = calls.length
    for (const t of [1_000, 5_000, 12_000, 29_999]) assert.equal(attempt(t, full), false)
    assert.equal(attempts, 1, 'a paused writer must not attempt the write at all')
    assert.equal(calls.length, after, 'a paused writer must not make a single fs call')

    // The pause expires; exactly one more attempt is spent, and it fails, so the next pause is
    // longer — the doubling that keeps a session-long ENOSPC from filing hundreds of occurrences.
    assert.equal(attempt(WRITE_RETRY_BASE_MS, full), false)
    assert.equal(attempts, 2)
    assert.equal(gate.failures(), 2)
    assert.equal(attempt(WRITE_RETRY_BASE_MS + 1, full), false)
    assert.equal(attempts, 2, 'the second pause is longer than the first, not equal to zero')

    // THE DISK IS FREED. The next attempt after the pause lands, and one success clears everything
    // — including the events that piled up in memory while the writes were paused.
    const t = WRITE_RETRY_BASE_MS + retryDelayMs(2)
    assert.equal(attempt(t, io(calls)), true)
    assert.equal(gate.failures(), 0)
    assert.equal(attempt(t + 1, io(calls)), true, 'a recovered writer is not still serving a pause')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, events: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE BACKOFF: 30s, 1m, 2m, 4m… and it stops doubling at the cap', () => {
  assert.equal(retryDelayMs(0), 0)
  assert.equal(retryDelayMs(-1), 0)
  assert.equal(retryDelayMs(1), 30_000)
  assert.equal(retryDelayMs(2), 60_000)
  assert.equal(retryDelayMs(3), 120_000)
  assert.equal(retryDelayMs(4), 240_000)
  assert.equal(retryDelayMs(5), 480_000)
  assert.equal(retryDelayMs(6), WRITE_RETRY_MAX_MS)
  // A session that has failed all day must not overflow into an infinite or negative wait.
  assert.equal(retryDelayMs(2000), WRITE_RETRY_MAX_MS)
  assert.equal(retryDelayMs(Number.MAX_SAFE_INTEGER), WRITE_RETRY_MAX_MS)
})

test('THE PAUSE IS ANNOUNCED ONCE: only the success that ENDS one says so', () => {
  const gate = createWriteGate()
  assert.equal(gate.succeeded(), false, 'a writer that never failed has no recovery to narrate')
  gate.failed(0)
  assert.equal(gate.succeeded(), true)
  assert.equal(gate.succeeded(), false)
  // And the switch being flipped forgets the pause outright (`dropRing`).
  gate.failed(0)
  assert.equal(gate.ready(1), false)
  gate.reset()
  assert.equal(gate.ready(1), true)
  assert.equal(gate.failures(), 0)
})

// ---- 6. THE TWO RULES THAT LIVE IN ring.ts ---------------------------------------------------

const RING_SRC = readFileSync(join(ROOT, 'src', 'main', 'telemetry', 'ring.ts'), 'utf8')

test('MEMORY FIRST: writeRing updates the cache BEFORE it consults the gate', () => {
  const body = RING_SRC.slice(RING_SRC.indexOf('export function writeRing'))
  const cacheAt = body.indexOf('cached = next')
  const gateAt = body.indexOf('writeGate.ready')
  assert.ok(cacheAt > 0 && gateAt > 0, 'writeRing must set the cache and ask the gate')
  assert.ok(
    cacheAt < gateAt,
    'a skipped write may cost persistence and NEVER an event: the ring in memory is updated first'
  )
})

test('THE FINGERPRINT SURVIVES THE FIX: the failure message is unchanged, character for character', () => {
  // The error store aggregates on the message plus the frames. Rewording this line would split
  // ~350 filed occurrences from everything the fix files next, and the triage loop would be
  // reading two half-histories. Anything that varies per occurrence goes to the console instead.
  assert.ok(RING_SRC.includes("{ message: 'telemetry.json write failed', err }"))
  assert.ok(
    !/message: `telemetry\.json write failed/.test(RING_SRC),
    'the failure message must stay a literal — no interpolated counts, delays or codes'
  )
})

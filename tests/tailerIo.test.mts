// ============================================================================
// tailerIo.test.mts — the live tail's READ PATH: one handle, bounded slices, and its own numbers.
// ============================================================================
//
// WHY THESE ARE THE TESTS (JOS-363). The tail was changed on a performance argument — EverQuest
// writes its log synchronously from the game thread, so an open-per-read against a hundreds-of-MB
// file, plus one uncapped read of the whole delta, sits directly in front of the frame the game is
// trying to draw. The fix is a persistent handle and 256 KiB slices. Both halves are only worth
// anything if they are TRUE and if they cost the reader nothing, so:
//
//   * THE CLAIM. "Steady-state tailing opens nothing after the first" is asserted through the
//     stats seam the fix ships with, not through a story about it. AGENTS.md "The fold checkpoint,
//     and why there isn't one" is the standing reason: a performance change that cannot be read off
//     an instrument is a change nobody can later disprove.
//   * THE COST. Slicing introduces a boundary that falls at a fixed byte count — mid-line, and
//     just as easily mid-CHARACTER — where the old poll boundary always landed on EQ's own whole
//     line. Both straddles are tested at the exact byte, because "it works on my log" is what a
//     multi-byte name in a guild tag is waiting for.
//
// These drive the REAL Tailer against a real temp file with a real chokidar poll (20 ms instead of
// production's 400 ms). Nothing here is a mock: the whole point is the handle and the OS calls.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tailer, TAIL_READ_SLICE_BYTES } from '../src/main/log/Tailer'
import {
  noteTailRead,
  peekTailIoTimeline,
  resetTailIoStats,
  takeTailIoSummary,
  TAIL_IO_RING,
  type TailIoSample
} from '../src/main/log/tailIoStats'

const POLL_MS = 20

/** A throwaway directory + log path. Never the real game log (AGENTS.md, house rules). */
function stage(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-tailer-io-'))
  return { dir, path: join(dir, 'eqlog_Primitive_freeport.txt') }
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}

/** Spin until `pred` holds. A tail driven by a real poll has no callback to await. */
async function waitFor(pred: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Start a tail over `path` reading from the very first byte, with the stats seam zeroed. */
async function tailFromStart(path: string, lines: string[], errs: unknown[] = []): Promise<Tailer> {
  resetTailIoStats()
  const t = new Tailer(path, { fromStart: true, pollInterval: POLL_MS })
  t.on('line', (raw) => lines.push(raw))
  // Collected, never thrown from the listener: the tail keeps running past an error by design, and
  // a throw in here would surface as an unhandled rejection instead of a named assertion.
  t.on('error', (err) => errs.push(err))
  await t.start()
  return t
}

const opens = (): TailIoSample[] => peekTailIoTimeline().filter((s) => s.reason !== 'reused')

test('STEADY STATE OPENS THE LOG ONCE AND NEVER AGAIN — the whole claim, off the seam', async () => {
  const { dir, path } = stage()
  const lines: string[] = []
  writeFileSync(path, '[Sat Aug 01 00:00:01 2026] You have entered Freeport.\n')
  const t = await tailFromStart(path, lines)
  try {
    await waitFor(() => lines.length === 1, 'the seed line')
    // Eight separate appends — eight chokidar wakes, which under the old tail was eight
    // `CreateFile`s on the file EverQuest is appending to from its render thread.
    //
    // SPACED BY 50 ms, and the reason is chokidar's rather than ours: its polling arm swallows a
    // wake whose `mtimeMs` matches the previous one, and Windows moves a file's write time on a
    // 15.6 ms tick — so two appends inside one tick are ONE event no matter what the tail does.
    // (Nothing is lost when that happens: the offset carries and the next write picks the bytes
    // up. It is a latency shape in the watcher, and a test that ignored it would be timing the
    // clock quantum instead of the read path.)
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 50))
      appendFileSync(path, `[Sat Aug 01 00:00:0${String(i + 2)} 2026] You slash a rat for ${String(i)} points of damage.\n`)
      await waitFor(() => lines.length === i + 2, `append ${String(i)}`)
    }
    assert.equal(lines.length, 9)

    const first = opens()
    assert.deepEqual(
      first.map((s) => s.reason),
      ['first'],
      'exactly one open, and it is the first read'
    )
    // ZERO open cost on every other cycle — the field is what makes the claim falsifiable.
    for (const s of peekTailIoTimeline().slice(1)) assert.equal(s.openMs, 0)
    const summary = takeTailIoSummary()
    assert.ok(summary)
    assert.equal(summary.reopens, 1)
    assert.equal(summary.byReason.first, 1)
    assert.ok(summary.reads >= 9, `at least one read cycle per line, got ${String(summary.reads)}`)
    assert.ok(summary.bytes > 0)
  } finally {
    await t.stop()
    cleanup(dir)
  }
})

test('a 2 MiB burst is read in at least 8 bounded slices, with every line whole', async () => {
  const { dir, path } = stage()
  const lines: string[] = []
  const errs: unknown[] = []
  writeFileSync(path, '')
  const t = await tailFromStart(path, lines, errs)
  try {
    // 71-byte lines (70 + '\n'): 256 KiB is not a multiple of 71, so slice edges land INSIDE lines
    // by construction rather than by luck — line 3692 straddles the first one.
    const body = 'x'.repeat(60)
    const count = Math.ceil((2 * 1024 * 1024) / 71)
    const burst = Array.from({ length: count }, (_, i) => `${String(i).padStart(9, '0')} ${body}`)
    assert.equal(Buffer.byteLength(`${burst[0]!}\n`), 71)
    assert.notEqual(TAIL_READ_SLICE_BYTES % 71, 0, 'the fixture only proves anything if edges cut lines')
    appendFileSync(path, `${burst.join('\n')}\n`)

    await waitFor(() => lines.length === count, `all ${String(count)} burst lines`, 30_000)
    const differs = lines.findIndex((l, i) => l !== burst[i])
    assert.equal(differs, -1, `line ${String(differs)} arrived as ${JSON.stringify(lines[differs])}`)
    assert.deepEqual(errs, [])

    const timeline = peekTailIoTimeline()
    const slices = timeline.reduce((n, s) => n + s.slices, 0)
    const bytes = timeline.reduce((n, s) => n + s.bytes, 0)
    assert.equal(bytes, Buffer.byteLength(`${burst.join('\n')}\n`))
    const floor = Math.ceil(bytes / TAIL_READ_SLICE_BYTES)
    assert.ok(floor >= 8, `the burst must exceed 8 slices' worth of bytes (${String(bytes)})`)
    assert.ok(slices >= floor, `expected >= ${String(floor)} slices, got ${String(slices)}`)
    // No single read may ask for more than the cap — that is the property the game's append needs.
    for (const s of timeline) assert.ok(s.bytes <= s.slices * TAIL_READ_SLICE_BYTES)
    assert.deepEqual(opens().map((s) => s.reason), ['first'], 'a burst is not a reason to reopen')
  } finally {
    await t.stop()
    cleanup(dir)
  }
})

test('a multi-byte character straddling a slice edge survives — the boundary the old poll never hit', async () => {
  const { dir, path } = stage()
  const lines: string[] = []
  writeFileSync(path, '')
  const t = await tailFromStart(path, lines)
  try {
    // Byte 262143 is the last byte of the first slice; a 3-byte character starting there is cut
    // clean in half by it. Decoding either half on its own yields U+FFFD, permanently.
    const pad = 'x'.repeat(TAIL_READ_SLICE_BYTES - 1)
    const line = `${pad}☃ Snowman of Everfrost hits YOU for 12 points of damage.`
    assert.equal(Buffer.byteLength(pad), TAIL_READ_SLICE_BYTES - 1)
    appendFileSync(path, `${line}\n`)

    await waitFor(() => lines.length === 1, 'the straddling line')
    assert.equal(lines[0], line, 'the character survived the slice edge')
    assert.ok(lines[0]?.includes('☃'))
    assert.ok(!lines[0]?.includes(String.fromCharCode(0xfffd)), 'no U+FFFD anywhere in the line')

    const slices = peekTailIoTimeline().reduce((n, s) => n + s.slices, 0)
    assert.ok(slices >= 2, `the line must span slices to prove anything, got ${String(slices)}`)

    // And the checkpoint is exact across a partial trailing line — the byte arithmetic the
    // undecoded carry buys. A line the game has not finished writing is read but never emitted.
    const half = '☃ half a line the game has not finished'
    appendFileSync(path, half)
    await waitFor(() => t.readOffset() > Buffer.byteLength(`${line}\n`), 'the partial line to be read')
    assert.equal(lines.length, 1, 'a line with no newline is emitted to nobody')
    assert.equal(t.checkpointOffset(), Buffer.byteLength(`${line}\n`))
    assert.equal(t.readOffset() - t.checkpointOffset(), Buffer.byteLength(half))
  } finally {
    await t.stop()
    cleanup(dir)
  }
})

test('a truncation mid-session reopens EXACTLY ONCE and re-reads from byte 0', async () => {
  const { dir, path } = stage()
  const lines: string[] = []
  writeFileSync(path, '[Sat Aug 01 00:00:01 2026] before the truncation\n')
  const t = await tailFromStart(path, lines)
  try {
    await waitFor(() => lines.length === 1, 'the pre-truncation line')
    assert.ok(t.readOffset() > 0)

    truncateSync(path, 0)
    appendFileSync(path, '[Sat Aug 01 09:00:01 2026] after the truncation\n')
    await waitFor(() => lines.length === 2, 'the post-truncation line')

    assert.equal(lines[1], '[Sat Aug 01 09:00:01 2026] after the truncation')
    assert.equal(t.readOffset(), Buffer.byteLength(`${lines[1]!}\n`), 'the offset restarted at 0')
    const reasons = opens().map((s) => s.reason)
    assert.deepEqual(reasons, ['first', 'shrunk'], 'one open at the start, one for the shrink')
    const summary = takeTailIoSummary()
    assert.equal(summary?.byReason.shrunk, 1)
  } finally {
    await t.stop()
    cleanup(dir)
  }
})

test('a stopped tail opens nothing more — the handle a character switch would otherwise leak', async () => {
  const { dir, path } = stage()
  const lines: string[] = []
  const errs: unknown[] = []
  writeFileSync(path, 'seed\n')
  const t = await tailFromStart(path, lines, errs)
  await waitFor(() => lines.length === 1, 'the seed line')
  await t.stop()

  const after = peekTailIoTimeline().length
  // A switch stops one tail and starts another. If a wake could still reach a stopped tail it
  // would OPEN the file again, with nothing left to ever close it.
  for (let i = 0; i < 4; i++) {
    appendFileSync(path, `nobody is reading this ${String(i)}\n`)
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.equal(lines.length, 1, 'a stopped tail emits nothing')
  assert.equal(peekTailIoTimeline().length, after, 'and reads nothing')
  assert.deepEqual(errs, [], 'and a shutdown is not an error to file')
  // Nothing holds the file: on Windows an unclosed handle is a delete that fails.
  cleanup(dir)
  assert.equal(existsSync(dir), false)
})

test('THE SEAM IS PURE DATA: take folds and resets, peek is a ring and is never drained', () => {
  resetTailIoStats()
  assert.equal(takeTailIoSummary(), null, 'no reads is not a row of zeros')
  assert.deepEqual(peekTailIoTimeline(), [])

  const sample = (over: Partial<TailIoSample> = {}): TailIoSample => ({
    at: 1,
    statMs: 0.5,
    openMs: 0,
    readMs: 2,
    bytes: 100,
    slices: 1,
    reason: 'reused',
    ...over
  })
  noteTailRead(sample({ reason: 'first', openMs: 4 }))
  noteTailRead(sample())
  noteTailRead(sample({ readMs: 120 }))
  noteTailRead(sample({ readMs: 640, reason: 'error' }))

  const s = takeTailIoSummary()
  assert.ok(s)
  assert.equal(s.reads, 4)
  assert.equal(s.reopens, 2)
  assert.equal(s.bytes, 400)
  assert.equal(s.slices, 4)
  assert.equal(s.openMs, 4)
  assert.equal(s.maxReadMs, 640)
  assert.equal(s.over100, 2)
  assert.equal(s.over500, 1)
  assert.deepEqual(s.byReason, { reused: 2, first: 1, replaced: 0, shrunk: 0, error: 1 })
  // FOLD + RESET, the pending-delta discipline: nothing is reported twice.
  assert.equal(takeTailIoSummary(), null)
  // …and the ring is a different question, so the fold did not consume it.
  assert.equal(peekTailIoTimeline().length, 4)

  // A returned summary is a COPY: mutating it cannot reach back into the accumulator.
  noteTailRead(sample())
  const taken = takeTailIoSummary()
  assert.ok(taken)
  taken.reads = 999
  taken.byReason.reused = 999
  noteTailRead(sample())
  assert.equal(takeTailIoSummary()?.reads, 1)

  resetTailIoStats()
  for (let i = 0; i < TAIL_IO_RING + 25; i++) noteTailRead(sample({ at: i }))
  const ring = peekTailIoTimeline()
  assert.equal(ring.length, TAIL_IO_RING, 'the ring is bounded')
  assert.equal(ring[0]?.at, 25, 'and it drops the OLDEST')
  assert.equal(ring[ring.length - 1]?.at, TAIL_IO_RING + 24)
  // Non-finite input records as 0 rather than poisoning a total with NaN.
  resetTailIoStats()
  noteTailRead(sample({ readMs: Number.NaN, statMs: Number.POSITIVE_INFINITY, bytes: -5 }))
  const bad = takeTailIoSummary()
  assert.equal(bad?.readMs, 0)
  assert.equal(bad?.statMs, 0)
  assert.equal(bad?.bytes, 0)
  resetTailIoStats()
})

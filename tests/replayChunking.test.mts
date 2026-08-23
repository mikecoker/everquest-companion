// ============================================================================
// replayChunking.test.mts — the chunked startup replay (docs/plans/chunked-replay.md §4).
// ============================================================================
//
// Two claims are tested here, and they are the two the change lives or dies by.
//
// EQUIVALENCE. Chunking interleaves event-loop turns into the SAME sequential fold, so the event
// stream must be BYTE-IDENTICAL to the unchunked one — same events, same order, same seq numbers,
// same `live:false`, same `endOffset`. The oracle is the repo's own golden fixtures (proc, combat,
// leveling and the rest), concatenated into one log and folded twice: once with `unchunkedSlicer()`
// (the control — exactly the code path that existed before replaySlicer.ts) and once with a slicer
// that yields after EVERY SINGLE EVENT, which is the most aggressive interleaving the design can
// ever produce. A downstream module (BuffsModule — the one fold that is Electron-free and stateful
// enough to notice) is run over both streams as a second opinion: if the events are identical the
// modules cannot disagree, and this asserts that rather than assuming it.
//
// THE LIVE HANDOFF. The plan's rule: "replay drains to EOF, then the tail goes live; a line may
// never be folded twice or skipped." This app has no buffer-then-drain — the scan freezes EOF at
// `stat()` time and returns the byte offset of the last COMPLETE line it consumed, and session.ts
// starts the Tailer at exactly that offset. So the test appends to the log FROM INSIDE A YIELD
// (the slicer's `yieldTo` seam makes that a deterministic mid-scan write rather than a race) and
// proves the appended bytes are untouched by the scan and picked up whole from `endOffset`.
//
// AND SINCE JOS-50, THE DUTY CYCLE. The slicer now RESTS on a real timer between slices so the
// fold cannot hold a core flat out for the whole replay. Two things follow, and both are tested
// below. First, the rest length is not the number passed to `setTimeout` — Windows rounds a sleep
// up to its 15.6 ms quantum — so the duty is held by a debt LEDGER that measures each rest and
// skips the next one when the OS overshot; a fake coarse timer drives that here, because a duty
// cycle tested by actually waiting is a test nobody runs. Second, a pause cannot change an answer:
// the equivalence arm is folded in the RESTING mode too (with an instant fake timer), so the
// oracle covers the yield mode production actually uses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogBus } from '../src/main/log/bus'
import { scanLog } from '../src/main/log/scanHistory'
import {
  REPLAY_DUTY,
  REPLAY_MAX_REST_CREDIT_MS,
  REPLAY_SLICE_MS,
  createSlicer,
  unchunkedSlicer,
  type Slicer
} from '../src/main/log/replaySlicer'
import { BuffsModule } from '../src/main/modules/buffs'
import { FIXTURES } from './harness.mjs'
import type { LogEvent } from '../src/shared/logEvents'

// ------------------------------------------------------------------------------- the slicer

test('the slice budget is honoured against a FAKE clock — a budget you can only test by waiting is untested', async () => {
  let clock = 0
  let yields = 0
  const slicer = createSlicer({
    budgetMs: 12,
    // duty 1 — this test is about the BUDGET. The duty cycle is tested on its own below, and
    // leaving it on here would send every yield down the resting path instead of `yieldTo`.
    duty: 1,
    now: () => clock,
    yieldTo: async () => {
      yields += 1
      // A yield is not free and is not instant: charge it, so the next slice cannot silently
      // inherit the time the event loop spent serving everybody else.
      clock += 100
      await Promise.resolve()
    }
  })

  // Eleven 1 ms events fit inside a 12 ms budget; the twelfth crosses it.
  for (let i = 0; i < 11; i++) {
    clock += 1
    assert.equal(slicer.expired(), false, `event ${String(i)} is still inside the budget`)
  }
  clock += 1
  assert.equal(slicer.expired(), true, 'at the budget, the slice is over')
  await slicer.yield()
  assert.equal(yields, 1)
  assert.equal(slicer.slices, 1)
  // The new slice is measured from AFTER the yield returned (clock 112), not from before it.
  clock += 11
  assert.equal(slicer.expired(), false, 'the next slice gets its own full budget')
  clock += 1
  assert.equal(slicer.expired(), true)
})

test('a single MONSTER event still yields after it — the budget is never skipped, only overshot', async () => {
  // The check happens after an event is folded, which is the only place it can happen: an event is
  // not divisible. So the contract is "one event may overshoot, and the very next thing that
  // happens is a yield" — never "the overshoot swallows the yield and folding continues".
  let clock = 0
  let yields = 0
  const slicer = createSlicer({
    budgetMs: REPLAY_SLICE_MS,
    duty: 1,
    now: () => clock,
    yieldTo: () => {
      yields += 1
      return Promise.resolve()
    }
  })
  clock += 5_000 // one pathological line
  assert.equal(slicer.expired(), true, 'an event far past the budget leaves the slice expired')
  await slicer.yield()
  assert.equal(yields, 1, 'and the yield happens — the overshoot does not cancel it')
  assert.equal(slicer.expired(), false, 'the overshoot is not carried into the next slice as debt')
})

test('the UNCHUNKED control never yields, however long the fold runs', () => {
  // The control arm has to be genuinely inert or the equivalence test below compares two chunked
  // folds and proves nothing. An infinite budget is never `<=` any clock reading, so no amount of
  // simulated (or real) time expires it.
  let clock = 0
  const faked = createSlicer({ budgetMs: Number.POSITIVE_INFINITY, now: () => clock })
  const real = unchunkedSlicer()
  for (let i = 0; i < 1_000; i++) {
    clock += 1_000_000
    assert.equal(faked.expired(), false)
    assert.equal(real.expired(), false)
  }
  assert.equal(faked.slices, 0)
  assert.equal(real.slices, 0)
})

// ---------------------------------------------------------------------------- the duty cycle

/**
 * Drive `slices` slices of `workMs` each through a slicer whose clock and timer are both fakes,
 * and report what the ledger achieved. The timer is a FUNCTION of the requested rest, which is
 * the whole point: on Windows the two are not the same number and the ledger exists to close
 * that gap.
 */
async function driveDuty(opts: {
  slices: number
  workMs: number
  duty?: number
  /** Given the clock and the rest that was asked for, where does the clock land? */
  deliver: (clock: number, askedMs: number) => number
}): Promise<{ slicer: Slicer; rests: number; restAt: number[]; achieved: number }> {
  let clock = 0
  let rests = 0
  let slice = 0
  const restAt: number[] = []
  const slicer = createSlicer({
    budgetMs: opts.workMs,
    ...(opts.duty === undefined ? {} : { duty: opts.duty }),
    now: () => clock,
    yieldTo: () => Promise.resolve(),
    restFor: (askedMs: number) => {
      rests += 1
      restAt.push(slice)
      clock = opts.deliver(clock, askedMs)
      return Promise.resolve()
    }
  })
  for (slice = 0; slice < opts.slices; slice++) {
    clock += opts.workMs
    assert.equal(slicer.expired(), true, `slice ${String(slice)} used its whole budget`)
    await slicer.yield()
  }
  const total = slicer.workMs + slicer.restMs
  return { slicer, rests, restAt, achieved: total > 0 ? slicer.workMs / total : 0 }
}

/** The longest run of consecutive slices that folded without resting. */
function longestUnthrottledRun(restAt: readonly number[], slices: number): number {
  let worst = 0
  let previous = -1
  for (const at of [...restAt, slices]) {
    worst = Math.max(worst, at - previous - 1)
    previous = at
  }
  return worst
}

/** Windows' timer quantum, MEASURED in the Electron main process (see replaySlicer.ts): a sleep
 *  ends at the next 15.6 ms tick edge after the time you asked for, not at the time you asked. */
const QUANTUM_MS = 15.6
const onTheGrid = (clock: number, askedMs: number): number =>
  Math.ceil((clock + askedMs) / QUANTUM_MS) * QUANTUM_MS

test('THE DUTY LEDGER HOLDS 60% THROUGH A COARSE WINDOWS TIMER, which no fixed setTimeout can', async () => {
  // The measurement this encodes: after a 12 ms burn, `setTimeout(8)` on this machine returns in
  // ~19.2 ms, because 12 + 8 overshoots one 15.6 ms tick and the sleep waits out the second. A
  // slicer that simply slept 8 ms would therefore run at 12/31.2 = 38% duty, not 60% — so the
  // rest is bookkept: each overshoot leaves a credit, and the next slices spend it by not
  // resting at all.
  const { slicer, rests, achieved } = await driveDuty({
    slices: 400,
    workMs: REPLAY_SLICE_MS,
    deliver: onTheGrid
  })
  assert.ok(
    Math.abs(achieved - REPLAY_DUTY) < 0.02,
    `achieved duty ${achieved.toFixed(3)} should converge on ${String(REPLAY_DUTY)} (rested ${String(slicer.restMs)}ms over ${String(slicer.workMs)}ms of work)`
  )
  // …and it gets there by resting SOME of the time, not by resting a little every slice: the
  // grid gives ~19 ms when 8 is owed, so roughly two slices in three skip the rest entirely.
  assert.ok(rests > 0 && rests < 400, `some slices rest and some do not (${String(rests)}/400)`)
  assert.equal(slicer.slices, 400)
})

test('…and it holds the same 60% through a FINE timer, where the sleep is simply honoured', async () => {
  // The other machine: something in the process has raised the timer resolution and a sleep lasts
  // as long as it was told to. The ledger must not overcorrect for a timer that never overshoots.
  const { slicer, rests, achieved } = await driveDuty({
    slices: 200,
    workMs: REPLAY_SLICE_MS,
    deliver: (clock, askedMs) => clock + askedMs
  })
  assert.ok(
    Math.abs(achieved - REPLAY_DUTY) < 0.005,
    `achieved duty ${achieved.toFixed(3)} with an exact timer`
  )
  assert.equal(rests, 200, 'every slice rests when every rest is exactly the length it asked for')
  assert.equal(Math.round(slicer.restMs), Math.round(slicer.workMs * ((1 - REPLAY_DUTY) / REPLAY_DUTY)))
})

test('a duty of 1 never rests at all — the pre-JOS-50 behaviour, still reachable for the oracle', async () => {
  const { slicer, rests, achieved } = await driveDuty({
    slices: 50,
    workMs: REPLAY_SLICE_MS,
    duty: 1,
    deliver: onTheGrid
  })
  assert.equal(rests, 0)
  assert.equal(slicer.restMs, 0)
  assert.equal(achieved, 1)
})

test('a rest the OS overshot by half a second buys a BOUNDED credit, never a burst of free slices', async () => {
  // The hazard the cap exists for: if the machine takes the process away mid-rest, the fold was
  // genuinely idle for that whole time — but banking it as credit would let the next slices fold
  // back to back at 100% for as long as the credit lasts, which is the exact spike this feature
  // exists to prevent. Uncapped, one 5 s rest would pay for 625 slices at 8 ms of debt each.
  let first = true
  const slices = 40
  const { restAt } = await driveDuty({
    slices,
    workMs: REPLAY_SLICE_MS,
    deliver: (clock, askedMs) => {
      if (!first) return onTheGrid(clock, askedMs)
      first = false
      return clock + 5_000
    }
  })
  // Credit is capped at REPLAY_MAX_REST_CREDIT_MS and each slice adds 8 ms of debt, so no more
  // than four slices in a row can be unthrottled — uncapped, that one rest would have paid for
  // 625 of them, i.e. seven and a half seconds of the fold at full tilt.
  const debtPerSlice = REPLAY_SLICE_MS * ((1 - REPLAY_DUTY) / REPLAY_DUTY)
  const maxFreeSlices = Math.ceil(REPLAY_MAX_REST_CREDIT_MS / debtPerSlice)
  const run = longestUnthrottledRun(restAt, slices)
  assert.ok(
    run <= maxFreeSlices,
    `at most ${String(maxFreeSlices)} consecutive unthrottled slices; the worst run was ${String(run)}`
  )
  assert.ok(Math.ceil(5_000 / debtPerSlice) > 100, 'and uncapped that credit would have paid for hundreds')
})

test('an over-budget MONSTER slice buys ITSELF more rest — the debt is a function of work done', async () => {
  let clock = 0
  let asked = 0
  const slicer = createSlicer({
    budgetMs: REPLAY_SLICE_MS,
    now: () => clock,
    yieldTo: () => Promise.resolve(),
    restFor: (ms: number) => {
      asked = ms
      clock += ms
      return Promise.resolve()
    }
  })
  clock += 120 // one pathological line, ten budgets long
  await slicer.yield()
  // 120 ms of folding at a 60% duty owes 80 ms of rest, not the 8 ms a fixed pause would give it.
  assert.equal(Math.round(asked), 80)
  assert.equal(Math.round(slicer.workMs), 120)
  assert.equal(Math.round(slicer.restMs), 80)
})

// --------------------------------------------------------------------------- the fold, twice

/** Every committed golden fixture, concatenated — the proc / combat / leveling windows and the
 *  rest, in one deterministic order, so both arms fold exactly the same bytes. */
function goldenCorpus(): string {
  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.log'))
    .sort()
  assert.ok(names.length > 10, `expected the committed fixtures to be present (found ${String(names.length)})`)
  return names.map((n) => readFileSync(join(FIXTURES, n), 'utf8').replace(/\r?\n?$/, '\n')).join('')
}

interface Folded {
  /** Every event the bus saw, as JSON — the byte-for-byte comparison subject. */
  events: string[]
  live: boolean[]
  endOffset: number
  seq: number
  /** A downstream module's final state, as a second opinion on "the modules cannot disagree". */
  buffs: string
}

/**
 * One arm of the comparison. `'unchunked'` is the control; a number is a slice budget with the
 * duty cycle OFF (the pre-JOS-50 `setImmediate` path); `{ budgetMs, resting: true }` is the path
 * production takes, with an INSTANT fake timer standing in for the OS.
 *
 * The fake timer is not a shortcut around the thing being tested — the duty ledger is tested on
 * its own above, with a fake clock. Here the only question is whether a PAUSE changes an answer,
 * and a pause of zero exercises exactly the same branch as a pause of 15.6 ms while leaving the
 * suite runnable: the corpus yields after every event, so real rests would be hours.
 */
type Arm = 'unchunked' | number | { budgetMs: number; resting: true }

function armSlicer(arm: Arm): Slicer {
  if (arm === 'unchunked') return unchunkedSlicer()
  if (typeof arm === 'number') return createSlicer({ budgetMs: arm, duty: 1 })
  return createSlicer({ budgetMs: arm.budgetMs, restFor: () => Promise.resolve() })
}

function armName(arm: Arm): string {
  if (arm === 'unchunked') return 'unchunked'
  if (typeof arm === 'number') return `budget ${String(arm)}ms, no rest`
  return `budget ${String(arm.budgetMs)}ms, RESTING`
}

async function fold(logPath: string, arm: Arm): Promise<Folded> {
  const bus = new LogBus()
  const events: string[] = []
  const live: boolean[] = []
  const mod = new BuffsModule()
  mod.reset()
  bus.subscribe((ev: LogEvent, isLive: boolean) => {
    events.push(JSON.stringify(ev))
    live.push(isLive)
    mod.onEvent(ev, isLive)
  })
  const res = await scanLog(logPath, bus, 0, { slicer: armSlicer(arm) })
  return {
    events,
    live,
    endOffset: res.endOffset,
    seq: res.seq,
    // `overlay.updatedAt` is dropped, and it is the ONE field that is: the message-overlay miner
    // stamps it with `new Date()` when the SNAPSHOT is taken (messageOverlay.ts), so it says when
    // this test read the module, not what the module folded. Two unchunked folds disagree about it
    // too. Everything else — every active, every mined duration, every learned message — is
    // compared exactly, and this fold-order-sensitive module is the point of the exercise.
    buffs: JSON.stringify(mod.snapshot().state, (key, value: unknown) =>
      key === 'updatedAt' ? undefined : value
    )
  }
}

test('CHUNKED AND UNCHUNKED FOLDS ARE BYTE-IDENTICAL over the golden fixtures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-chunk-'))
  const logPath = join(dir, 'eqlog_Corpus_bench.txt')
  try {
    writeFileSync(logPath, goldenCorpus(), 'utf8')

    const control = await fold(logPath, 'unchunked')
    assert.ok(control.events.length > 1_000, `the corpus should fold thousands of events (${String(control.events.length)})`)

    // budget 0 ⇒ a yield after EVERY event: the most interleaving this design can ever produce.
    // REPLAY_SLICE_MS is what production actually runs, and is checked beside it — in BOTH yield
    // modes, because since JOS-50 the production yield is a rest and the oracle has to cover the
    // code path that ships, not the one that used to.
    const arms: Arm[] = [0, REPLAY_SLICE_MS, { budgetMs: 0, resting: true }, { budgetMs: REPLAY_SLICE_MS, resting: true }]
    for (const arm of arms) {
      const name = armName(arm)
      const chunked = await fold(logPath, arm)
      assert.equal(chunked.events.length, control.events.length, `${name}: same event count`)
      assert.equal(
        chunked.events.join('\n'),
        control.events.join('\n'),
        `${name}: the event stream is identical, event for event and field for field`
      )
      assert.deepEqual(chunked.live, control.live, `${name}: every event is still live:false`)
      assert.equal(chunked.endOffset, control.endOffset, `${name}: same byte handoff point`)
      assert.equal(chunked.seq, control.seq, `${name}: same monotonic seq`)
      assert.equal(chunked.buffs, control.buffs, `${name}: the module folded to the same state`)
    }
    assert.equal(control.live.every((l) => l === false), true, 'the historical scan is live:false throughout')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------- the live handoff (EOF)

const LINE = (n: number): string => `[Mon Aug 04 12:00:${String(n % 60).padStart(2, '0')} 2026] You have become better at Testing! (${String(n)})`

test('the scan drains to a FROZEN EOF: a line appended mid-scan is neither folded twice nor skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-handoff-'))
  const logPath = join(dir, 'eqlog_Handoff_bench.txt')
  try {
    // 400 complete lines, then a TRAILING PARTIAL with no newline — the shape a live log always
    // has, because the game is mid-write.
    const complete = Array.from({ length: 400 }, (_, i) => `${LINE(i)}\n`).join('')
    const partial = LINE(400) // no '\n'
    writeFileSync(logPath, complete + partial, 'utf8')
    const frozenBytes = Buffer.byteLength(complete + partial, 'utf8')

    // Append DURING the scan, from inside the first yield — deterministic, not a race.
    let appended = false
    const appendOnFirstYield = async (): Promise<void> => {
      if (!appended) {
        appended = true
        appendFileSync(logPath, `\n${LINE(401)}\n${LINE(402)}\n`, 'utf8')
      }
      await Promise.resolve()
    }

    const bus = new LogBus()
    const seen: string[] = []
    bus.subscribe((ev) => seen.push(ev.raw))
    const res = await scanLog(logPath, bus, 0, {
      // duty 1 so the yield goes through `yieldTo` — which is this test's instrument, not its
      // subject: the append has to happen at a known point mid-scan, and the rest path would
      // route around it.
      slicer: createSlicer({ budgetMs: 0, duty: 1, yieldTo: appendOnFirstYield })
    })

    assert.equal(appended, true, 'the mid-scan append actually happened (the slicer yielded)')
    assert.equal(seen.length, 400, 'exactly the 400 COMPLETE lines that existed when EOF was frozen')
    assert.equal(seen[0], LINE(0))
    assert.equal(seen[399], LINE(399))
    assert.equal(
      res.endOffset,
      Buffer.byteLength(complete, 'utf8'),
      'endOffset stops at the last complete line — the trailing partial is left for the tailer'
    )
    assert.ok(res.endOffset < frozenBytes, 'and it is short of the frozen EOF by exactly the partial line')

    // THE HANDOFF, replayed the way session.ts does it: the tailer starts at endOffset. Every byte
    // of the file from there on is unread — the completed partial line and both appended lines,
    // each exactly once, and nothing the scan already folded.
    const tail = readFileSync(logPath, 'utf8').slice(res.endOffset)
    const tailLines = tail.split('\n').filter((l) => l.length > 0)
    assert.deepEqual(tailLines, [LINE(400), LINE(401), LINE(402)], 'the tail picks up exactly where the scan stopped')
    const all = [...seen, ...tailLines]
    assert.equal(new Set(all).size, all.length, 'no line is folded twice across the seam')
    assert.equal(all.length, 403, 'and none is skipped: 400 replayed + 3 tailed = every line in the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty or missing log yields nothing and hands the tailer offset 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-empty-'))
  try {
    const empty = join(dir, 'eqlog_Empty_bench.txt')
    writeFileSync(empty, '', 'utf8')
    const bus = new LogBus()
    let count = 0
    bus.subscribe(() => (count += 1))
    // `size` is the frozen EOF the scan bounded itself by (JOS-57's scope addition uses it as the
    // cold-read delta's "how big is it now"). An empty file and a missing one are both 0 — and no
    // `firstMbMs`, because a megabyte was never read.
    assert.deepEqual(await scanLog(empty, bus, 0, { slicer: createSlicer({ budgetMs: 0, duty: 1 }) }), {
      endOffset: 0,
      seq: 0,
      size: 0
    })
    assert.deepEqual(await scanLog(join(dir, 'nope.txt'), bus, 7), { endOffset: 0, seq: 7, size: 0 })
    assert.equal(count, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// JOS-203 — A BAR YOU DISMISS STAYS DISMISSED, AND THE LEARNER NEVER NOTICES.
//
// Report 01KZQ6QAWKX8W6VNTKFRP69NZ5 asked for "some method to manually clear buffs/debuffs" and
// named the case that makes it necessary: a debuff on a mob you kill OUT OF LOG RANGE prints no
// death line, so nothing in the world states that it ended and the bar serves its whole stated
// duration plus grace, sorting above the rows that are real.
//
// TWO HALVES, AND THIS FILE PINS BOTH.
//
//   1. THE DISPLAY VERDICT. Dismissal is a pure function over ROWS (shared/buffTimers.ts) held in
//      the overlay window that drew them. The tests below state what it may say — it suppresses one
//      READING of one row, and a fresh landing draws again — and, more importantly, what it can
//      never touch: the instance, the open record, and the duration the learner is waiting to mint.
//      "The learner never notices" is structural, so the test for it is the dismiss-then-learn case:
//      dismiss the bar, let the wear-off arrive later, and the sample still lands.
//
//   2. THE LEARNING-RECORD RETENTION. The characterization found the genuine defect beside the
//      feature: the unwitnessed cull deletes the ACTIVE row and deliberately keeps the OPEN record
//      (JOS-156), but the only reaper for that record ran through the active loop — so once the cull
//      fired the record had none at all. It sat in an unbounded map, and the next landing of that
//      spell on a same-named mob inherited the stale group: the ancient landing's clock with the old
//      count chip, instantly overdue, culled again before it could be read. Both halves of the model
//      now retire a learning record at 3× the DB base (buffsShapes.ts `learningRecordCapMs`) — the
//      owner's ruling that a record ages on the FLOOR's scale and never on the display grace.
//
// The model cases drive the REAL BuffInstances / BuffsModule / BuffTimersModule with the typed
// events the parser emits (the buffOverlayDuration.test.mts pattern), because the subject is the
// retention arithmetic and the sample minting, not the message grammar — which is pinned elsewhere.

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadSpellDb } from '../src/main/data/spellDb.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { BuffInstances } from '../src/main/modules/buffsInstances.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { BuffTimersModule } from '../src/main/modules/buffTimers.ts'
import { CC_UNKNOWN_CAP_MS } from '../src/main/modules/buffTimers.ts'
import { PetEntities } from '../src/main/modules/buffsEntities.ts'
import { SpellStats } from '../src/main/modules/buffsStats.ts'
import {
  HYGIENE_ABSOLUTE_MS,
  LEARNING_RECORD_DB_MULTIPLE,
  learningRecordCapMs,
  spellKey,
  unwitnessedTimeoutMs
} from '../src/main/modules/buffsShapes.ts'
import { SELF_CASTER, learnKey } from '../src/shared/buffTrust.ts'
import {
  type BuffTimerRow,
  type TimerDismissal,
  MAX_TIMER_DISMISSALS,
  buildTimerRows,
  dismissTimerRows,
  isTimerDismissed,
  timerDismissalOf,
  withTimerDismissal
} from '../src/shared/buffTimers.ts'
import type { LogEvent } from '../src/shared/logEvents.ts'
import type { BuffsSnap } from '../src/shared/types.ts'

/** A slow with a real DB row: `Shiftless Deeds`, Detrimental, 2m30s in the committed spells.json. */
const SLOW = 'Shiftless Deeds'
const SLOW_DB_MS = 150_000
/** The mob the report is about: one you killed out of log range, so no line ever ends its debuff. */
const MOB = 'a fire giant warrior'
const T0 = 1_700_000_000_000

// =============================================================================================
// 1. THE DISPLAY VERDICT — what a dismissal may say (pure rows, no model at all).
// =============================================================================================

function row(over: Partial<BuffTimerRow> = {}): BuffTimerRow {
  return {
    id: 'target|a fire giant warrior|shiftless deeds',
    kind: 'debuff',
    name: SLOW,
    group: 'target',
    target: MOB,
    targetKey: MOB,
    startedTs: T0,
    mode: 'countdown',
    durationMs: SLOW_DB_MS,
    ...over
  }
}

test('a dismissed row leaves the surface, and nothing else does', () => {
  const other = row({ id: 'target|a scareling|shiftless deeds', target: 'a scareling' })
  const dismissals = withTimerDismissal(new Map(), row())
  const shown = dismissTimerRows([row(), other], dismissals)
  assert.deepEqual(shown.map((r) => r.id), [other.id], 'only the bar the user cleared is gone')
})

test('…and it STAYS gone across the next delta, which replaces the whole row set', () => {
  // Both modules ship their entire state on every flush, so every delta and every re-hydrate hands
  // the window a brand-new row object. The verdict is re-applied to it, which is the whole reason
  // it names a reading (id + clock + count) rather than holding a reference to a row.
  const dismissals = withTimerDismissal(new Map(), row())
  for (const nextSet of [[row()], [row()], [row()]]) {
    assert.equal(dismissTimerRows(nextSet, dismissals).length, 0, 'a fresh copy of the same reading stays cleared')
  }
})

test('A FRESH LANDING DRAWS AGAIN — a dismissal is not a mute button on the spell', () => {
  const dismissals = withTimerDismissal(new Map(), row())
  const recast = row({ startedTs: T0 + 60_000 })
  assert.equal(isTimerDismissed(recast, dismissals), false, 'a later clock is not the bar that was cleared')
  assert.deepEqual(dismissTimerRows([recast], dismissals).map((r) => r.id), [recast.id])
})

test('…and so does another mob of that name joining the row (the count chip moved)', () => {
  const dismissals = withTimerDismissal(new Map(), row())
  // JOS-140's group: a second mob of one name joins the row and the OLDEST landing keeps the clock,
  // so the clock alone cannot tell this apart from the bar that was dismissed. The count can.
  assert.equal(isTimerDismissed(row({ count: 2 }), dismissals), false)
  // And the reverse is not new evidence: a row that shed a landing is still the one cleared.
  const two = withTimerDismissal(new Map(), row({ count: 2 }))
  assert.equal(isTimerDismissed(row({ count: 1 }), two), true)
})

test('the verdict is bounded — the set never grows past the cap, and keeps the NEWEST', () => {
  let dismissals: ReadonlyMap<string, TimerDismissal> = new Map()
  const ids: string[] = []
  for (let i = 0; i < MAX_TIMER_DISMISSALS + 10; i++) {
    const r = row({ id: `target|mob${String(i)}|shiftless deeds` })
    ids.push(r.id)
    dismissals = withTimerDismissal(dismissals, r)
  }
  assert.equal(dismissals.size, MAX_TIMER_DISMISSALS, 'an unbounded set is the other half of this ticket')
  assert.equal(dismissals.has(ids[ids.length - 1]), true, 'the most recent verdict survives')
  assert.equal(dismissals.has(ids[0]), false, 'the oldest is the one evicted')
})

test('re-dismissing a row refreshes its place in the queue rather than adding a second entry', () => {
  const first = withTimerDismissal(new Map(), row())
  const again = withTimerDismissal(first, row({ startedTs: T0 + 1_000 }))
  assert.equal(again.size, 1)
  assert.deepEqual(again.get(row().id), { startedTs: T0 + 1_000, count: 1 })
})

test('timerDismissalOf reads the row exactly as drawn — a chipless row is a count of one', () => {
  assert.deepEqual(timerDismissalOf(row()), { startedTs: T0, count: 1 })
  assert.deepEqual(timerDismissalOf(row({ count: 3 })), { startedTs: T0, count: 3 })
})

// =============================================================================================
// 2. THE LEARNER NEVER NOTICES — dismiss the bar, and the wear-off still teaches.
// =============================================================================================

/** A fresh DB-backed buffs module plus a monotonic feeder (buffOverlayDuration.test.mts's shape). */
function makeModule(): { mod: BuffsModule; feed: (ev: Omit<LogEvent, 'seq'>) => void } {
  const db = loadSpellDb()
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0
  const feed = (ev: Omit<LogEvent, 'seq'>): void => {
    mod.onEvent({ ...ev, seq: seq++ } as LogEvent)
  }
  return { mod, feed }
}

function castBegin(spell: string, ts: number): Omit<LogEvent, 'seq'> {
  return { kind: 'castBegin', ts, raw: `[x] You begin casting ${spell}.`, spell }
}
function buffApply(spell: string, target: string, durationMs: number, ts: number): Omit<LogEvent, 'seq'> {
  return {
    kind: 'buffApply',
    ts,
    raw: `[x] ${spell} landed on ${target}.`,
    spell,
    target,
    illusion: false,
    durationMs,
    candidates: [{ name: spell, durationMs, illusion: false }]
  }
}
function buffFade(spell: string, ts: number, target?: string): Omit<LogEvent, 'seq'> {
  return { kind: 'buffFade', ts, raw: `[x] ${spell} wore off.`, spell, ...(target != null ? { target } : {}) }
}
/** An inert event that only advances the module's clock — a keep-alive, not a buff signal. */
function keepAlive(ts: number): Omit<LogEvent, 'seq'> {
  return { kind: 'aaActivate', ts, raw: '[x] You activate Mend.', name: 'Mend' }
}

function rowsOf(snap: BuffsSnap): BuffTimerRow[] {
  return buildTimerRows(snap, { holds: [], ends: [] })
}

test('DISMISS-THEN-LEARN: clearing the bar hides it and the later wear-off still mints its sample', () => {
  const { mod, feed } = makeModule()
  feed(castBegin(SLOW, T0))
  feed(buffApply(SLOW, MOB, SLOW_DB_MS, T0 + 1_000))

  const before = rowsOf(mod.snapshot().state)
  const slow = before.find((r) => r.name === SLOW)
  assert.ok(slow, 'the slow is on the debuffs surface')

  // THE DISMISSAL. It happens in the renderer, over the rows — there is no call into the model to
  // make here, and that absence IS the ruling: no path exists for the learner to hear about it.
  const dismissals = withTimerDismissal(new Map(), slow)
  assert.equal(dismissTimerRows(before, dismissals).some((r) => r.name === SLOW), false, 'the bar is gone')

  // …and the model is byte-for-byte what it was: the instance is live and the open record is intact.
  assert.equal(mod.snapshot().state.active.some((a) => a.spell === SLOW), true, 'the instance never heard about it')

  // The wear-off arrives LATER — the player walked back into range — and teaches the real duration.
  const fade = T0 + 1_000 + 200_000
  feed(keepAlive(T0 + 100_000))
  feed(buffFade(SLOW, fade, MOB))
  const stat = mod.snapshot().state.stats[spellKey(SLOW)]
  assert.ok(stat, 'the Buffs tab knows about the line')
  assert.equal(stat.n, 1, 'one clean cycle closed')
  assert.equal(stat.maxMs, 200_000, 'the span the log stated, unaffected by the dismissal')
  assert.equal(stat.estimateMs, 200_000)
  assert.equal(stat.estimatorSource, 'observed', 'the observation beat the 150 s DB floor')
})

// =============================================================================================
// 3. THE ORPHANED-RECORD REAPER — the stale-open regression, on the real instance store.
// =============================================================================================

/** A bare instance store over the real spell DB — the maps this ticket is about are public here. */
function makeInstances(): { inst: BuffInstances; stats: SpellStats } {
  const db = loadSpellDb()
  const stats = new SpellStats(db)
  const inst = new BuffInstances(stats, new PetEntities(), () => undefined)
  return { inst, stats }
}

/** One landing of the slow on `MOB`, exactly as `applyMessageBuff` receives it from the module. */
function land(inst: BuffInstances, ts: number): void {
  inst.applyMessageBuff(SLOW, { target: MOB, ts, illusion: false, durationMs: SLOW_DB_MS })
}

test('the unwitnessed cull takes the ROW and keeps the record — JOS-156, unchanged', () => {
  const { inst } = makeInstances()
  land(inst, T0)
  // 150 s stated + 60 s DB grace = the row is gone at 210 s, which is the owner's anti-squatting
  // ruling and is not what this ticket touches.
  inst.sweepHygiene(T0 + SLOW_DB_MS + unwitnessedTimeoutMs('db') + 1_000)
  assert.equal(inst.active.size, 0, 'no bar squats at 0s')
  assert.equal(inst.open.size, 1, 'and the record a late wear-off would pair with is still there')
})

test('…and it is REAPED at 3x the DB base, which nothing used to do at all', () => {
  const { inst } = makeInstances()
  land(inst, T0)
  const cap = learningRecordCapMs(SLOW_DB_MS, HYGIENE_ABSOLUTE_MS)
  assert.equal(cap, 3 * SLOW_DB_MS, '450 s for a 150 s slow')

  // One second before the cap the record is still a CHANCE, not a leak.
  inst.sweepHygiene(T0 + cap - 1_000)
  assert.equal(inst.open.size, 1)
  // Past it, we lost the thread: the line is not late, it is not coming.
  inst.sweepHygiene(T0 + cap + 1_000)
  assert.equal(inst.open.size, 0, 'the unbounded map is bounded')
})

test('a record with a LIVE row behind it is never reaped — only orphans are', () => {
  const { inst } = makeInstances()
  // A SELF buff is exempt from the unwitnessed cull (its wear-off prints to you), so its row is
  // still standing long past 3x the DB base — and its record must stand with it.
  inst.applyMessageBuff('Valor', { target: 'self', ts: T0, illusion: false, durationMs: 3_240_000 })
  inst.sweepHygiene(T0 + 4 * 60_000)
  assert.equal(inst.active.size, 1, 'the self buff is still up')
  assert.equal(inst.open.size, 1, 'so its record is untouched — the reaper only takes orphans')
})

test('THE STALE-OPEN REGRESSION: a fresh landing after a reaped record draws FRESH, count 1', () => {
  const { inst } = makeInstances()
  // An AE round: two mobs of one name slowed in the same second. One row, count 2 (JOS-140).
  land(inst, T0)
  land(inst, T0)
  assert.equal([...inst.active.values()][0].count, 2, 'the round is a count of two')

  // You kill them OUT OF LOG RANGE. No death line, no wear-off: the cull takes the row on schedule
  // and, before this ticket, the record it left behind lived forever.
  const later = T0 + learningRecordCapMs(SLOW_DB_MS, HYGIENE_ABSOLUTE_MS) + 60_000
  inst.sweepHygiene(later - 1_000)

  // The next fight, on another mob of the same name. WITHOUT THE REAPER this landing joins the
  // stale group: `HoldGroup.land` sees a group of two, refreshes the NEWEST of them, and leaves the
  // OLDEST landing's ancient clock as the row's — measured, a bar drawn at count 2 and eight
  // minutes overdue, culled again by the very next sweep before the player could read it.
  land(inst, later)
  const fresh = [...inst.active.values()]
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].startedTs, later, 'the clock is the landing that just happened, not the dead one')
  assert.equal(fresh[0].count ?? 1, 1, 'one mob, not three')
  assert.equal(inst.open.size, 1, 'and exactly one record stands behind it — the maps do not accumulate')

  // …and the row it draws is a live countdown rather than the instantly-overdue bar the stale
  // group produced (which the very next sweep culled before the player could read it).
  const drawn = rowsOf({ active: fresh, stats: {} }).find((r) => r.name === SLOW)
  assert.ok(drawn)
  assert.equal(drawn.mode, 'countdown')
  assert.equal(drawn.startedTs, later)
  assert.equal(drawn.count, undefined, 'no count chip on a row of one')
})

// =============================================================================================
// 4. THE SAME RULE ON THE CC HALF — symmetrical fix shapes, two models, no merge.
// =============================================================================================

test('the retention rule is one function: 3x the DB base, or the caller`s own unknown cap', () => {
  assert.equal(LEARNING_RECORD_DB_MULTIPLE, 3)
  assert.equal(learningRecordCapMs(96_000, CC_UNKNOWN_CAP_MS), 288_000, 'Dazzle: 3 x 96 s')
  assert.equal(learningRecordCapMs(null, CC_UNKNOWN_CAP_MS), CC_UNKNOWN_CAP_MS, 'nothing to multiply')
  assert.equal(learningRecordCapMs(null, HYGIENE_ABSOLUTE_MS), HYGIENE_ABSOLUTE_MS)
  // A row with a DB duration but no floor to speak of cannot produce a shorter window than 0.
  assert.equal(learningRecordCapMs(0, CC_UNKNOWN_CAP_MS), CC_UNKNOWN_CAP_MS)
})

/** Dazzle: the committed base rank's row, and the spell JOS-180's late join was measured on. */
const DAZZLE = 'Dazzle'
const DAZZLE_DB_MS = 96_000

test('a CC break past the OLD memory window still mints — the memory retires at 3x the DB base too', () => {
  const db = loadSpellDb()
  installSpellDb(db)
  const buffs = new BuffsModule(db)
  // One model, two modules (JOS-140): the CC half folds through the buffs module's own anchors and
  // mints into its own learner, exactly as modules/wiring.ts wires it.
  const timers = new BuffTimersModule(buffs.castAnchors(), buffs.spellStats())
  buffs.reset()
  timers.reset()
  let seq = 0
  const feed = (ev: Omit<LogEvent, 'seq'>): void => {
    const full = { ...ev, seq: seq++ } as LogEvent
    buffs.onEvent(full)
    timers.onEvent(full)
  }

  feed(castBegin(`${DAZZLE} IV`, T0))
  feed({
    kind: 'cc',
    ts: T0 + 1_000,
    raw: `[x] ${MOB} has been mesmerized.`,
    mob: MOB,
    candidates: [{ name: DAZZLE, durationMs: DAZZLE_DB_MS }]
  })

  // The heartbeat culls the hold on the DISPLAY schedule (96 s + 60 s), which JOS-180 left alone.
  const culled = T0 + 1_000 + DAZZLE_DB_MS + unwitnessedTimeoutMs('db') + 1_000
  timers.onTick(culled)
  assert.equal(timers.snapshot().state.holds.length, 0, 'the row died on schedule — anti-squatting is law')

  // The break line lands 200 s after the landing: PAST the old `dbFloor + 60 s` = 156 s memory, and
  // inside 3 x 96 s = 288 s. Before JOS-203 this taught nothing at all.
  const breakTs = T0 + 1_000 + 200_000
  feed({ kind: 'cc', ts: breakTs, raw: `[x] Your ${DAZZLE} spell has worn off of ${MOB}.`, mob: MOB, spell: DAZZLE, refresh: true })

  const samples = buffs.spellStats().samples.get(learnKey(spellKey(DAZZLE), SELF_CASTER))?.samples ?? []
  assert.deepEqual(samples.map((s) => s.ms), [200_000], 'the late join measured the landing it remembered')
  assert.equal(timers.snapshot().state.holds.length, 0, 'and a memory is still not a hold — no row came back')
})

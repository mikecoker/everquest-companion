// THE PROC WHOSE ONLY PRINTED LINE IS A LANDING SENTENCE (JOS-246, report
// 01KZSZC882Y2T1PQEDQXFM9VDB — src/main/combat/procDetect.ts's header carries the slice evidence
// and the registry's entry bar).
//
// The reporter's `Blessing of the Theurgist` was not "counted wrong", it was ABSENT: the whole
// cast-less detector reads EFFECT lines (a damage line, a heal line) and this proc prints
// neither. Its entire footprint is one sentence about the character it landed on, which the
// parser has always resolved correctly and which combat ingest then routed only to gates that
// count nothing — the dispel ledger, the pet binder and PROC_BUFF_CATALOG's span tracker.
//
// Its own file rather than three more sections of procDetect.test.mts, which is at its
// `max-lines` ceiling; the ratchet is a debt register and an executor does not widen it.
//
// FIXTURE-FREE ON PURPOSE, and the reason is a repo law rather than convenience: A REPORTER'S
// SLICE NEVER BECOMES A FIXTURE (AGENTS.md) — that slice is somebody's own game log. So the ONE
// sentence the owner's log has never printed is quoted VERBATIM from the report and everything
// around it is this file's own synthetic grind, in the same spirit as procDetect.test.mts §4.
// The shape rebuilt here is the shape the slice shows: six firings in 8m23s of continuous melee,
// each between the reporter's own `You crush` / `You punch` swings, with no cast line anywhere.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import {
  SELF_LANDING_PROCS,
  addSpellProc,
  laneCount,
  selfLandingProcIn,
  type SpellProcLane
} from '../src/main/combat/procDetect'

// ---------------------------------------------------------------------------------------
// 1. The registry, and the DB facts it rests on
// ---------------------------------------------------------------------------------------

test('SELF_LANDING_PROCS is verbatim from the shipped DB, and its message is UNIQUE there', () => {
  const db = loadSpellDb()
  assert.equal(SELF_LANDING_PROCS.length >= 1, true)
  for (const p of SELF_LANDING_PROCS) {
    const rows = db.spells.filter((s) => s.name === p.name)
    assert.equal(rows.length >= 1, true, `${p.name} is in the shipped DB`)
    assert.equal(rows[0].msgCastOnYou, p.applyMsg, 'never invented — copied from spells.json')
    assert.equal(rows[0].classes, p.classes)
    // THE ENTRY CONDITION, re-derived rather than trusted. The count is attributed to ONE name,
    // so the sentence producing it may not be shared with a second spell (law 3). If a future DB
    // scrape hands some other row this message, this fails before the count starts lying.
    const sharing = new Set(db.spells.filter((s) => s.msgCastOnYou === p.applyMsg).map((s) => s.name))
    assert.deepEqual([...sharing], [p.name], `"${p.applyMsg}" names exactly one spell`)
  }
})

test('the landing gate is UNAMBIGUOUS OR NOTHING — one candidate, or no count', () => {
  assert.equal(selfLandingProcIn(['Blessing of the Theurgist'])?.name, 'Blessing of the Theurgist')
  // Rank-normalized like every other join in this feature (law 2, at the counting boundary).
  assert.equal(selfLandingProcIn(['Blessing of the Theurgist II'])?.name, 'Blessing of the Theurgist')
  assert.equal(selfLandingProcIn(['Center']), undefined)
  assert.equal(selfLandingProcIn([]), undefined)
  // Deliberately stricter than procBuffInCandidates, which takes the first catalog name it finds:
  // that gate labels a SPAN, this one adds a COUNT to a NAMED LANE. A shared message makes the
  // count unattributable, so it counts nothing — never a pick.
  assert.equal(selfLandingProcIn(['Blessing of the Theurgist', 'Center']), undefined)
})

// ---------------------------------------------------------------------------------------
// 2. The third side of a lane
// ---------------------------------------------------------------------------------------

const NONE: ReadonlySet<string> = new Set()

test('a LANDING-ONLY proc counts, and moves no amount in either direction', () => {
  const lanes = new Map<string, SpellProcLane>()
  // The fold carries no `amount` FIELD at all — an `amount: 0` would enter the lane's damage
  // total as a measurement reading "it did nothing", where the truth is that nothing was
  // measured. Same discipline as `healUnstated` (AGENTS.md).
  addSpellProc(lanes, { spell: 'Blessing of the Theurgist', side: 'landing', active: NONE })
  addSpellProc(lanes, { spell: 'Blessing of the Theurgist', side: 'landing', active: NONE })
  const lane = lanes.get('blessing of the theurgist')
  assert.equal(laneCount(lane!), 2)
  assert.deepEqual(lane?.hits, { damage: 0, heal: 0, landing: 2 })
  assert.equal(lane?.damage, 0)
  assert.equal(lane?.heal, 0)
})

test('the landing side is its OWN side — `max` never adds it to a damage firing', () => {
  // A proc printing BOTH a landing sentence and a damage line is ONE firing per instant, exactly
  // like a lifetap. The third side has to be a third `max` argument for that to hold; summing
  // the sides would report two, which is the defect the tap rule was written against.
  const lanes = new Map<string, SpellProcLane>()
  addSpellProc(lanes, { spell: 'Two Sided Strike', side: 'landing', active: NONE })
  addSpellProc(lanes, { spell: 'Two Sided Strike', side: 'damage', amount: 12, active: NONE })
  assert.equal(laneCount(lanes.get('two sided strike')!), 1)
})

test('a landing folds the ACTIVE SET at its instant, like every other side', () => {
  const lanes = new Map<string, SpellProcLane>()
  const blade: ReadonlySet<string> = new Set(['invocation:spellblade'])
  addSpellProc(lanes, { spell: 'Blessing of the Theurgist', side: 'landing', active: blade })
  addSpellProc(lanes, { spell: 'Blessing of the Theurgist', side: 'landing', active: NONE })
  const lane = lanes.get('blessing of the theurgist')
  assert.equal(laneCount(lane!), 2)
  assert.deepEqual(lane?.byState.get('invocation:spellblade'), { damage: 0, heal: 0, landing: 1 })
})

// ---------------------------------------------------------------------------------------
// 3. SYNTHETIC END-TO-END — real parser, real engine, the reported sentence
// ---------------------------------------------------------------------------------------

const T = (mmss: string, text: string): string => `[Sun Aug 02 21:${mmss} 2026] ${text}`

/** The one line quoted verbatim from report 01KZSZC882Y2T1PQEDQXFM9VDB. */
const THEURGIST = 'The power of your god fills you.'

/** Replay raw lines through the REAL parser + engine with the spell DB installed — the
 *  message-driven landing path needs it, exactly as production does. */
function replay(lines: string[]): { eng: CombatEngine; lastTs: number } {
  installSpellDb(loadSpellDb())
  const eng = new CombatEngine()
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev || ev.kind === 'unknown') continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  return { eng, lastTs }
}

/** The engine's private state, reached the way the shipped combat tests reach it. */
function lanesOf(eng: CombatEngine): Map<string, SpellProcLane> {
  const st = (eng as unknown as { st: { zoneAgg: { procs: { spellProcs: Map<string, SpellProcLane> } } } }).st
  return st.zoneAgg.procs.spellProcs
}

test('END-TO-END: a proc whose ONLY line is a self landing is counted', () => {
  const { eng, lastTs } = replay([
    T('43:00', 'You crush a wan ghoul knight for 38 points of damage.'),
    T('43:00', THEURGIST),
    T('43:26', 'You crush a wan ghoul knight for 34 points of damage.'),
    T('43:26', THEURGIST)
  ])
  const lane = lanesOf(eng).get('blessing of the theurgist')
  assert.equal(laneCount(lane!), 2, 'both firings counted from the sentence alone')
  assert.equal(lane?.name, 'Blessing of the Theurgist', 'the DB name, resolved by the parser')
  // NOTHING WAS MEASURED, and the lane says so rather than reporting a zero-damage proc.
  assert.deepEqual(lane?.hits, { damage: 0, heal: 0, landing: 2 })
  assert.equal(lane?.damage, 0)
  assert.equal(lane?.heal, 0)
  // LAW 8's tripwire: the meter's own total is the two crushes and nothing else.
  assert.equal(eng.snapshot(lastTs + 600_000, { selectedId: 'zone' }).selected?.outTotal, 72)
})

test('END-TO-END: the landing lane reaches the ProcsView the user actually reads', () => {
  const { eng, lastTs } = replay([
    T('43:00', 'You crush a wan ghoul knight for 38 points of damage.'),
    T('43:00', THEURGIST)
  ])
  const seg = eng.snapshot(lastTs + 600_000, { selectedId: 'zone' }).selected
  const lane = seg?.procs.lanes.find((l) => l.name === 'Blessing of the Theurgist')
  assert.equal(lane?.count, 1)
  assert.equal(lane?.origin, 'spell')
  assert.equal(lane?.directDamage, 0)
  assert.equal(lane?.directHeal, 0)
  // LAW 6, carried on the wire. The slice names no item, aura or AA behind the sentence — no line
  // consistently precedes it — and the model does not guess one: `sourceAmbiguous` says the rate
  // is over the segment, which is the same answer every item proc already gets.
  assert.equal(lane?.rate.sourceAmbiguous, true)
  assert.equal(lane?.rate.sourceName, undefined)
})

test('END-TO-END: a landing with a cast line behind it is NOT a proc', () => {
  // Nothing in the registry is player-castable today, so this can only fire once the registry
  // grows one — which is exactly why the route pays the cast join instead of counting blindly.
  // Without it, a registry entry somebody CAN cast would report every hand-cast as a proc, the
  // defect JOS-167 was filed for on the damage side.
  const { eng } = replay([
    T('43:00', 'You begin casting Blessing of the Theurgist.'),
    T('43:02', THEURGIST)
  ])
  assert.equal(lanesOf(eng).has('blessing of the theurgist'), false)
})

test('END-TO-END: the third-person form of the same spell counts nothing of ours', () => {
  // `Someone is surrounded by a divine aura.` is this spell's `msgCastOnOther`, and the DB
  // resolves it to Blessing of the Theurgist OR Center. A landing on somebody else is not our
  // firing — and an ambiguous candidate list could not be attributed even if it were.
  const { eng } = replay([T('43:00', 'Someone is surrounded by a divine aura.')])
  assert.equal(lanesOf(eng).has('blessing of the theurgist'), false)
})

test('END-TO-END: the landing opens no encounter — it is an annotation, never damage', () => {
  // World-model law 8, and the rule procRouting's header states for every proc-ledger line: a
  // firing with no fight around it is counted in the zone aggregate and starts nothing.
  const { eng, lastTs } = replay([T('43:00', THEURGIST)])
  assert.equal(laneCount(lanesOf(eng).get('blessing of the theurgist')!), 1)
  const snap = eng.snapshot(lastTs + 600_000, { selectedId: 'zone' })
  assert.equal(snap.selected?.outTotal, 0)
  assert.equal(snap.inCombat, false)
  assert.equal(
    snap.segments.filter((s) => s.kind === 'fight').length,
    0,
    'a landing sentence is not a pull'
  )
})

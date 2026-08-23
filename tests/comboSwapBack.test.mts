// THE SWAP-BACK ARC — the three fixes JOS-239 asked for, pinned on the span that broke.
//
// THE REPORT. The raid roster showed Lord Nagafen defeated 8/5/2026 at D4 under an INFERRED
// `ENC WIZ MNK` header spanning 8/4 11:38 PM to 8/9 10:41 AM. The owner's wizard is level 25 and
// has never been in Nagafen's Lair. The kill is real, the tier is right, and the trio is a
// fabrication: `/who` states PAL/MNK/ENC on BOTH sides of that span with nothing between them, and
// the fight itself carries Lay on Hands, Holy Steed, Feign Death, Tashani and Allure.
//
// THE MECHANISM, in four steps, each of which is a separate fix below:
//   1. `levelDropBoundaries` produced the correct hard cut at the Aug 06 19:31 `Welcome to level
//      11!` ding — the loudest swap signal anywhere in this log.
//   2. `mergeBoundaries` DELETED it: the ding's window reaches back 46.6 h to the previous ding and
//      so overlapped a much narrower evidence shift, which won.
//   3. `reinstatedDrops` — the JOS-79 guard written for THIS EXACT DING — declined, because its
//      departure test runs to the END of the observations and the owner swapped BACK into
//      PAL/MNK/ENC 40.1 h later. Nothing departed. The fix silently un-fixed itself as the log
//      grew, and fixture cw5 kept passing because it ENDS inside the wizard evening.
//   4. The polluted 4.5-day pool then admitted WIZ over PAL, because admission ranked classes by
//      how many distinct exclusive LABELS they went by — and a wizard emptying four nukes into one
//      evening beats a paladin who laid hands and summoned a steed across five days.
//
// THE FIXTURE IS THE FIX FOR STEP 3. `cw6-swap-back-aug9.log` is cw5's span carried through to the
// end of Aug 09, so the swap-back that killed the guard is inside the window that guards it. Cut
// through the shared scrub by tests/extract-combo-fixtures.mjs like every other fixture; its entry
// there states the span and what is in it.
//
// NAMING, so nobody trips: `CW6` in comboWhoBoundary.test.mts is a TEST GROUP for JOS-192's /who
// rule and runs on the cw1 fixture. This file is about the sixth FIXTURE, which is a different
// numbering that happens to have reached the same number.
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` / `@renderer` aliases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEqTimestamp, parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { ComboModule } from '../src/main/modules/combo'
import { classObservation } from '../src/main/modules/comboEvidence'
import {
  evidenceShiftBoundaries,
  levelDropBoundaries,
  mergeBoundaries,
  reinstatedDrops,
  type Boundary,
  type LevelPoint
} from '../src/main/modules/comboIntervals'
import { scoreClasses, scoreSlots } from '../src/main/modules/comboScore'
import { loadoutUncertain } from '../src/shared/comboIndex'
import { resolvedClasses, type ClassAbbr, type ClassObservation, type ComboInterval } from '../src/shared/classCombo'
import { recordKill } from '../src/main/log/reducers'
import type { KillMap } from '../src/shared/kills'
import { allStatuses } from '../src/renderer/src/features/bosses/bossStatus'
import { loadoutGroups } from '../src/renderer/src/features/bosses/loadoutGroups'
import type { RaidTarget } from '../src/shared/types'
import { readFixture } from './harness.mts'

const SELF = 'Primitive'
const at = (stamp: string): number => parseEqTimestamp(stamp)

/** The three instants this whole ticket turns on, verbatim from the owner's log. */
const NAGAFEN_KILL = at('Wed Aug 05 20:48:20 2026') // `You have slain Lord Nagafen!`, Solo 4
const WIZARD_DING = at('Thu Aug 06 19:31:23 2026') // `You have gained a level! Welcome to level 11!`
const WHO_ROW = at('Sun Aug 09 10:41:31 2026') // `[50 PAL/MNK/ENC] Primitive`
/** The evidence shift that swallowed the ding: the undinged Aug 04 swap into PAL/MNK/ENC. */
const ABSORBING_CUT = at('Tue Aug 04 23:38:01 2026')

interface Replay {
  intervals: ComboInterval[]
  observations: ClassObservation[]
  levels: LevelPoint[]
}

/** The fixture through the REAL parser into a fresh module, with the raw inputs kept beside it. */
function replay(name: string): Replay {
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const mod = new ComboModule()
  mod.reset()
  const observations: ClassObservation[] = []
  const levels: LevelPoint[] = []
  let seq = 0
  for (const raw of readFixture(name)) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    if (ev.kind === 'level') levels.push({ ts: ev.ts, level: ev.level })
    const observation = classObservation(ev)
    if (observation) observations.push(observation)
    mod.onEvent(ev)
  }
  return { intervals: mod.snapshot().state.intervals, observations, levels }
}

/** The classes an observation stream names EXCLUSIVELY in ≥2 distinct hours — the model's own bar. */
function sustainedExclusive(observations: readonly ClassObservation[]): Set<ClassAbbr> {
  const buckets = new Map<ClassAbbr, Set<number>>()
  for (const o of observations) {
    if (o.source === 'who' || o.candidates.length !== 1) continue
    const seen = buckets.get(o.candidates[0]) ?? new Set<number>()
    seen.add(Math.floor(o.ts / 3_600_000))
    buckets.set(o.candidates[0], seen)
  }
  return new Set([...buckets].filter(([, b]) => b.size >= 2).map(([cls]) => cls))
}

const sorted = (i: ComboInterval): string => [...resolvedClasses(i)].sort().join('/')

/**
 * The evidence-shift boundaries `buildIntervals` computes for a fixture — the level dings cut the
 * observations into hard segments and each segment is bisected on its own. Reproduced here so the
 * merge the reinstatement rule is handed below is the merge the module really performs, rather than
 * a hand-picked subset that could be made to prove anything.
 */
function shiftsOf(replayed: Replay): Boundary[] {
  const cuts = mergeBoundaries(levelDropBoundaries(replayed.levels)).map((b) => b.at)
  const segments: ClassObservation[][] = Array.from({ length: cuts.length + 1 }, () => [])
  for (const o of replayed.observations) {
    let i = 0
    while (i < cuts.length && o.ts >= cuts[i]) i++
    segments[i].push(o)
  }
  return segments.flatMap((segment) => evidenceShiftBoundaries(segment, 3))
}

// ---------------------------------------------------------------------------
// 1. THE BOUNDARY — the ding is put back, and CW2's is still absorbed.
// ---------------------------------------------------------------------------

test('the swap-back is IN the window now, and it is what used to kill the guard', () => {
  // The premise of the whole regression, measured rather than asserted about: across the Aug 06
  // ding NOTHING departs when you look to the end of the log, because MNK comes back on Aug 08.
  // That is exactly the question the old `reinstatedDrops` asked, and why it answered "one swap".
  const { observations } = replay('cw6-swap-back-aug9.log')
  // The window the departure test actually uses: from the boundary that swallowed the ding (the
  // Aug 04 23:38 evidence shift) to the end of the observations, split at the ding.
  const between = (from: number, to: number): Set<ClassAbbr> =>
    sustainedExclusive(observations.filter((o) => o.ts >= from && o.ts < to))
  const before = between(ABSORBING_CUT, WIZARD_DING)
  const after = between(WIZARD_DING, Infinity)
  assert.deepEqual([...before].sort(), ['ENC', 'MNK', 'PAL'], 'a full loadout, playing for two days')
  assert.ok(after.has('MNK'), 'and the monk is back after it — the swap BACK, which cw5 cannot see')
  assert.equal([...before].every((c) => after.has(c)), true, 'so the departure test finds nobody gone')
  // cw5 is the same span cut short, and there the monk really is gone — which is how a guard that
  // had stopped working kept a green test beside it for six days.
  const cw5 = replay('cw5-wizard-swap-aug6.log')
  assert.equal(sustainedExclusive(cw5.observations.filter((o) => o.ts >= WIZARD_DING)).has('MNK'), false)
})

test('an absorbed ding is reinstated when the stretch behind it is an ERA of its own', () => {
  // The rule, applied to its two cases at once. `reinstatedDrops` is handed exactly what
  // `buildIntervals` hands it: the raw drops and the merged boundaries that swallowed one.
  const reinstated = (name: string): Boundary[] => {
    const replayed = replay(name)
    const drops = levelDropBoundaries(replayed.levels)
    const merged = mergeBoundaries([...drops, ...shiftsOf(replayed)])
    assert.equal(merged.some((b) => b.at === drops[drops.length - 1].at), false, 'the ding was absorbed')
    return reinstatedDrops(replayed.observations, drops, merged, 3)
  }

  const put = reinstated('cw6-swap-back-aug9.log')
  assert.equal(put.length, 1, 'the Aug 06 ding comes back')
  assert.equal(put[0].at, WIZARD_DING)
  assert.equal(put[0].reason, 'levelDrop')

  // CW2 IS THE GUARD ON THIS RULE. Its ding lands 19 minutes past the shift that dated the same
  // swap, and the stretch between them sustains {BER,ROG} — two classes, not a loadout. One event,
  // dated twice, and it must stay merged or CW2's 54-minute boundary splits into confetti.
  assert.deepEqual(reinstated('cw2-loadout-swap-aug2.log'), [], 'a 19-minute gap is not an era')
})

test('the Aug 06 ding cuts, and the wizard evening is its own span', () => {
  const { intervals } = replay('cw6-swap-back-aug9.log')
  assert.equal(intervals.length, 4, 'logStart, the Aug 04 shift, the Aug 06 ding, the Aug 09 /who')
  const [, era, wizard, stated] = intervals

  assert.equal(era.endTs, WIZARD_DING, 'the PAL/MNK/ENC era ENDS at the ding')
  assert.equal(sorted(era), 'ENC/MNK/PAL', 'and it is the loadout /who names on both sides')

  assert.equal(wizard.startTs, WIZARD_DING, 'the wizard span opens where the log said the level fell')
  assert.equal(wizard.startReason, 'levelDrop')
  assert.equal(wizard.levelLo, 11, 'level 11 in, level 25 out — the wizard evening, not a 50 in sight')
  assert.equal(wizard.levelHi, 25)

  assert.equal(stated.startTs, WHO_ROW, 'and the game itself closes the arc')
  assert.equal(sorted(stated), 'ENC/MNK/PAL')
})

test('nothing anywhere in the arc claims ENC/WIZ/MNK', () => {
  // The reported trio, refused as a whole and in its parts: the wizard and the monk were never in
  // one loadout, and no interval may say they were.
  const { intervals } = replay('cw6-swap-back-aug9.log')
  for (const interval of intervals) {
    assert.notEqual(sorted(interval), 'ENC/MNK/WIZ', `${interval.id} states the reported trio`)
    const classes = new Set(resolvedClasses(interval))
    assert.equal(
      classes.has('WIZ') && classes.has('MNK'),
      false,
      `${interval.id} puts the wizard and the monk in one loadout`
    )
  }
})

// ---------------------------------------------------------------------------
// 2. THE CONFIDENCE GATE — a span the model cannot explain names no trio.
// ---------------------------------------------------------------------------

const NAGAFEN: RaidTarget = { name: 'Lord Nagafen', category: 'Open World', match: ['Lord Nagafen'] }

test('the Aug 5 Nagafen kill joins a PAL/MNK/ENC section, and the wizard span names nothing', () => {
  const { intervals } = replay('cw6-swap-back-aug9.log')
  // The kill as the roster records it: own kill, Solo 4, at the instant the log states.
  const kills: KillMap = {}
  recordKill(kills, {
    key: 'lord nagafen',
    display: 'Lord Nagafen',
    tier: 4,
    ts: NAGAFEN_KILL,
    credited: true
  })
  // …and a second kill inside the wizard span, so both sections exist to be compared.
  recordKill(kills, {
    key: 'lord nagafen',
    display: 'Lord Nagafen',
    tier: 0,
    ts: WIZARD_DING + 3_600_000,
    credited: true
  })
  const groups = loadoutGroups(intervals, allStatuses([NAGAFEN], kills))
  assert.equal(groups.length, 2, 'two loadout stretches took these kills, so two sections')

  const [nagafen, mixed] = groups
  assert.ok(nagafen.interval, 'the D4 kill lands under a section that names its loadout')
  assert.equal(
    [...resolvedClasses(nagafen.interval)].sort().join('/'),
    'ENC/MNK/PAL',
    'which is the trio /who states on both sides of that day'
  )
  assert.equal(nagafen.uncertain, false)
  assert.equal(nagafen.rows[0].s.bestTier, 4, 'and it wears the D4 badge it earned')

  // The wizard span is over-determined — the swap BACK is inside it, and only the Aug 09 `/who`
  // dates that — so the header states the stretch and refuses the classes.
  assert.equal(mixed.uncertain, true)
  assert.equal(mixed.interval, null, 'a gated section has no speaker: there are no chips to draw')
  assert.deepEqual(mixed.intervals.map((i) => i.startTs), [WIZARD_DING], 'but the span is kept')
  assert.equal(mixed.key, 'uncertain')
})

test('the gate reads the model flags, and never overrules a STATEMENT', () => {
  const { intervals } = replay('cw6-swap-back-aug9.log')
  const [, era, wizard, stated] = intervals
  assert.equal(loadoutUncertain(wizard), true, 'over-determined inference is a guess')
  assert.equal(loadoutUncertain(era), false, 'a clean inferred span still names its trio')
  // `stated` is over-determined too — six classes clear the bar in the days after the swap back —
  // and it is the GAME's own sentence, so the gate keeps its hands off it.
  assert.equal(stated.startAlso?.includes('overDetermined'), true)
  assert.equal(loadoutUncertain(stated), false, '/who outranks the gate; it is not an inference')
})

test('a level that goes BACKWARDS inside a span is a swap nothing dated', () => {
  // The second gate condition, on the fixture that has it. Under min-of-loadout your level only
  // ever rises inside one loadout, so CW2's post-swap interval — which the Aug 02 02:13 ding to
  // level 11 lands INSIDE, 19 minutes after the shift dated the swap — carries the flag.
  const { intervals } = replay('cw2-loadout-swap-aug2.log')
  const after = intervals[1]
  assert.equal(after.levelRegressed, true, 'level 50 at the start, level 11 nineteen minutes in')
  assert.equal(loadoutUncertain(after), true)
  // …and a span whose level only climbed does not carry it, so the flag is not "wide range".
  assert.equal(intervals[0].levelRegressed, undefined)
})

// ---------------------------------------------------------------------------
// 3. THE SCORING — spread, not how many names a class went by.
// ---------------------------------------------------------------------------

test('over the polluted span, PAL beats WIZ on SPREAD where it lost on label count', () => {
  // The acceptance case, reconstructed exactly: the observations of the 4.5-day interval the bug
  // produced, scored on their own. This is the pool that admitted a level-25 wizard.
  const { observations } = replay('cw6-swap-back-aug9.log')
  const polluted = observations.filter((o) => o.ts >= ABSORBING_CUT && o.ts < WHO_ROW)
  const scores = scoreClasses(polluted)
  const wiz = scores.get('WIZ')
  const pal = scores.get('PAL')
  assert.ok(wiz && pal)

  // THE OLD RANKING, still measurable on the same numbers: the wizard went by MORE names.
  assert.ok(
    wiz.exclusive > pal.exclusive,
    `label count still favours WIZ (${String(wiz.exclusive)} vs ${String(pal.exclusive)}) — that is the trap`
  )
  // THE NEW ONE: the paladin was there for two and a half times as many hours.
  assert.ok(
    pal.spread > wiz.spread * 2,
    `spread must favour PAL decisively (${String(pal.spread)} vs ${String(wiz.spread)})`
  )

  // And the slots that come out are the loadout the owner was running, not the one he was not.
  const slots = scoreSlots(polluted, 3).map((s) => s.candidates.join('|'))
  assert.deepEqual([...slots].sort(), ['ENC', 'MNK', 'PAL'], `got ${slots.join('/')}`)
})

test('spread is EXCLUSIVE hours, and the label count is only the tie-break', () => {
  // Two synthetic classes, same window: BER leaves four different unambiguous labels inside two
  // hours, ROG leaves one label across five. Under the old rule BER wins 4-1 and the loadout is
  // wrong every time the player swaps into a class with a big spellbook.
  const observation = (ts: number, label: string, cls: ClassAbbr): ClassObservation => ({
    ts,
    seq: ts,
    source: 'skillUp',
    label,
    candidates: [cls],
    weight: 1
  })
  const H = 3_600_000
  const dense = ['a', 'b', 'c', 'd'].flatMap((label) => [
    observation(H, label, 'BER'),
    observation(2 * H, label, 'BER')
  ])
  const wide = [0, 1, 2, 3, 4].map((h) => observation(h * H + 60_000, 'backstab', 'ROG'))
  const scores = scoreClasses([...dense, ...wide])
  assert.equal(scores.get('BER')?.exclusive, 4, 'four distinct labels, each in two hours')
  assert.equal(scores.get('ROG')?.exclusive, 1, 'one label — but it is in five')
  assert.equal(scores.get('BER')?.spread, 2)
  assert.equal(scores.get('ROG')?.spread, 5)
  assert.deepEqual(scoreSlots([...dense, ...wide], 1)[0].candidates, ['ROG'], 'presence beats vocabulary')

  // The tie-break is where the count is a good question: same hours, so the evidence decides.
  const tied = [0, 1, 2].flatMap((h) => [observation(h * H, 'x', 'ROG'), observation(h * H + 1, 'y', 'ROG')])
  const twin = [0, 1, 2].map((h) => observation(h * H + 2, 'z', 'BER'))
  assert.deepEqual(scoreSlots([...tied, ...twin], 1)[0].candidates, ['ROG'], 'equal spread, more labels')
})


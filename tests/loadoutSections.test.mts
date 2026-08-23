// ONE SECTION PER LOADOUT — the raid roster's group-by-class-loadout law (JOS-236,
// owner-reported 2026-08-12 while release-testing: the board drew PAL / MNK / ENC TWICE).
//
// WHY IT HAPPENED. A combo INTERVAL is a contiguous span of one believed loadout, so swapping
// away and back — or a `/who` restating the trio, or any boundary a detector cuts inside it —
// produces two intervals carrying the SAME classes. The sectioning drew one header per interval,
// so the same sentence ("you were running these classes") appeared twice with the kills split
// between them.
//
// WHAT WAS NOT CHANGED, and must not be. shared/comboIndex.ts's interval semantics: "which
// loadout killed that" is a TIME JOIN and needs every boundary the model has, so the merge lives
// in the SECTIONING layer alone (renderer/features/bosses/loadoutGroups.ts, whose header states
// the rule and everything it decides). Nothing is stamped onto a kill; the join still happens at
// read; tests/bossTierRuns.test.mts still pins the Lord of Ire attribution the join layer exists
// for, and the two files share one interval builder (comboFixtures.mts) so they cannot drift.
//
// PINNED HERE: the merge key (order-insensitive over slot candidate SETS, and only over
// identical ones), the merged section's provenance (the WEAKEST member speaks — inference is
// never upgraded to "stated by /who"), its level range (the HULL of the members'), its badges (a
// target killed at two tiers under ONE loadout is one card wearing the best of them), and the
// unattributed section, which merges with nothing.
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` / `@renderer` aliases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordKill } from '../src/main/log/reducers'
import { TIER_OPEN_WORLD, type KillMap } from '../src/shared/kills'
import { allStatuses } from '../src/renderer/src/features/bosses/bossStatus'
import { loadoutGroups, loadoutKey } from '../src/renderer/src/features/bosses/loadoutGroups'
import { lockoutWindow } from '../src/renderer/src/features/bosses/lockout'
import { defeatedThisWeek } from '../src/renderer/src/features/bosses/rosterFilter'
import { intervalProvenance } from '../src/renderer/src/features/profiles/ClassComboLabels'
import type { ClassAbbr, ComboInterval } from '../src/shared/classCombo'
import type { RaidTarget } from '../src/shared/types'
import { IRE_TRIO, LATER_TRIO, interval, slot } from './comboFixtures.mts'

/** The roster row for the boss the original misattribution was about. */
const LORD_OF_IRE: RaidTarget = {
  name: 'Lord of Ire',
  category: 'Plane of Hate',
  match: ['Lord of Ire']
}

/** A one-kill roster target, so a section's membership is readable at a glance. */
function killedAt(kills: KillMap, name: string, tier: number, ts: number): RaidTarget {
  recordKill(kills, { key: name.toLowerCase(), display: name, tier, ts, credited: true })
  return { name, category: 'Open World', match: [name] }
}

/** The three-interval timeline the ticket describes: a trio, a different one, then the trio again. */
function thereAndBack(later: ClassAbbr[] = IRE_TRIO): ComboInterval[] {
  return [
    interval('ci1', 0, 4_000, { classes: IRE_TRIO }),
    interval('ci2', 4_000, 8_000, { classes: LATER_TRIO }),
    interval('ci3', 8_000, null, { classes: later })
  ]
}

test('the loadout key is order-insensitive — a trio is a SET, and the log never states an order', () => {
  const a = interval('ci1', 0, null, { classes: ['PAL', 'MNK', 'ENC'] })
  const b = interval('ci2', 0, null, { classes: ['ENC', 'PAL', 'MNK'] })
  assert.equal(loadoutKey(a), loadoutKey(b))
  assert.notEqual(loadoutKey(a), loadoutKey(interval('ci3', 0, null, { classes: LATER_TRIO })))
  // A two-slot loadout is not a three-slot one with an unknown third — different claims.
  assert.notEqual(
    loadoutKey(interval('ci4', 0, null, { classes: ['PAL', 'MNK'] })),
    loadoutKey(interval('ci5', 0, null, { slots: [slot(['PAL']), slot(['MNK']), slot([])] }))
  )
})

test('THE BUG: the same trio in two intervals draws ONE section, and a different trio keeps its own', () => {
  const kills: KillMap = {}
  const first = killedAt(kills, 'A mob', 1, 1_000)
  const middle = killedAt(kills, 'Another mob', 2, 5_000)
  const third = killedAt(kills, 'A third mob', 3, 9_000)
  // The swap BACK is restated in a different slot order, which is the same loadout.
  const groups = loadoutGroups(thereAndBack(['ENC', 'PAL', 'MNK']), allStatuses([first, middle, third], kills))

  assert.equal(groups.length, 2, 'PAL/MNK/ENC once, ROG/PAL/BER once — not three sections')
  const [trio, other] = groups
  assert.deepEqual(trio.intervals.map((i) => i.id), ['ci1', 'ci3'], 'both members survive, earliest first')
  assert.deepEqual(
    trio.rows.map((r) => r.s.target.name),
    ['A mob', 'A third mob'],
    'the kills from both stretches are under one header, oldest first'
  )
  assert.deepEqual(other.intervals.map((i) => i.id), ['ci2'], 'the genuinely different trio is untouched')
  assert.deepEqual(other.rows.map((r) => r.s.target.name), ['Another mob'])
  // Sections still come out in the order their first kill did.
  assert.equal(trio.interval?.id, 'ci1')
})

test('a target killed at two tiers under the SAME trio is ONE card, badged with the best of them', () => {
  // The ticket's badge question, on the shape that caused the original misattribution: d4 under
  // the trio, the open world under the trio again days later. One header, one card, d4 — a true
  // sentence, because this loadout did take it at d4. Nothing is stamped on either kill.
  const kills: KillMap = {}
  recordKill(kills, { key: 'lord of ire', display: 'Lord of Ire', tier: 4, ts: 1_000, credited: true })
  recordKill(kills, { key: 'lord of ire', display: 'Lord of Ire', tier: TIER_OPEN_WORLD, ts: 9_000, credited: true })
  const groups = loadoutGroups(thereAndBack(), allStatuses([LORD_OF_IRE], kills))

  assert.equal(groups.length, 1, 'the other loadout never killed it, so it draws no section')
  const [only] = groups
  assert.equal(only.rows.length, 1, 'a target must not appear twice under one header')
  assert.equal(only.rows[0].s.bestTier, 4, 'the badge is the best tier THIS loadout took it at')
  assert.equal(only.rows[0].s.count, 2, 'and the card counts both kills it is claiming')
  assert.equal(only.rows[0].s.lastTs, 9_000, 'dated by the latest kill under this loadout')
  assert.deepEqual(Object.keys(only.rows[0].s.tiers).sort(), [String(TIER_OPEN_WORLD), '4'])
  assert.equal(only.rows[0].whole.count, 2, 'and the mob page still opens the whole record')
})

test('…but a run under a DIFFERENT loadout is still a different card in a different section', () => {
  // The Lord of Ire regression, restated against the merge: merging must never reach across
  // trios. Same two kills, but the second one lands in the ROG/PAL/BER stretch.
  const kills: KillMap = {}
  recordKill(kills, { key: 'lord of ire', display: 'Lord of Ire', tier: 4, ts: 1_000, credited: true })
  recordKill(kills, { key: 'lord of ire', display: 'Lord of Ire', tier: TIER_OPEN_WORLD, ts: 5_000, credited: true })
  const groups = loadoutGroups(thereAndBack(), allStatuses([LORD_OF_IRE], kills))

  assert.equal(groups.length, 2)
  assert.equal(groups[0].rows[0].s.bestTier, 4, 'the d4 card stays with the trio that took it')
  assert.equal(groups[1].rows[0].s.bestTier, TIER_OPEN_WORLD)
  assert.equal(
    groups[1].rows.some((r) => r.s.bestTier === 4),
    false,
    'a d4 badge must never appear under the loadout whose kills were all open world'
  )
})

test('two intervals that differ only in an AMBIGUOUS slot are two loadouts, not one', () => {
  // Merging these would make the header state one interval's unresolved guess for the other's:
  // `PAL / MNK / CLR|ENC` and `PAL / MNK / DRU|ENC` are different claims about the third slot.
  const kills: KillMap = {}
  const a = killedAt(kills, 'A mob', 1, 1_000)
  const b = killedAt(kills, 'Another mob', 1, 5_000)
  const groups = loadoutGroups(
    [
      interval('ci1', 0, 4_000, { slots: [slot(['PAL']), slot(['MNK']), slot(['CLR', 'ENC'])] }),
      interval('ci2', 4_000, null, { slots: [slot(['PAL']), slot(['MNK']), slot(['DRU', 'ENC'])] })
    ],
    allStatuses([a, b], kills)
  )
  assert.equal(groups.length, 2)
})

test('a merged section speaks with its WEAKEST provenance — inference never gets upgraded', () => {
  // ci1 is the game's own word (`/who`), ci3 is inference that happens to agree. One chip has to
  // describe both, and "stated by /who" over a stretch nothing stated would be the overclaim.
  const kills: KillMap = {}
  const early = killedAt(kills, 'A mob', 1, 1_000)
  const late = killedAt(kills, 'A third mob', 1, 9_000)
  const stated = interval('ci1', 0, 4_000, {
    slots: IRE_TRIO.map((c) => slot([c], 'who')),
    startReason: 'who'
  })
  const [group] = loadoutGroups(
    [stated, interval('ci2', 4_000, 8_000, { classes: LATER_TRIO }), interval('ci3', 8_000, null, { classes: IRE_TRIO })],
    allStatuses([early, late], kills)
  )
  assert.equal(group.intervals.length, 2)
  assert.ok(group.interval)
  assert.equal(group.interval.id, 'ci3', 'the inferred member speaks for the section')
  assert.equal(intervalProvenance(group.interval), 'inferred', 'so the chip says inferred')

  // …and with nothing but /who members it still says what the log said.
  const [allStated] = loadoutGroups([stated], allStatuses([early], kills))
  assert.ok(allStated.interval)
  assert.equal(intervalProvenance(allStated.interval), 'who')
})

test('a merged section states the HULL of its members level ranges', () => {
  // Min-of-loadout semantics (shared/classCombo.ts): each member already records the levels
  // OBSERVED inside it, so the union is a hull — never a claim that every level between was seen.
  const kills: KillMap = {}
  const early = killedAt(kills, 'A mob', 1, 1_000)
  const late = killedAt(kills, 'A third mob', 1, 9_000)
  const both = (lo: number | null, hi: number | null): ComboInterval[] => [
    interval('ci1', 0, 4_000, { classes: IRE_TRIO, levelLo: lo, levelHi: hi }),
    interval('ci3', 8_000, null, { classes: IRE_TRIO, levelLo: 48, levelHi: 52 })
  ]

  const [merged] = loadoutGroups(both(41, 44), allStatuses([early, late], kills))
  assert.deepEqual({ levelLo: merged.levelLo, levelHi: merged.levelHi }, { levelLo: 41, levelHi: 52 })

  // A member that observed no level at all contributes nothing rather than a zero.
  const [half] = loadoutGroups(both(null, null), allStatuses([early, late], kills))
  assert.deepEqual({ levelLo: half.levelLo, levelHi: half.levelHi }, { levelLo: 48, levelHi: 52 })

  // …and a section nothing was ever observed for says null, not 0.
  const [none] = loadoutGroups([interval('ci1', 0, null, { classes: IRE_TRIO })], allStatuses([early], kills))
  assert.deepEqual({ levelLo: none.levelLo, levelHi: none.levelHi }, { levelLo: null, levelHi: null })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE TOOLBAR'S FILTER, AT CARD GRAIN (JOS-237)
// ─────────────────────────────────────────────────────────────────────────────
//
// The roster's "Defeated only" switch means "defeated THIS WEEK" on the week view, and the view
// applies that predicate to whole targets. Sectioning by loadout then splits a target into one
// card per tier run — so a boss cleared at d0 this week and at d4 last month passes the target
// filter on the strength of the d0 run and would drag its d4 card onto the screen under whichever
// loadout was running last month: grey, chipped `open`, beneath a header saying "defeated this
// week". `keep` is the same predicate applied where the cards are, which is the only grain at
// which the answer is true of what is drawn.

const HOUR = 3_600_000
/** The week the lockout view would be standing in: Tue Aug 04 2026 08:00 Pacific → Tue Aug 11. */
const WEEK = lockoutWindow(Date.UTC(2026, 7, 5, 17))

test('a card whose OWN kills took no lockout is dropped, even when its target passes', () => {
  const kills: KillMap = {}
  // One boss, two runs: d4 three days before the reset, d0 two hours after it.
  recordKill(kills, {
    key: 'lord of ire',
    display: 'Lord of Ire',
    tier: 4,
    ts: WEEK.start - 3 * 24 * HOUR,
    credited: true
  })
  recordKill(kills, {
    key: 'lord of ire',
    display: 'Lord of Ire',
    tier: 0,
    ts: WEEK.start + 2 * HOUR,
    credited: true
  })
  const intervals = [
    interval('ci1', WEEK.start - 30 * 24 * HOUR, WEEK.start, { classes: IRE_TRIO }),
    interval('ci2', WEEK.start, null, { classes: LATER_TRIO })
  ]
  const list = allStatuses([LORD_OF_IRE], kills)

  // The TARGET is defeated this week — the d0 clear is inside the window — so the view keeps it.
  const isThisWeek = defeatedThisWeek(WEEK)
  assert.equal(isThisWeek(list[0]), true, 'the roster-level filter lets this target through')

  const unfiltered = loadoutGroups(intervals, list)
  assert.deepEqual(
    unfiltered.map((g) => g.rows[0].s.bestTier),
    [4, 0],
    'with the switch off, both runs draw their own card under their own loadout'
  )

  const filtered = loadoutGroups(intervals, list, isThisWeek)
  assert.equal(filtered.length, 1, 'the section whose only card is last month draws no header at all')
  assert.equal(filtered[0].interval?.id, 'ci2', 'the surviving section is the one this week ran')
  assert.deepEqual(filtered[0].rows.map((r) => r.s.bestTier), [0], 'and it is the d0 card')
  assert.equal(
    filtered[0].rows[0].whole.count,
    2,
    'the card still opens the mob page on the WHOLE record - filtering hides cards, not kills'
  )
})

test('a card is judged on the runs it MERGED, not on one of them', () => {
  // Both runs under the same trio, so the section merges them into one card (the JOS-236 rule
  // above). That card claims a kill inside the window, so it stands - and it would stand even if
  // its other run were years old, because the merged card really did take a lockout this week.
  const kills: KillMap = {}
  recordKill(kills, { key: 'lord of ire', display: 'Lord of Ire', tier: 4, ts: WEEK.start - 400 * 24 * HOUR, credited: true })
  recordKill(kills, { key: 'lord of ire', display: 'Lord of Ire', tier: 0, ts: WEEK.start + 2 * HOUR, credited: true })
  const one = [interval('ci1', 0, null, { classes: IRE_TRIO })]
  const [section] = loadoutGroups(one, allStatuses([LORD_OF_IRE], kills), defeatedThisWeek(WEEK))
  assert.equal(section.rows.length, 1)
  assert.equal(section.rows[0].s.bestTier, 4, 'and it still wears the best tier this loadout took')
})

test('a predicate nothing satisfies leaves no sections rather than empty ones', () => {
  const kills: KillMap = {}
  const mob = killedAt(kills, 'A mob', 1, 1_000)
  const groups = loadoutGroups(thereAndBack(), allStatuses([mob], kills), () => false)
  assert.deepEqual(groups, [], 'a header is a statement about cards; with none there is nothing to say')
})

// ---------------------------------------------------------------------------
// THE CONFIDENCE GATE (JOS-239) — a header is a claim about a kill, so a span the model cannot
// explain draws no trio. `loadoutUncertain` (shared/comboIndex.ts) owns the predicate; what is
// pinned here is what the SECTIONING does with it.
// ---------------------------------------------------------------------------

/** An interval the model has flagged as unexplained: more classes than slots cleared the bar. */
function overDetermined(id: string, startTs: number, endTs: number | null, classes: ClassAbbr[]): ComboInterval {
  return interval(id, startTs, endTs, { classes, startAlso: ['overDetermined'] })
}

test('an over-determined interval names NO loadout — one unresolved section, not a hedged trio', () => {
  // The reported shape in miniature: kills under a span whose evidence sustains more classes than a
  // loadout holds. The old sectioning printed the ranking's top three as a fact; the roster said
  // Lord Nagafen fell at D4 to a level-25 wizard.
  const kills: KillMap = {}
  const a = killedAt(kills, 'A mob', 1, 1_000)
  const b = killedAt(kills, 'Another mob', 1, 5_000)
  const groups = loadoutGroups(
    [
      overDetermined('ci1', 0, 4_000, IRE_TRIO),
      interval('ci2', 4_000, null, { classes: LATER_TRIO })
    ],
    allStatuses([a, b], kills)
  )
  assert.equal(groups.length, 2)
  const [gated, clean] = groups
  assert.equal(gated.uncertain, true)
  assert.equal(gated.interval, null, 'no speaker, so nothing can draw its chips')
  assert.deepEqual(gated.intervals.map((i) => i.id), ['ci1'], 'the span is still carried and shown')
  assert.deepEqual(gated.rows.map((r) => r.s.target.name), ['A mob'], 'and the kills are still there')
  assert.equal(clean.uncertain, false, 'a clean interval is untouched')
  assert.equal(clean.interval?.id, 'ci2')
})

test('every gated span is ONE section — the same sentence is not said twice', () => {
  // JOS-236's rule applied to JOS-239's header: "these kills came out of a stretch that held more
  // than one loadout" is one sentence however many stretches say it, and the caption counts them.
  const kills: KillMap = {}
  const early = killedAt(kills, 'A mob', 1, 1_000)
  const middle = killedAt(kills, 'Another mob', 1, 5_000)
  const late = killedAt(kills, 'A third mob', 1, 9_000)
  const groups = loadoutGroups(
    [
      overDetermined('ci1', 0, 4_000, IRE_TRIO),
      interval('ci2', 4_000, 8_000, { classes: LATER_TRIO }),
      // A DIFFERENT trio, also unexplained — it must not get a second "we cannot say" header.
      overDetermined('ci3', 8_000, null, ['WIZ', 'DRU', 'PAL'])
    ],
    allStatuses([early, middle, late], kills)
  )
  assert.equal(groups.length, 2, 'one gated section, one real loadout')
  const [gated] = groups
  assert.equal(gated.uncertain, true)
  assert.deepEqual(gated.intervals.map((i) => i.id), ['ci1', 'ci3'], 'both members, earliest first')
  assert.deepEqual(gated.rows.map((r) => r.s.target.name), ['A mob', 'A third mob'])
  assert.equal(gated.key, 'uncertain')
})

test('a level that went BACKWARDS gates the span too, and a STATED loadout never gates', () => {
  const kills: KillMap = {}
  const a = killedAt(kills, 'A mob', 1, 1_000)
  // Min-of-loadout only ever rises inside one loadout, so a regression is a swap nothing cut.
  const [regressed] = loadoutGroups(
    [interval('ci1', 0, null, { classes: IRE_TRIO, levelRegressed: true })],
    allStatuses([a], kills)
  )
  assert.equal(regressed.uncertain, true)

  // …but the game's own word outranks the gate. A `/who` row is not a guess that surplus evidence
  // can undermine, and answering "the game said PAL/MNK/ENC" with "we are not sure" is nonsense.
  const [stated] = loadoutGroups(
    [
      interval('ci1', 0, null, {
        slots: IRE_TRIO.map((c) => slot([c], 'who')),
        startAlso: ['overDetermined'],
        levelRegressed: true
      })
    ],
    allStatuses([a], kills)
  )
  assert.equal(stated.uncertain, false)
  assert.equal(stated.interval?.id, 'ci1', 'and it keeps its speaker and its chips')
})

test('the gated section is NOT the unattributed one — they are different things to know', () => {
  const kills: KillMap = {}
  const orphan = killedAt(kills, 'A mob', 1, 500)
  const gated = killedAt(kills, 'Another mob', 1, 5_000)
  const groups = loadoutGroups([overDetermined('ci1', 4_000, null, IRE_TRIO)], allStatuses([orphan, gated], kills))
  assert.equal(groups.length, 2)
  assert.equal(groups[0].key, 'unknown', 'no interval covers the orphan; there is no span to show')
  assert.deepEqual(groups[0].intervals, [])
  assert.equal(groups[0].uncertain, false)
  assert.equal(groups[1].key, 'uncertain', 'an interval covers the other and cannot be trusted to name it')
  assert.equal(groups[1].intervals.length, 1)
})

test('kills no interval covers keep their own section and never merge into a loadout', () => {
  const kills: KillMap = {}
  const orphan = killedAt(kills, 'A mob', 1, 500)
  const owned = killedAt(kills, 'Another mob', 1, 5_000)
  const groups = loadoutGroups(
    [interval('ci1', 4_000, null, { classes: IRE_TRIO })],
    allStatuses([orphan, owned], kills)
  )
  assert.equal(groups.length, 2)
  assert.equal(groups[0].interval, null, 'the unattributed section still has no interval')
  assert.deepEqual(groups[0].intervals, [], 'and no members to speak for it')
  assert.equal(groups[1].interval?.id, 'ci1')
})

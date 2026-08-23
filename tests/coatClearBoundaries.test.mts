// THE THREE BOUNDARIES THAT BARE A ROGUE'S BLADES (JOS-305).
//
// THE REPORT, verbatim (the owner, 2026-08-13): "the poisons shown in the combat module are from
// the last ROGUE session - after a class swap (or a death) those coats are no longer in use, but
// the UI still shows them."
//
// eqlwiki's Rogue page names both clearers in one breath — poisons "remain active until class
// swap or death" — and NEITHER prints a line, which is the whole difficulty. Coats are
// session-scoped and deliberately survive zoning (a coat really does outlive a zone line), so
// before this the only things that could remove one were a printed dry line and your own death.
// A character who stopped being a rogue kept a header pill naming venoms that had been off the
// blades for days, and every pull since opened `slowExpected` — the Procs surface blaming the
// dice for a slow that could not physically land.
//
// WHAT THIS FILE PINS, and why each half is here:
//
//   DEATH / REBIRTH   — the slots empty AND the spans close, at the same instant, through the one
//                       shared door (`procRouting.clearCoats`). The slot-versus-span disagreement
//                       is the recurring shape of this defect: the death case was fixed in 2026-08
//                       by clearing the slots, and the EPOCH case went on censoring the spans and
//                       leaving the slots standing until JOS-305 found it.
//   CLASS SWAP        — the new rule, and its REFUSALS. This is an inference that DESTROYS state,
//                       so most of the tests below are about when it must NOT fire: an unknown
//                       slot, an ambiguous slot, a span the model itself calls unexplainable, and
//                       no class model wired at all.
//   RESTART           — a stale coat must not survive an app restart. It cannot, and the test
//                       states WHY rather than asserting a mechanism that does not exist: there is
//                       no combat checkpoint (AGENTS.md, "The fold checkpoint, and why there isn't
//                       one"), so a launch re-folds the log and the boundaries fire again in order.
//
// The class-model half is driven BOTH ways on purpose: with a hand-built interval (so the refusal
// semantics are exact and do not depend on what the inference model happens to believe today) and
// once end-to-end through the REAL `ComboModule` fed a real `/who` row, so the seam is proved to
// carry a real answer and not just the test's own fake.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName } from '../src/main/log/rulesets'
import { CombatEngine } from '../src/main/combat/engine'
import { CLASS_CHECK_MS } from '../src/main/combat/coatClass'
import { ComboModule } from '../src/main/modules/combo'
import { interval, slot } from './comboFixtures.mts'
import { CLASS_ABBRS, type ClassAbbr, type ComboInterval } from '../src/shared/classCombo'
import type { BladeCoatState, StateSpan } from '../src/shared/combat'
import type { LogEvent } from '../src/shared/logEvents'

/** The tailed character — the parser keys a `/who` self row on THIS name, so every test in this
 *  file needs it installed. Node runs each test FILE in its own process, so this is file-local. */
const SELF = 'Primitive'
installCharacterName(SELF)

const AT = (hms: string): number => Date.parse(`Aug 03 2026 ${hms}`)

/** A `/who` row on the tailed character, stating a loadout. The one line that names it outright. */
function whoRow(hms: string, trio: string): string {
  return `[Mon Aug 03 ${hms} 2026] [50 ${trio}] ${SELF} (Dark Elf)  ZONE: East Freeport (freporte)  `
}

/** Coat both families, with a swing first so the zone segment's window covers the spans that
 *  follow (`spansOverlapping` is scoped to the segment). */
const COAT_BOTH = [
  '[Mon Aug 03 02:00:00 2026] You slash a rock golem for 10 points of damage.',
  '[Mon Aug 03 02:00:01 2026] You coat your blades in a neurotoxic poison.',
  '[Mon Aug 03 02:00:03 2026] You coat your blades in asp venom.',
  '[Mon Aug 03 02:00:05 2026] You slash a rock golem for 10 points of damage.'
]

/**
 * An engine fed real parsed lines, with a SWAPPABLE class model behind the JOS-305 seam.
 *
 * Swappable because the honest scenario is a character who WAS a rogue while the coats went on
 * (a coat line is itself ROG evidence at weight 3) and stopped being one later. A provider that
 * answered "not a rogue" from the first line would be testing a state the log cannot produce.
 */
class Harness {
  readonly eng = new CombatEngine()
  lastTs = 0
  asks = 0
  private seq = 0
  private combo: ComboInterval | null = null

  /** `wired: false` reproduces every test and every embedding that never installs the seam. */
  constructor(wired = true) {
    if (wired) {
      this.eng.setCombo({
        currentInterval: () => {
          this.asks++
          return this.combo
        }
      })
    }
  }

  /** What the class model will say from now on. `null` = it has no answer at all. */
  says(next: ComboInterval | null): this {
    this.combo = next
    return this
  }

  /** A resolved loadout of one class per slot — the ordinary "the model knows" case. */
  running(classes: ClassAbbr[]): this {
    return this.says(interval('ci1', AT('01:00:00'), null, { classes }))
  }

  feed(lines: string[]): this {
    for (const raw of lines) {
      const ev = parseEvent(raw, this.seq++)
      if (!ev) continue
      this.lastTs = ev.ts
      this.eng.ingestEvent(ev, false)
    }
    return this
  }

  /** An event with no printed line behind it in these fixtures (the epoch boundary). */
  feedEvent(ev: LogEvent): this {
    this.lastTs = ev.ts
    this.eng.ingestEvent(ev, false)
    return this
  }

  coats(): BladeCoatState {
    return this.eng.snapshot(this.lastTs).poison.coat
  }

  /** `Neurotoxic Poison + Asp Venom`, as the header pill would read the slots. */
  names(): string[] {
    const c = this.coats()
    return [...(c.utility ? [c.utility.poison] : []), ...c.combat.map((x) => x.poison)]
  }

  /** Every coat span the session timeline holds, in the order it opened them. */
  spans(): StateSpan[] {
    const all = this.eng.snapshot(this.lastTs, { selectedId: 'zone' }).selected?.procs.states ?? []
    return all.filter((s) => s.kind === 'coat')
  }

  /** `key|endEvidence` per coat span — the shape every assertion below reads. */
  spanEdges(): string[] {
    return this.spans().map((s) => `${s.key}|${s.endEvidence}`)
  }
}

/** A rogue loadout — what the model says while the coats are going on. */
const AS_ROGUE: ClassAbbr[] = ['ROG', 'PAL', 'BER']
/** …and the trio the owner swapped to. Nothing in it can be ROG. */
const NOT_ROGUE: ClassAbbr[] = ['PAL', 'MNK', 'ENC']

// ── DEATH ───────────────────────────────────────────────────────────────────────────

test('death mid-encounter empties BOTH coat families and censors both spans at that instant', () => {
  const h = new Harness().running(AS_ROGUE).feed([
    ...COAT_BOTH,
    '[Mon Aug 03 02:00:10 2026] You slash a rock golem for 10 points of damage.',
    '[Mon Aug 03 02:00:20 2026] You have been slain by a rock golem!'
  ])
  assert.deepEqual(h.names(), [], 'the corpse carries no poison')
  assert.equal(h.coats().utility, undefined)
  assert.deepEqual(h.coats().combat, [])
  // BOTH families' spans end, and they end CENSORED — no line printed an expiry, so the cut is
  // where our knowledge stops, never a fabricated end (law 1 / proc-analytics §3.1).
  const spans = h.spans()
  assert.deepEqual(spans.map((s) => s.key), ['neurotoxic poison', 'asp venom'])
  for (const s of spans) {
    assert.equal(s.endEvidence, 'censored', s.key)
    assert.equal(s.endTs, AT('02:00:20'), s.key)
  }
})

test('a coat applied AFTER a death comes back — the clear removes state, it does not latch', () => {
  const h = new Harness().running(AS_ROGUE).feed([
    ...COAT_BOTH,
    '[Mon Aug 03 02:00:20 2026] You have been slain by a rock golem!',
    '[Mon Aug 03 02:10:00 2026] You slash a sand scarab for 10 points of damage.',
    '[Mon Aug 03 02:10:05 2026] You coat your blades in a paralytic poison.',
    // A swing after the re-coat so the zone segment's window covers the new span too (the same
    // scoping `spansOverlapping` applies to every span in this file).
    '[Mon Aug 03 02:10:10 2026] You slash a sand scarab for 10 points of damage.'
  ])
  assert.deepEqual(h.names(), ['Paralytic Poison'])
  // …and it is a NEW span, open, beside the two the death censored. Nothing was resurrected.
  assert.deepEqual(h.spanEdges(), [
    'neurotoxic poison|censored',
    'asp venom|censored',
    'paralytic poison|open'
  ])
})

test('a character REBIRTH bares the blades too — the slots used to outlive their own spans', () => {
  // The epoch case censored the coat SPANS and left `coatUtility` / `coatCombat` standing: the
  // identical slot-versus-span disagreement the death rule was written to cure, one boundary over.
  // A rebirth is a different character; nothing was ever on these blades.
  const h = new Harness().running(AS_ROGUE).feed(COAT_BOTH)
  assert.deepEqual(h.names(), ['Neurotoxic Poison', 'Asp Venom'], 'coated before the boundary')
  h.feedEvent({ kind: 'epoch', seq: 900, ts: AT('02:30:00'), raw: '' } as LogEvent)
  assert.deepEqual(h.names(), [])
  assert.deepEqual(h.spanEdges(), ['neurotoxic poison|censored', 'asp venom|censored'])
})

// ── LEAVING ROGUE ───────────────────────────────────────────────────────────────────

test('the loadout ceasing to contain ROG bares the blades, on the /who row that says so', () => {
  // A `/who` row is the ONE line that states the loadout outright, so the check is NOT throttled
  // for it: the coats go on the very line the player typed to correct the app.
  const h = new Harness().running(AS_ROGUE).feed(COAT_BOTH)
  assert.deepEqual(h.names(), ['Neurotoxic Poison', 'Asp Venom'])
  h.running(NOT_ROGUE).feed([whoRow('02:00:30', 'PAL/MNK/ENC')])
  assert.deepEqual(h.names(), [])
  // CENSORED, not 'inferred', and the distinction is honest rather than pedantic: the combo model
  // dates a swap to a RANGE, so this ts is the moment we NOTICED, not the moment it happened.
  // 'censored' never renders as an end time; 'inferred' would have claimed one.
  assert.deepEqual(h.spanEdges(), ['neurotoxic poison|censored', 'asp venom|censored'])
  for (const s of h.spans()) assert.equal(s.endTs, AT('02:00:30'), s.key)
})

test('…and on a level ding, which is where the model`s own levelDrop detector fires', () => {
  // Your displayed level is the MINIMUM over the loadout's class levels, so it only ever rises
  // inside one loadout. A ding is therefore the other cheap, rare moment worth asking on.
  const h = new Harness().running(AS_ROGUE).feed(COAT_BOTH)
  h.running(NOT_ROGUE).feed(['[Mon Aug 03 02:00:30 2026] You have gained a level! Welcome to level 31!'])
  assert.deepEqual(h.names(), [])
})

test('a loadout that still contains ROG leaves the blades alone, /who row or not', () => {
  const h = new Harness().running(AS_ROGUE).feed([...COAT_BOTH, whoRow('02:00:30', 'ROG/PAL/BER')])
  assert.deepEqual(h.names(), ['Neurotoxic Poison', 'Asp Venom'])
  assert.deepEqual(h.spanEdges(), ['neurotoxic poison|open', 'asp venom|open'])
})

test('an UNKNOWN slot answers yes and saves the coats — silence is not an answer', () => {
  // A slot with no evidence carries all sixteen candidates (classCombo.ts), so `comboMayInclude`
  // returns true and nothing happens. This is the asymmetry the whole rule rests on: a clear can
  // only fire when every slot has positively RULED ROG OUT. A rule reading "not known to be ROG"
  // would strip a live rogue's poisons the first quiet hour of the log.
  const h = new Harness().running(AS_ROGUE).feed(COAT_BOTH)
  h.says(
    interval('ci2', AT('01:00:00'), null, {
      slots: [slot(['PAL']), slot(['MNK']), slot([...CLASS_ABBRS])]
    })
  ).feed([whoRow('02:00:30', 'PAL/MNK/ENC')])
  assert.deepEqual(h.names(), ['Neurotoxic Poison', 'Asp Venom'])
})

test('an AMBIGUOUS slot that could still be ROG saves the coats', () => {
  const h = new Harness().running(AS_ROGUE).feed(COAT_BOTH)
  h.says(
    interval('ci2', AT('01:00:00'), null, {
      slots: [slot(['PAL']), slot(['MNK']), slot(['ROG', 'BER'])]
    })
  ).feed([whoRow('02:00:30', 'PAL/MNK/ENC')])
  assert.deepEqual(h.names(), ['Neurotoxic Poison', 'Asp Venom'])
})

test('a span the model itself calls unexplainable never destroys anything (JOS-239 gate)', () => {
  // `levelRegressed` / `overDetermined` mean the interval swallowed a swap the detectors missed,
  // so its "current" trio is the ranking's opinion. That is exactly the interval whose word must
  // not be taken for an irreversible strip.
  const h = new Harness().running(AS_ROGUE).feed(COAT_BOTH)
  h.says(
    interval('ci2', AT('01:00:00'), null, { classes: NOT_ROGUE, levelRegressed: true })
  ).feed([whoRow('02:00:30', 'PAL/MNK/ENC')])
  assert.deepEqual(h.names(), ['Neurotoxic Poison', 'Asp Venom'])
})

test('a model with NO answer at all saves the coats', () => {
  const h = new Harness().running(AS_ROGUE).feed(COAT_BOTH)
  h.says(null).feed([whoRow('02:00:30', 'PAL/MNK/ENC')])
  assert.deepEqual(h.names(), ['Neurotoxic Poison', 'Asp Venom'])
})

test('with NO class model wired the engine behaves exactly as it did before JOS-305', () => {
  const h = new Harness(false).feed([...COAT_BOTH, whoRow('02:00:30', 'PAL/MNK/ENC')])
  assert.deepEqual(h.names(), ['Neurotoxic Poison', 'Asp Venom'])
})

// ── THE GATE ────────────────────────────────────────────────────────────────────────

test('the gate costs a non-rogue nothing at all — bare blades never consult the class model', () => {
  const h = new Harness().running(NOT_ROGUE).feed([
    '[Mon Aug 03 02:00:01 2026] You slash a rock golem for 10 points of damage.',
    '[Mon Aug 03 03:00:01 2026] You slash a rock golem for 10 points of damage.',
    whoRow('04:00:00', 'PAL/MNK/ENC')
  ])
  assert.equal(h.asks, 0, 'nothing to clear, nothing to ask')
  assert.deepEqual(h.names(), [])
})

test('between loadout-stating lines the model is consulted once per CLASS_CHECK_MS of LOG time', () => {
  // Asking per line would rebuild the interval model per line (~5 ms at 30k observations), which
  // is minutes on a full historical fold. The period is the LOG's clock, never a wall clock, so a
  // replay consults at exactly the instants the live tail did.
  const swings: string[] = []
  for (let i = 0; i < 600; i++) {
    const hms = new Date(AT('02:01:00') + i * 1000).toTimeString().slice(0, 8)
    swings.push(`[Mon Aug 03 ${hms} 2026] You slash a rock golem for 10 points of damage.`)
  }
  const h = new Harness().running(AS_ROGUE).feed([...COAT_BOTH, ...swings])
  // Ten minutes of swinging at one line a second, all inside one period: the coats were laid
  // down at 02:00:01, the first swing after them consults, and the other 602 lines do not.
  assert.equal(h.asks, 1)
  assert.deepEqual(h.names(), ['Neurotoxic Poison', 'Asp Venom'], 'still a rogue, coats stand')
  // Push past the period and it asks again — and now the answer has changed.
  h.running(NOT_ROGUE).feed([
    `[Mon Aug 03 ${new Date(AT('02:00:03') + CLASS_CHECK_MS + 1000).toTimeString().slice(0, 8)} 2026] You slash a rock golem for 10 points of damage.`
  ])
  assert.equal(h.asks, 2)
  assert.deepEqual(h.names(), [])
})

test('CLASS_CHECK_MS is the combo model`s own boundary floor — a faster poll could not sharpen it', () => {
  // modules/comboIntervals.ts WINDOW_FLOOR_MS: the interval model refuses to bisect below fifteen
  // minutes, so it cannot date a swap finer than that. Pinned here so the two cannot drift apart
  // silently — if the model's floor moves, this is the failure that says so.
  assert.equal(CLASS_CHECK_MS, 15 * 60_000)
})

// ── THE REAL SEAM, end to end ───────────────────────────────────────────────────────

test('the REAL ComboModule drives it: coat, /who a non-rogue trio, blades bare', () => {
  // Bus order, reproduced exactly as pipeline.ts wires it: the combo module is registered FIRST,
  // so by the time the engine folds a line the class model has already advanced for that same
  // line. Everything below goes through the real parser, the real evidence intake and the real
  // interval builder — no hand-built interval anywhere.
  const combo = new ComboModule()
  const eng = new CombatEngine()
  eng.setCombo(combo)
  let seq = 0
  let lastTs = 0
  const lines = [
    ...COAT_BOTH,
    // The game naming the loadout outright. `/who` OVERRIDES every inference (§ 4.4) — and the
    // coat lines above are themselves ROG evidence at weight 3, which is precisely why the
    // override has to be the thing that wins here.
    whoRow('02:00:30', 'PAL/MNK/ENC')
  ]
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    lastTs = ev.ts
    combo.onEvent(ev)
    eng.ingestEvent(ev, false)
  }
  const resolved = combo.currentInterval()
  assert.ok(resolved, 'the real model has an answer')
  assert.deepEqual(
    resolved.slots.map((s) => s.candidates.join('|')),
    ['PAL', 'MNK', 'ENC'],
    'the /who row states all three slots'
  )
  const coat = eng.snapshot(lastTs).poison.coat
  assert.equal(coat.utility, undefined)
  assert.deepEqual(coat.combat, [])
})

test('currentInterval is a pure read — it must not eat the renderer`s next delta', () => {
  // `snapshot()` is the renderer's new BASELINE (it rewrites the delta bookkeeping), so a
  // main-side caller using it would silently swallow the next flush and freeze the Combo card on
  // screen. The engine's seam is a separate, read-only door; this proves it stayed one.
  const combo = new ComboModule()
  for (const raw of [...COAT_BOTH, whoRow('02:00:30', 'PAL/MNK/ENC')]) {
    const ev = parseEvent(raw, 0)
    if (ev) combo.onEvent(ev)
  }
  for (let i = 0; i < 5; i++) combo.currentInterval()
  const delta = combo.flushDelta()
  assert.ok(delta, 'the first flush still carries intervals the renderer has never seen')
  assert.ok(delta.delta.changed.length > 0)
})

// ── ACROSS A RESTART ────────────────────────────────────────────────────────────────

test('a stale coat cannot survive a restart, because a launch re-folds the log from scratch', () => {
  // THE PERSISTENCE QUESTION, answered by architecture rather than by a rehydrate guard: there is
  // NO combat checkpoint (AGENTS.md, "The fold checkpoint, and why there isn't one" — JOS-208
  // built one and JOS-230 removed it). `session.ts` calls `combat.reset()` and re-scans the whole
  // log on every launch and every character switch, so nothing can carry a coat across a boot;
  // the boundaries simply fire again, in order, on the same bytes. A rehydrate-time validation
  // would be a second opinion about state that has exactly one derivation.
  const before = [
    ...COAT_BOTH,
    '[Mon Aug 03 02:00:20 2026] You have been slain by a rock golem!',
    '[Mon Aug 03 02:10:00 2026] You slash a sand scarab for 10 points of damage.',
    '[Mon Aug 03 02:10:05 2026] You coat your blades in a paralytic poison.',
    '[Mon Aug 03 02:10:10 2026] You slash a sand scarab for 10 points of damage.'
  ]
  const after = [whoRow('02:30:00', 'PAL/MNK/ENC')]
  const fold = (): Harness => {
    const h = new Harness().running(AS_ROGUE).feed(before)
    return h.running(NOT_ROGUE).feed(after)
  }
  const live = fold()
  assert.deepEqual(live.names(), [], 'the live tail ends on bare blades')
  // The SAME bytes through a FRESH engine — a cold launch reading the same file — reach the same
  // answer, span for span. That is the fold law this whole fix was written under: the clears are
  // in the fold, so a replay cannot disagree with the tail that produced it.
  const relaunched = fold()
  assert.deepEqual(relaunched.names(), [])
  assert.deepEqual(
    relaunched.spans().map((s) => `${s.key}|${s.startTs}|${s.endTs}|${s.endEvidence}`),
    live.spans().map((s) => `${s.key}|${s.startTs}|${s.endTs}|${s.endEvidence}`)
  )
  // …and the fold really did replay the boundaries rather than shortcut to the end state: the
  // pre-death coats, the post-death re-coat and the swap are all in the span ring, each carrying
  // the evidence that ended it.
  assert.deepEqual(relaunched.spanEdges(), [
    'neurotoxic poison|censored',
    'asp venom|censored',
    'paralytic poison|censored'
  ])
})

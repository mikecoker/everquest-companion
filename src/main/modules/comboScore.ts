// SCORING for the class-combo model (docs/plans/class-combo-inference.md § 4.2–4.4).
//
// PURE: observations in, slots out. No Electron, no log, no I/O — which is what makes the
// golden windows in tests/comboWindows.test.mts possible.
//
// WHAT DOES NOT WORK, measured, so nobody re-tries it: ranking classes by how often they are
// named. A frequency model run against all 11 `/who` anchors returns ENC for EVERY window
// (`ENC:264.7 BST:46.8 SHM:22.8 PAL:21.1` against a truth of PAL/MNK/ENC) because this player
// casts ENC spells constantly and every shared heal props BST/SHM/DRU up. Volume is not truth.
//
// WHAT DOES WORK: presence · exclusivity · sustain, over DISTINCT LABELS.
//   exclusive(c)  distinct labels whose candidate set is exactly {c}
//   support(c)    Σ over distinct labels naming c of weight / |candidates|
//   sustain(c)    distinct 1-hour buckets holding any evidence for c
// 177 Backstab skill-ups count ONCE for "ROG is present"; what earns a second point is a
// DIFFERENT rogue label. That is the whole fix.
//
// AND THE MODEL SAYS "I DON'T KNOW" OUT LOUD. A slot that resolves holds one candidate; a slot
// the evidence can only narrow to {CLR,PAL} holds both (measured: CLR is NEVER exclusively
// evidenced in this log — Reckless Strength, Wrath, Smite, Furor, Center, Courage, Daring,
// Stun and Holy Armor are all {CLR,PAL}); a slot with nothing behind it holds all 16 at
// confidence 0. World-model law 1: never silently guess.

import {
  CLASS_ABBRS,
  type ClassAbbr,
  type ClassObservation,
  type ComboSlot
} from '../../shared/classCombo'

const HOUR_MS = 3_600_000

/**
 * How many distinct hourly buckets an EXCLUSIVE label must span before it counts as exclusivity.
 *
 * JOS-79. `sustain` was supposed to be the guard against a one-off, and it cannot be: it counts
 * buckets holding ANY evidence for the class, and three of the nine invocations span twelve
 * classes — so on the owner's Aug 06 wizard session every one of the sixteen classes scored
 * `sustain: 4` and the clause decided nothing at all. Admission then ranked on raw exclusive
 * LABEL COUNT, and two lone item-cast labels — one `Pillage Enchantment` at 21:15, one
 * `Illusion: Dark Elf` at 22:31, an hour apart and never again — gave ENC `exclusive: 2` and the
 * third slot, over a druid who cast Shield of Barbs, Shield of Thistles, Spirit of Wolf, Wolf
 * Form and Light Healing all evening (`exclusive: 1`, and 45% more support).
 *
 * The bar is the one the interval builder already uses to decide a class was PRESENT
 * (comboIntervals `exclusiveSpans`): evidence in two distinct hours. Restated here per LABEL,
 * which is the level the strays live at — a class whose only exclusive names each appeared once
 * has not been evidenced, it has been glimpsed. Items cast spells (design § 9 R3) and this is
 * what that costs when the item announces nothing; the shared invocations cannot pay for it.
 */
const EXCLUSIVE_BUCKETS = 2

/** A class's standing in one window. */
export interface ClassScore {
  cls: ClassAbbr
  exclusive: number
  /**
   * Distinct hourly buckets holding EXCLUSIVE evidence for this class — how far across the window
   * the class's own unambiguous evidence reaches, as opposed to how many different names it went
   * by. See `byStrength` for why this and not `exclusive` decides admission (JOS-239).
   */
  spread: number
  support: number
  sustain: number
  /** the distinct labels naming it, strongest source first — the slot's `because`. */
  labels: string[]
}

/** A distinct label, folded across every occurrence of it in the window. */
interface LabelFold {
  key: string
  display: string
  candidates: ClassAbbr[]
  weight: number
  buckets: Set<number>
}

/** Fold observations into DISTINCT labels. `source:label` is the key — a stance and a spell
 *  may share a word, and they are not the same evidence. */
function foldLabels(observations: readonly ClassObservation[]): LabelFold[] {
  const byKey = new Map<string, LabelFold>()
  for (const o of observations) {
    if (o.source === 'who') continue // /who overrides, it never scores (§ 4.4)
    const key = `${o.source}:${o.label}`
    const seen = byKey.get(key)
    if (seen) {
      seen.buckets.add(Math.floor(o.ts / HOUR_MS))
      continue
    }
    byKey.set(key, {
      key,
      display: `${o.source === 'skillUp' ? 'skill' : o.source}:${o.label}`,
      candidates: o.candidates,
      weight: o.weight,
      buckets: new Set([Math.floor(o.ts / HOUR_MS)])
    })
  }
  return [...byKey.values()]
}

/** Union `hours` into a class's bucket set, creating it on first sight. */
function addHours(into: Map<ClassAbbr, Set<number>>, cls: ClassAbbr, hours: ReadonlySet<number>): void {
  const seen = into.get(cls) ?? new Set<number>()
  for (const hour of hours) seen.add(hour)
  into.set(cls, seen)
}

/** Per-class exclusivity / spread / support / sustain over a window's observations. */
export function scoreClasses(observations: readonly ClassObservation[]): Map<ClassAbbr, ClassScore> {
  const scores = new Map<ClassAbbr, ClassScore>()
  const buckets = new Map<ClassAbbr, Set<number>>()
  const exclusiveBuckets = new Map<ClassAbbr, Set<number>>()
  for (const fold of foldLabels(observations)) {
    const exclusive = fold.candidates.length === 1
    for (const cls of fold.candidates) {
      const s = scores.get(cls) ?? { cls, exclusive: 0, spread: 0, support: 0, sustain: 0, labels: [] }
      if (exclusive && fold.buckets.size >= EXCLUSIVE_BUCKETS) s.exclusive += 1
      s.support += fold.weight / fold.candidates.length
      s.labels.push(fold.display)
      scores.set(cls, s)
      addHours(buckets, cls, fold.buckets)
      // Spread counts every hour an UNAMBIGUOUS label put this class in the window, whether or not
      // that particular label cleared the two-bucket bar on its own — the bar is what makes a class
      // admissible at all (`exclusive >= 1`), and spread is then the reach of the whole body of
      // exclusive evidence rather than of one name inside it.
      if (exclusive) addHours(exclusiveBuckets, cls, fold.buckets)
    }
  }
  for (const [cls, s] of scores) {
    s.sustain = buckets.get(cls)?.size ?? 0
    s.spread = exclusiveBuckets.get(cls)?.size ?? 0
  }
  return scores
}

/**
 * Admission ranking: SPREAD first, exclusive-label count as the tie-break, then support.
 * Deterministic (code last).
 *
 * WHY SPREAD AND NOT THE LABEL COUNT (JOS-239, and this is the third of the three fixes that
 * ticket names). `exclusive` counts distinct NAMES — how many different unambiguous labels a class
 * went by — which is a property of the class's spellbook, not of how long it was in the loadout. A
 * caster who empties four different nukes into one evening scores 4; a paladin who lays hands and
 * summons a steed across five days scores 2. MEASURED on the owner's polluted Aug 04-09 span, the
 * one this ticket is about: WIZ had 4 exclusive labels in a single evening and PAL had 2 across the
 * whole 4.5 days, so raw label count admitted a level-25 wizard over the class that was running the
 * entire time — and the roster credited that wizard with a Lord Nagafen kill at D4. By spread the
 * same window reads PAL 16 buckets against WIZ 6, and the class that was actually present wins.
 *
 * The count stays as the TIE-BREAK, which is where it is a good question: two classes present for
 * the same hours are separated by how much unambiguous evidence each of them left.
 *
 * WHAT THIS DOES *NOT* FIX, stated so nobody expects it to. Spread is measured INSIDE one interval,
 * so it says nothing about stale classes surviving a swap — that is the boundary's job (above, and
 * `reinstatedDrops`). Where a boundary is MISSING, spread actively prefers the OLDER loadout,
 * because weeks of it outreach one fresh evening. It is the right answer for attribution over a
 * polluted span (the class that was there for most of it did most of the killing) and it is not a
 * substitute for cutting the span.
 */
function byStrength(a: ClassScore, b: ClassScore): number {
  return (
    b.spread - a.spread || b.exclusive - a.exclusive || b.support - a.support || a.cls.localeCompare(b.cls)
  )
}

/**
 * The classes ADMITTED to the combo: at least one exclusive label AND evidence in at least two
 * hourly buckets, strongest first, capped at `expectedSlots`.
 *
 * `sustain >= 2` alone is NOT what rejects item clickies — wave 1 measured that post-swap ENC
 * clears it comfortably. Clicky rejection happens upstream, at intake (comboEvidence.ts). This
 * clause still earns its place: it rejects a class named by one exclusive label inside a single
 * hour, which is what a genuinely stray observation looks like.
 */
export function admitted(
  scores: ReadonlyMap<ClassAbbr, ClassScore>,
  expectedSlots: number
): ClassScore[] {
  return [...scores.values()]
    .filter((s) => s.exclusive >= 1 && s.sustain >= 2)
    .sort(byStrength)
    .slice(0, expectedSlots)
}

/** § 4.3's ladder, for a slot resolved by inference. */
function resolvedConfidence(s: ClassScore): number {
  if (s.exclusive >= 2) return 0.9
  return s.sustain >= 3 ? 0.75 : 0.5
}

/** An AMBIGUOUS cluster: labels that name none of the admitted classes, intersected. */
interface Cluster {
  candidates: ClassAbbr[]
  support: number
  labels: string[]
}

/**
 * Residual clustering (§ 4.3 step 2). Labels already explained by an admitted class are
 * dropped — a {CLR,PAL} cast with PAL admitted explains itself and yields NO new slot. What is
 * left is grouped by EXACT candidate set and ranked by total support.
 *
 * DELIBERATE DEVIATION from the design, which said to intersect overlapping clusters greedily.
 * INTERSECTION CAN EXCLUDE THE TRUTH, and it did: on the `[7 CLR/BER]` window it folded a
 * `defensive` stance {PAL,SHD,WAR} into the {CLR,PAL} casts and produced {PAL,SHD} — a slot
 * that does not contain the class the `/who` row names. The flaw is in the premise, not the
 * code: two shared labels need not describe the SAME slot, so intersecting them is not a
 * narrowing, it is an assumption. Grouping by exact set can never remove a candidate that some
 * single piece of evidence did not already remove. The one safe fold is kept — a BROADER group
 * whose set contains a stronger group's is consistent with it and lends it support.
 */
function clusterResidual(folds: LabelFold[], admittedSet: ReadonlySet<ClassAbbr>): Cluster[] {
  const groups = new Map<string, Cluster>()
  // A residual EXCLUSIVE label is a class that FAILED admission — one stray `Rampage I` cast in
  // one hour. It gets no slot and no group: letting it seed one would resolve through the back
  // door exactly the class the admission rule just refused.
  const residual = folds.filter(
    (f) => f.candidates.length >= 2 && !f.candidates.some((c) => admittedSet.has(c))
  )
  for (const fold of residual) {
    const key = fold.candidates.join('|')
    const group = groups.get(key)
    if (group) {
      group.support += fold.weight / fold.candidates.length
      group.labels.push(fold.display)
    } else {
      groups.set(key, {
        candidates: [...fold.candidates],
        support: fold.weight / fold.candidates.length,
        labels: [fold.display]
      })
    }
  }
  const ranked = [...groups.values()].sort((a, b) => b.support - a.support)
  return ranked.filter((group, i) => {
    const stronger = ranked.find((g, j) => j < i && g.candidates.every((c) => group.candidates.includes(c)))
    if (!stronger) return true
    stronger.support += group.support
    stronger.labels.push(...group.labels)
    return false
  })
}

/** An explicit UNKNOWN slot: all 16 candidates, zero confidence, no story. Never a guess. */
export function unknownSlot(): ComboSlot {
  return { candidates: [...CLASS_ABBRS], confidence: 0, provenance: 'inferred', because: [] }
}

/** A slot the log (or the user) STATED: resolved, confidence 1.0, no inference involved. */
export function statedSlots(
  classes: readonly ClassAbbr[],
  provenance: 'who' | 'user'
): ComboSlot[] {
  return classes.map((c) => ({
    candidates: [c],
    confidence: 1,
    provenance,
    because: [provenance]
  }))
}

/**
 * Observations → slots (§ 4.2–4.3). Always returns exactly `expectedSlots` entries: admitted
 * classes first, then ambiguous clusters, then explicit unknowns. Shorter is never returned —
 * "we found two of three" is a statement the UI has to be able to make.
 */
export function scoreSlots(
  observations: readonly ClassObservation[],
  expectedSlots: number
): ComboSlot[] {
  const scores = scoreClasses(observations)
  const admit = admitted(scores, expectedSlots)
  const slots: ComboSlot[] = admit.map((s) => ({
    candidates: [s.cls],
    confidence: resolvedConfidence(s),
    provenance: 'inferred',
    because: s.labels.slice(0, 8)
  }))
  const admittedSet = new Set(admit.map((s) => s.cls))
  for (const cluster of clusterResidual(foldLabels(observations), admittedSet)) {
    if (slots.length >= expectedSlots) break
    if (cluster.candidates.length === 0) continue
    slots.push({
      candidates: [...cluster.candidates].sort(),
      // "we know the SET, not the member" — a two-way ambiguity is worth 0.3, not 0.6.
      confidence: 0.6 / cluster.candidates.length,
      provenance: 'inferred',
      because: cluster.labels.slice(0, 8)
    })
  }
  while (slots.length < expectedSlots) slots.push(unknownSlot())
  return slots.slice(0, expectedSlots)
}

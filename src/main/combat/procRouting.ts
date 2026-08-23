// The PROC / MODIFIER ledger routing (Task #64) plus the stance-and-invocation pair —
// extracted verbatim from engine.ts.
//
// Everything here is ANNOTATION, never damage: a coat, a rogue-poison Strike, a dispel
// landing, a stance commit. None of it opens, extends or closes an encounter (AGENTS.md
// world-model law 8's rule for misses applies to all of them); each attaches to the fight
// in progress only while that fight is FRESH, and always to the zone aggregate.

import { idKey } from '../log/parser'
import { DISPEL_FAMILY, SLOW_STRIKE, coatLineKey } from '../../shared/poisons'
import { procBuffInCandidates } from '../../shared/procBuffs'
import { selfLandingProcIn } from './procDetect'
import { stateKeyOf, type CloseStateArgs, type OpenStateArgs } from './stateTimeline'
import type { SpellProcFold } from './procDetect'
import type { EngineState } from './state'
import type { CoatSlot } from '../../shared/combat'
import type { PoisonCoatEvent, PoisonDryEvent, PoisonProcEvent } from '../../shared/logEvents'

/**
 * Open a span on the session state timeline AND stamp the commit into the minute-window
 * ledgers (proc-analytics §3, §5.1).
 *
 * The window stamp is what makes the Tier-B purity gate implementable: the minute a state
 * changed in is DISCARDED from that state's comparison, because the boundary carries the reuse
 * timer, the re-buff burst and the mid-window re-target — precisely the confound. Both ledgers
 * are stamped (the fresh encounter's and the zone's) for the same reason every other proc
 * counter is: a finalized zone session must inherit it frozen.
 */
function commitState(st: EngineState, a: OpenStateArgs): void {
  st.stateTimeline.noteState(a)
  noteStateTransition(st, a.group ?? stateKeyOf(a.kind, a.key), a.ts)
}

/** Close a span from a printed line, with the same window stamp — an END is a transition too. */
function endState(st: EngineState, a: CloseStateArgs, group: string): void {
  st.stateTimeline.closeState(a)
  noteStateTransition(st, group, a.ts)
}

function noteStateTransition(st: EngineState, group: string, ts: number): void {
  const active = st.stateTimeline.active
  st.zoneAgg.windows.noteTransition(ts, group, active)
  st.freshEncounter(ts)?.agg.windows.noteTransition(ts, group, active)
}

/**
 * Apply a blade coat (Task #64). ONLY your own coats move state — a third-person coat line
 * is another player's blades and is dropped after logging. A UTILITY coat replaces the one
 * utility slot; a COMBAT venom replaces whatever is on ITS OWN LINE and stacks with the other
 * lines. An 'unknown' poison is recorded in the segment's coat list (the blades demonstrably
 * got re-coated) but never placed in a slot — we cannot claim what is on them.
 *
 * THE LINE, not the name (corrected 2026-08-04). The stack used to be keyed on the venom's
 * NAME, which is right for a re-coat of the same venom and wrong for an upgrade: eqlwiki says
 * Cobra Venom "replaces" Asp Venom and Blood Draw Venom "replaces" Blood Siphon Venom, so a
 * name-keyed stack would have shown FOUR or FIVE simultaneous venoms where the game allows
 * three. `coatLineKey` is the fold; see shared/poisons.ts for the wiki wording. Nothing in the
 * user's log exercises it — this character is level 45 and both upgrades are level 46 — so the
 * rule comes from the wiki, and the log neither confirms nor contradicts it.
 */
export function routeCoat(st: EngineState, ev: PoisonCoatEvent): void {
  const { ts, poison, group, who } = ev
  if (idKey(who) !== 'you') {
    st.log(ts, 'poison', 'info', `☠ ${who} coated their blades`)
    return
  }
  const slot: CoatSlot = { poison, sinceTs: ts }
  if (group === 'utility') st.coatUtility = slot
  else if (group === 'combat') {
    const line = coatLineKey(poison)
    st.coatCombat = [...st.coatCombat.filter((c) => coatLineKey(c.poison) !== line), slot]
  }
  // A coat is not combat: it never opens or extends an encounter. It attaches to an
  // in-progress fight (same freshness rule a miss uses) and always to the zone aggregate.
  const enc = st.freshEncounter(ts)
  const label = poison === 'unknown' ? 'poison' : poison
  if (enc) {
    enc.agg.procs.coats.push({ poison, ts })
    st.pushMarker(enc, { ts, kind: 'coat', label, detail: `${group} coat` })
  }
  st.zoneAgg.procs.coats.push({ poison, ts })
  // ACTIVE-STATE SPAN (proc-analytics §3.1). An 'unknown' poison opens NO span: the blades
  // demonstrably got re-coated, but the line refused to name what is on them, and a span keyed
  // on a name we do not have would be an invention. The utility slot is one exclusive group
  // (a new coat replaces the old); each combat venom LINE is its own group, because venoms on
  // different lines STACK (wiki, Rogue page — and the real log proves it: three venoms coated
  // eighteen minutes before a utility coat were all still proccing afterwards) while the two
  // members of one line replace each other.
  if (poison !== 'unknown' && group !== 'unknown') {
    commitState(st, {
      kind: 'coat',
      key: idKey(poison),
      name: poison,
      ts,
      group: group === 'utility' ? 'coat:utility' : `coat:combat:${coatLineKey(poison)}`
    })
  }
  st.log(ts, 'poison', 'info', `☠ coated: ${label}${group === 'unknown' ? '' : ` (${group})`}`)
}

/**
 * A coat wore off / was replaced. The line names no poison, only which FAMILY dried, so:
 *   utility — unambiguous, there is only ever one; clear it.
 *   combat  — the log CANNOT say which venom of a stack expired (law 6). We clear the whole
 *             stack rather than pick one: under-claiming what is coated is honest, while
 *             leaving a venom listed that the game just told us ended is not. (No combat
 *             dry line exists anywhere in the user's log; both observed dries are utility
 *             replacements, printed in the same second as the coat that replaced them.)
 */
export function routeDry(st: EngineState, ev: PoisonDryEvent): void {
  if (ev.group === 'utility') st.coatUtility = undefined
  else st.coatCombat = []
  // SPAN EDGES, exactly mirroring the asymmetry above. A UTILITY dry is unambiguous — there is
  // only ever one utility coat — so its span ends 'observed', the game said so. A COMBAT dry
  // cannot say WHICH venom of a stack expired (law 6), so the whole stack closes 'inferred':
  // under-claiming what is coated is honest, claiming an observed end for a venom the line
  // never named is not.
  const prefix = ev.group === 'utility' ? 'coat:utility' : 'coat:combat:'
  st.stateTimeline.closeGroupPrefix(prefix, ev.ts, ev.group === 'utility' ? 'observed' : 'inferred')
  noteStateTransition(st, prefix, ev.ts)
  st.log(ev.ts, 'poison', 'info', `☠ ${ev.group} coat dried`)
}

/**
 * WHY A SET OF BLADES WENT BARE WITHOUT THE GAME PRINTING A LINE (JOS-305).
 *
 * Both members are boundaries eqlwiki's Rogue page names in one breath — poisons "remain active
 * until class swap or death" — and NEITHER prints a dry line, which is exactly why they have to
 * be modeled instead of waited for.
 */
export type CoatClearReason = 'death' | 'classSwap' | 'epoch'

/** The two exclusivity-group prefixes the coat slots write spans under (see stateTimeline.ts).
 *  One list, so a clear can never strip a slot family whose spans it forgot to close. */
const COAT_GROUP_PREFIXES = ['coat:utility', 'coat:combat:'] as const

/**
 * STRIP EVERY BLADE COAT, BOTH FAMILIES, AND END THEIR OPEN SPANS AT `ts` (JOS-305).
 *
 * THE DEFECT THIS EXISTS FOR, in the owner's words (2026-08-13): "the poisons shown in the combat
 * module are from the last ROGUE session". Coats are SESSION-scoped and survive zoning by design
 * (a coat really does outlive a zone line), so with only a dry line and a death able to remove
 * one, a character who stopped being a rogue kept a header pill naming venoms that had not been
 * on the blades for days — and `slowExpected` kept promising a slow that could never land.
 *
 * ONE DOOR FOR EVERY CLEARER, which is the whole reason this is a function and not three inline
 * pairs of assignments. Before this, DEATH cleared the slots in ingest.ts while EPOCH censored
 * the spans and left the slots standing — the same slot/span disagreement the death rule was
 * written to cure, rebuilt one case over. Anything that can bare the blades comes through here.
 *
 * 'CENSORED', NEVER 'OBSERVED' OR 'INFERRED' (proc-analytics §3.1, law 1). No line printed an end
 * for these spans. A death severs them at a known instant we did not see the poison leave; a class
 * swap is not even dated — the combo model's boundary is a RANGE and this `ts` is the moment we
 * NOTICED, not the moment it happened. 'censored' is precisely "our knowledge stops here", and it
 * never renders as an end time.
 *
 * IT STAMPS THE WINDOW TRANSITION, exactly as `routeDry` does, and for the same reason: the minute
 * a state changed in is DISCARDED from that state's Tier-B comparison, because the boundary minute
 * carries the confound. A boundary that silently ended four coats is the strongest version of that
 * and must not be the one minute the purity gate believes was clean.
 *
 * Returns whether anything was actually cleared, so a caller can log the boundary only when it
 * meant something. Cheap to call on a set of bare blades: two field reads and a return.
 */
export function clearCoats(st: EngineState, ts: number, reason: CoatClearReason): boolean {
  if (st.coatUtility === undefined && st.coatCombat.length === 0) return false
  st.coatUtility = undefined
  st.coatCombat = []
  for (const prefix of COAT_GROUP_PREFIXES) {
    st.stateTimeline.closeGroupPrefix(prefix, ts, 'censored')
    noteStateTransition(st, prefix, ts)
  }
  // COATS COME BACK ONLY WHEN A NEW COAT LINE IS FOLDED. Nothing here re-arms anything, and no
  // clear writes a coat observation anywhere — which is what keeps this one-directional against
  // the class model that triggers it (a coat is ROG evidence at weight 3, comboEvidence.ts, so a
  // clear that fed the inference back would be a loop).
  st.log(ts, 'poison', 'info', `☠ blades bare - ${CLEAR_NOTE[reason]}`)
  return true
}

/** The one sentence the classification ring shows for each boundary. */
const CLEAR_NOTE: Record<CoatClearReason, string> = {
  death: 'your death stripped every coat',
  classSwap: 'the loadout no longer contains ROG',
  epoch: 'a character rebirth - the coats were the previous character`s'
}

/**
 * A tracked PROC BUFF landed on you (proc-analytics §3.2). Gated to `PROC_BUFF_CATALOG` — the
 * same discipline `DISPEL_FAMILY` applies to dispel landings, and for the same reason: feeding
 * 1,926 spells into a span tracker would flood the model with irrelevant states and make every
 * co-occurrence number meaningless.
 *
 * A re-apply SUPERSEDES its own span with `endEvidence: 'inferred'` — the game printed a new
 * landing, not an end. That is not a rounding detail: in the real log `Instrument of Nife`
 * lands 97 times and fades exactly ONCE, so almost every one of its spans ends in an inference
 * and the model has to say so rather than fabricate an expiry.
 */
export function routeProcBuffApply(st: EngineState, ts: number, target: string, candidates: string[]): void {
  if (target !== 'self') return
  const def = procBuffInCandidates(candidates)
  if (!def) return
  commitState(st, { kind: 'buff', key: idKey(def.name), name: def.name, ts })
}

/**
 * A PROC WHOSE ONLY PRINTED EVIDENCE IS THIS LANDING (JOS-246 — procDetect's header carries the
 * slice evidence and the registry's entry bar).
 *
 * A THIRD disjoint gate over the same `buffApply` stream, and it consumes nothing the other two
 * want: `DISPEL_FAMILY` names a lane on a MOB, `PROC_BUFF_CATALOG` opens a SELF-BUFF SPAN, and
 * this one counts a FIRING. A spell could in principle sit in two of them; none of the three
 * short-circuits the others, so that would be two true statements about one line rather than a
 * conflict.
 *
 * IT PAYS THE SAME CAST JOIN EVERY OTHER PROC PAYS. Nothing in the registry is player-castable
 * today, so the gate never fires on the shipped entry — it is here so the registry cannot grow a
 * castable spell and start reporting the caster's own casts as procs, which is precisely the
 * defect JOS-167 was filed for on the damage side.
 */
export function routeSelfLandingProc(st: EngineState, ts: number, target: string, candidates: string[]): void {
  if (target !== 'self') return
  const def = selfLandingProcIn(candidates)
  if (!def) return
  if (st.recentCasts.origin(def.name, ts) !== 'proc') return
  // ANNOTATION, NEVER DAMAGE (this file's header, world-model law 8): a landing opens no
  // encounter and extends none. It folds into the fight in progress only while that fight is
  // FRESH, and always into the zone aggregate — the same two ledgers, in the same order, that
  // ingest's own `foldBoth` writes.
  const active = st.stateTimeline.active
  const fold: SpellProcFold = { spell: def.name, side: 'landing', active }
  st.zoneAgg.procs.addSpellProc(fold)
  st.freshEncounter(ts)?.agg.procs.addSpellProc(fold)
}

/** A tracked proc buff's OWN wears-off line — the rare case where the end is printed, so the
 *  span closes 'observed'. Candidate-gated because wears-off messages are shared across whole
 *  families (law 3); this catalog's one entry has a message unique in the DB. */
export function routeProcBuffWearOff(st: EngineState, ts: number, candidates: string[]): void {
  const def = procBuffInCandidates(candidates)
  if (!def) return
  const key = idKey(def.name)
  endState(st, { kind: 'buff', key, ts, endEvidence: 'observed' }, stateKeyOf('buff', key))
}

/**
 * A rogue-poison Strike landed on something (Task #64).
 *
 * ATTRIBUTION, HONESTLY: the emote names no caster, so this is never claimed as "your" proc
 * on its own. It is counted against the fight it lands in, and the SLOW timing is only
 * reported for pulls that opened with a slow-capable coat on (`ProcsView.slowExpected`) —
 * which is the closest the log lets anyone get to "my poison did that".
 *
 * A proc never OPENS an encounter (it is not damage, law 8's rule for misses applies), but
 * it IS presence evidence: a mob that just got slowed is emphatically still in the fight.
 */
export function routeProc(st: EngineState, ev: PoisonProcEvent): void {
  const { ts, strike, candidates, target } = ev
  const isSlow = ev.effect === 'slow'
  // A proc on YOU is an incoming mob effect, not our poison — never counted here. Nor is a
  // proc on anything we are not fighting: the log has a `Hakon blinks, looking confused!`
  // (another PLAYER taking a Concussive Strike from someone else's blades), and counting
  // that as a proc of ours would be a claim the line does not support. The zone aggregate
  // is gated the same way, via the encounter — a proc with no open fight is dropped.
  if (idKey(target) === 'you' || !st.isEngagedHostile(idKey(target))) return
  const ambiguous = candidates.length > 1
  const label = ambiguous ? candidates.join(' / ') : strike
  const enc = st.freshEncounter(ts)
  if (enc) {
    enc.agg.procs.addStrike(label, ambiguous, ts, isSlow)
    st.notePresence(target, ts)
    if (isSlow) {
      st.pushMarker(enc, { ts, kind: 'slow', label: SLOW_STRIKE, detail: target })
    }
  }
  st.zoneAgg.procs.addStrike(label, ambiguous, ts, isSlow)
  st.log(ts, 'poison', 'you', `☠ ${label} → ${target}`)
}

/**
 * Count a DISPEL landing on an engaged hostile (Task #64).
 *
 * TWO gates, both load-bearing:
 *   1. DISPEL_FAMILY — the raw landing stream is far too broad to tabulate (one lifetap
 *      message alone resolves to 36 candidate spells), so only the curated dispel family
 *      is counted. See DISPEL_FAMILY for why that is the one family worth a lane.
 *   2. ENGAGED — the ledger describes THIS fight, not every dispel in earshot.
 * `candidates` goes into the label verbatim: each tier is shared by 2–3 spells (law 3), so
 * the count is exact while the name stays honestly uncertain.
 */
export function routeDispelLanding(st: EngineState, ts: number, target: string, candidates: string[]): void {
  if (target === 'self' || candidates.length === 0) return
  if (!candidates.every((c) => DISPEL_FAMILY.has(c))) return
  const key = idKey(target)
  if (key === 'you' || !st.isEngagedHostile(key)) return
  const enc = st.freshEncounter(ts)
  const label = candidates.join(' / ')
  if (enc) enc.agg.procs.addDispel(label)
  st.zoneAgg.procs.addDispel(label)
}

/**
 * Apply a stance/invocation change (Task #51). Updates the current pair and, if an
 * encounter is open, closes the prior span at this ts and opens a new one for the
 * timeline's pinned rows. A no-op change (same name) is ignored so the timeline doesn't
 * accrue zero-width spans from re-asserts.
 */
export function applyStance(st: EngineState, group: 'stance' | 'invocation', name: string, ts: number): void {
  const cur = group === 'stance' ? st.stance : st.invocation
  if (cur?.name === name) return
  if (group === 'stance') st.stance = { name, ts }
  else st.invocation = { name, ts }
  // SESSION SPAN (proc-analytics §3.1), alongside — never instead of — the encounter's
  // stanceSpans below: that list feeds the shipped TimelineView and sits inside the
  // byte-identical regression surface. Two lists, one writer. The nine stances (and the nine
  // invocations) are mutually exclusive, so each is ONE exclusivity group and a commit ENDS the
  // previous span as 'inferred' — the game prints no "your stance ends" line, ever. The no-op
  // re-assert already returned above, so this never accrues zero-width spans.
  commitState(st, { kind: group, key: idKey(name), name, ts, group })
  // Reflect the change on the open encounter's span list (if any).
  const enc = st.current
  if (enc) {
    const prev = [...enc.stanceSpans].reverse().find((s) => s.group === group && s.end === undefined)
    if (prev) prev.end = ts
    enc.stanceSpans.push({ group, name, start: ts })
    // Task #64: the same commit is ALSO a point annotation (the chart draws a tick at it)
    // and a counter on the segment's proc ledger. The span drives the timeline's pinned
    // rows; the marker drives the DPS curve's ticks. Both, because they answer different
    // questions ("what was on" vs "when did it change").
    st.pushMarker(enc, { ts, kind: group, label: name })
    if (group === 'stance') enc.agg.procs.stanceSwitches++
    else enc.agg.procs.invocationSwitches++
  }
  if (group === 'stance') st.zoneAgg.procs.stanceSwitches++
  else st.zoneAgg.procs.invocationSwitches++
}

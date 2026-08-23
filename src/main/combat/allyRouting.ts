// EVERYTHING THE ENGINE DOES WITH A THIRD PARTY'S CHARM PET (JOS-250).
//
// The state machine is `allyCharms.ts` (pure, clock-injected, no engine state); this is its seam
// into the fold — the four ingest handlers and the two routing paths, in one module because they
// are one feature and because splitting them across `ingest.ts` and `routing.ts` pushed both past
// the measured 400-line ceiling. Nothing here is reachable for a line the meter already books:
// every entry point is either a line family combat used to ignore outright (`otherCastBegin`, a
// third party's leader say, mob-vs-mob damage and misses) or an ADDITION to a charm broadcast the
// owner's own model has already declined.
//
// THE ONE PROPERTY THE WHOLE FILE EXISTS TO KEEP: your rows cannot move. `classify()` is not
// touched, `petNames` / `everPet` / `knownPlayers` / the world model's pet set are not written,
// no encounter is opened or extended, nothing is engaged, no presence is refreshed and no target
// is resolved into a world instance. tests/combatCharmOwnership.test.mts W44/W45 pin both halves
// (the ally row exists AND the `you` row is byte-identical to the pre-JOS-250 engine).

import { idKey } from '../log/parser'
import { SEC_AGGREGATE } from './foldProbe'
import type { DamageEvent, MissFold, SourceRef } from './aggregate'
import type { EngineState } from './state'
import type { AllyBind } from './allyCharms'
import type { AllyPetLeaderEvent, CharmEvent, MissEvent, OtherCastBeginEvent } from '../../shared/logEvents'

/**
 * `<Name> begins casting <Spell>.` — THE LINE COMBAT NEVER INGESTED.
 *
 * Parsed since JOS-140 for the buffs model's externals allowlist and read by nothing else; it is
 * the only sentence in this log that says who ELSE is casting what, which makes it the only thing
 * that can name the owner of a caster-less `<mob> has been charmed.` broadcast.
 *
 * Two disjoint jobs, both inside the ally model: it remembers a player-shaped caster as a FRIENDLY
 * (the soft-hostile proof needs a notion of "the charmer's side"), and — only for a spell that
 * could have printed the broadcast — it arms the join. Neither touches your attribution.
 */
export function ingestOtherCastBegin(st: EngineState, ev: OtherCastBeginEvent): void {
  const casterKey = idKey(ev.caster)
  st.ally.noteCast({
    caster: ev.caster,
    casterKey,
    spell: ev.spell,
    ts: ev.ts,
    allowed: st.allyCasterAllowed(casterKey)
  })
}

/**
 * A charm broadcast that resolved none of YOUR casts — the line Task #65 dropped on the floor,
 * now offered to the ally model before it is dropped.
 *
 * The world model is deliberately NOT told. `world.charm()` marks an instance as a pet of yours:
 * it exempts the instance from staleness retirement, keeps it out of the encounter's hostile
 * presence, and puts it in `petInstances()`. An ally's pet is none of those things to us — it is a
 * mob that happens to be fighting for somebody else, and it may very well be a mob we are killing.
 * The ally model holds the bind on its own, keyed by name, and touches nothing the meter's own
 * attribution reads.
 */
export function ingestForeignCharm(st: EngineState, ev: CharmEvent, key: string): void {
  const v = st.ally.broadcast(key, ev.mob, ev.ts)
  if (v.kind === 'bind') {
    const note = v.bind.ambiguous ? ' (a same-named twin is active - crediting nothing)' : ''
    st.log(ev.ts, 'charm', 'info', `⚡ ${ev.mob} charmed by ${v.bind.charmer} - crediting its damage to them${note}`)
    return
  }
  if (v.kind === 'refuse') {
    st.log(ev.ts, 'charm', 'dropped', `⚡ ${ev.mob} charmed by someone else - ${v.reason}`)
    return
  }
  st.log(ev.ts, 'charm', 'dropped', `⚡ ${ev.mob} charmed by someone else - not your pet`)
}

/**
 * `<PetName> says, 'My leader is <Player>.'` about SOMEBODY ELSE — the strongest ally bind, and
 * the only one that reaches a stranger's SUMMONED pet.
 *
 * The parser has already refused every line naming the tailed character (that one is a `petClaim`
 * and binds to you) and every leader that is not player-shaped, so by the time it arrives here the
 * only question left is the behavioural one: a name you have been killing, or that has been
 * charmed, or that is one of your own pets, is not a person (`allyCasterAllowed`).
 *
 * IT ALSO CARRIES THE CHARM-EVIDENCE ANSWER ACROSS (JOS-270). `CharmModel.everCharmed` is the
 * other charm model's session-scoped record of every name a broadcast has ever named, ours or a
 * stranger's; `AllyCharms` does not reach across for it any more than it reaches for
 * `allyCasterAllowed`. It decides the bind's LIFECYCLE, never whether the bind happens.
 */
export function ingestAllyPetLeader(st: EngineState, ev: AllyPetLeaderEvent): void {
  const ownerKey = idKey(ev.owner)
  const petKey = idKey(ev.pet)
  if (!st.allyCasterAllowed(ownerKey)) return
  // Your own pet is yours, whatever a broadcast says about it. `says` is forgeable (JOS-52 states
  // the same caveat from the other side), and the cost of getting this wrong is deleting a real
  // pet's damage — so the refusal is absolute and stated here rather than left to the ordering.
  if (st.petNames.has(petKey) || st.everPet.has(petKey)) return
  const bind = st.ally.bindByLeader({
    petKey,
    pet: ev.pet,
    owner: ev.owner,
    ownerKey,
    ts: ev.ts,
    everCharmed: st.charm.everCharmed(petKey)
  })
  // The classification is SAID, because a lifecycle you cannot see is a lifecycle nobody can
  // report a bug about — the two words are the whole difference between "it broke" and "it kept
  // earning" eighteen minutes later.
  const shape = bind.kind === 'summon' ? 'summoned pet' : 'charmed'
  st.log(
    ev.ts,
    'charm',
    'info',
    `⚡ ${ev.pet} named ${bind.charmer} its leader (${shape}) - crediting its damage to them`
  )
}

/**
 * WHAT ONE SWING BY A THIRD PARTY'S CHARM PET PROVES — read off every attributed AND every ignored
 * line, before the meter decides what to do with it.
 *
 * `classify()` is untouched by this feature, deliberately: it is pure, it is called three times per
 * line by the damage/miss/resist probes, and its four membership sets are the ones that decide
 * YOUR rows. An ally pet is in none of them, so every one of its mob-vs-mob lines already arrives
 * as `'ignore'` — which is exactly the hook this needs and the reason nothing about your own
 * attribution can move.
 *
 * TWO JUDGEMENTS, both of them ENDINGS rather than admissions:
 *
 *   SOFT-HOSTILE PROOF — the bound pet swung at a FRIENDLY (state.allyFriendly). A charmed mob
 *   does not attack its charmer's side, so the charm is over at this instant. Landed or avoided:
 *   the intent is the proof (allyCharms.ts carries the Scooba measurement that settles it).
 *   A CHARM BIND ONLY (JOS-270) — `AllyCharms.softHostile` refuses to end a leader bind, because
 *   a summoned pet has no charm to break and the swing is a name collision. The decision lives
 *   in the model, not here: this file asks, and prints only an ending the model actually made.
 *
 *   TWIN AMBIGUITY — attacker and target share the pet's name, so a second instance of it is
 *   acting and the name's mob-vs-mob lines cannot be told apart. The bind survives (the pet is
 *   still charmed; we simply cannot read its lines) and credits nothing from here on.
 *
 * A line proving either is NEVER credited itself: both run before `routeAllyPetDamage` is offered
 * the line, and both leave the bind uncreditable for it.
 *
 * AND A THIRD, WHICH IS NOT A JUDGEMENT AT ALL: THE PET IS STILL HERE (JOS-270). Every line this
 * function sees is the bound name ACTING, which slides its hold — see `AllyCharms.noteActivity`.
 * It is done here rather than in the two `route…` functions on purpose, because this is the one
 * seam that sees a line whatever the meter goes on to do with it: the twin-ambiguous bind books
 * nothing and must still not be reaped for silence, and the line that proves the break slides a
 * hold that is about to be irrelevant, which costs nothing and needs no ordering rule.
 */
export function noteAllyPetEvidence(st: EngineState, attacker: string, target: string, ts: number): void {
  if (st.ally.idle) return
  const aKey = idKey(attacker)
  const bind = st.ally.bindOf(aKey)
  if (!bind) return
  st.ally.noteActivity(aKey, ts)
  if (aKey === idKey(target)) {
    if (st.ally.markAmbiguous(aKey)) {
      st.log(ts, 'charm', 'dropped', `~ ${bind.display}: a second one is active - ${bind.charmer}'s pet is unreadable`)
    }
    return
  }
  if (!st.allyFriendly(idKey(target))) return
  if (!st.ally.softHostile(aKey)) return
  st.log(ts, 'charm', 'dropped', `✕ ${bind.display} turned on ${target} - ${bind.charmer}'s charm broke`)
}

/**
 * THE ALLY PET'S OWN METER ROW.
 *
 * THE ROW ID CARRIES THE CHARMER. `allypet:<charmer>:<pet>` rather than `allypet:<pet>`: the same
 * mob re-charmed by a different enchanter is a different person's contribution, and one row
 * summing both would be the "aggregates lie" failure with two names on it (law 5).
 */
function allyPetSource(bind: AllyBind): SourceRef {
  return {
    id: `allypet:${bind.charmerKey}:${bind.nameKey}`,
    // The BROADCAST's spelling, not the damage line's: EQ sentence-cases a leading article, and a
    // row whose name flickered between `a rock golem` and `A rock golem` is world-model law 2's
    // exact complaint.
    name: `Pet (${bind.display}) - ${bind.charmer}`,
    kind: 'allyPet'
  }
}

/**
 * Book one mob-vs-mob damage line to the ally who owns the attacker. Called only for lines
 * `classify()` ignored, and only while the bind is live and unambiguous.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, and every omission is the 214-second merged pull (Task #65's
 * cautionary tale) refusing to come back:
 *   * it never OPENS an encounter. `freshEncounter` returns the in-progress fight only while that
 *     fight is fresh; a stranger's brawl before your first pull books to the zone lane and nowhere
 *     else. This is the same rule miss / resist / mitigation follow (world-model law 8).
 *   * it never EXTENDS one: `enc.lastTs`, `prevDamageTs`, `activeMs` and `lastActivityTs` are all
 *     untouched, so no closure clock moves and no fight can be held open by somebody else's pet.
 *   * it never ENGAGES anything and never refreshes presence, so nothing enters `enc.engaged` and
 *     no hostile's liveness is vouched for by a fight we are not in.
 *   * it never resolves the TARGET into a world instance. Minting one is a world-model side effect
 *     for a mob we may never have touched; `defenderLabel` gives the instance label when the name
 *     IS already engaged in this fight and the raw name otherwise, which is the honest label.
 *   * it never `bumpTarget`s, so the "largest target" a fight is NAMED after stays a fact about
 *     what YOU (and your group) fought.
 */
export function routeAllyPetDamage(st: EngineState, ev: DamageEvent): void {
  if (st.ally.idle) return
  const bind = st.ally.creditable(idKey(ev.attacker))
  if (!bind) return
  const src = allyPetSource(bind)
  const enc = st.freshEncounter(ev.ts)
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  enc?.agg.addOut(src, ev)
  st.zoneAgg.addOut(src, ev)
  if (p) p.leave()
  const tgtName = enc ? st.defenderLabel(enc, ev.target, ev.ts) : ev.target
  if (enc) st.pushTimeline(enc, {
    ts: ev.ts, lane: ev.skill, category: ev.category, amount: ev.amount,
    crit: ev.crit, modifiers: ev.modifiers, kind: 'allyPet', target: tgtName
  })
  st.log(ev.ts, ev.dtype, 'allyPet', `${src.name} → ${tgtName}  ${ev.amount}${ev.crit ? '*' : ''}  ${ev.skill}`)
}

/** The avoided-swing twin of the above — the ally pet's own hit%, on the same aggregate-only
 *  terms. A miss carries no amount, so this can move no total anywhere (law 8). */
export function routeAllyPetMiss(st: EngineState, ev: MissEvent, fold: MissFold): void {
  if (st.ally.idle) return
  const bind = st.ally.creditable(idKey(ev.attacker))
  if (!bind) return
  const src = allyPetSource(bind)
  const enc = st.freshEncounter(ev.ts)
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  enc?.agg.addOutMiss(src, fold)
  st.zoneAgg.addOutMiss(src, fold)
  if (p) p.leave()
  const tgtName = enc ? st.defenderLabel(enc, ev.target, ev.ts) : ev.target
  if (enc) st.pushTimeline(enc, {
    ts: ev.ts, lane: 'Melee', category: 'melee', amount: 0, crit: false, kind: 'allyPet',
    outcome: 'miss', detail: ev.mtype, target: tgtName
  })
  st.log(ev.ts, 'miss', 'allyPet', `${src.name} ✕ ${tgtName} (${ev.mtype})`)
}

// WHAT BINDS ONE OF *YOUR* PETS — the three lines that say an entity is yours, and the single
// state transition all three go through.
//
//   the private `… Master.` TELL             unforgeable, but only ever sent by an ORDERED pet (JOS-47)
//   the public /pet who leader ANSWER        the on-demand way out of that blind spot (JOS-52)
//   your own pet-only BUFF landing           the one that costs the player nothing (JOS-188)
//
// EXTRACTED FROM ingest.ts VERBATIM (JOS-250), because that file grew a second ownership feature
// and the measured 400-line ceiling is a split rather than a ratchet (eslint.config.mjs). Nothing
// here changed in the move except its address; its sibling is allyRouting.ts, which answers the
// same question about somebody ELSE's pet and shares not one line of code with it — on purpose,
// because they are opposite claims about ownership and law 4 is a scar from a shared path.

import { idKey } from '../log/parser'
import type { EngineState } from './state'
import type { PetClaimEvent } from '../../shared/logEvents'

/** How a pet came to be bound. Only the debug line reads it — every route below is the same
 *  state transition, on purpose (a second retirement path is what law 4 is a scar from). */
type ClaimVia = PetClaimEvent['via'] | 'petBuff'

const CLAIM_NOTE: Record<ClaimVia, string> = {
  tell: '',
  leader: ' (it named you its leader)',
  petBuff: ' (you cast a pet-only spell on it)'
}

/**
 * A pet identified you as its owner, so the named entity is your pet. THREE lines produce this
 * one transition, and this function deliberately does not care which — `via` reaches the debug
 * line and nothing else:
 *
 *   via 'tell'    `<Name> told you, '… Master.'` — private, unforgeable, but only ever sent by a
 *                 pet you have ORDERED.
 *   via 'leader'  `<Name> says, 'My leader is <You>.'` — the `/pet who leader` answer (JOS-52),
 *                 the on-demand way out of that blind spot. Broadcast, so the parser has already
 *                 refused every one of these that named anyone but the tailed character; by the
 *                 time it arrives here it is the same fact the tell states.
 *   via 'petBuff' a named landing that resolved YOUR OWN cast of a `targetType: Pet` spell
 *                 (JOS-188 — bindPetBuffLanding below). The one route that needs nothing of the
 *                 player but the buff they were casting anyway.
 *
 * Ownership-DEFINITIVE and pet-only, which is why it also PROMOTES: a name we saw charmed but
 * declined to bind (no own cast behind the broadcast) is bound HERE, and bound as CHARMED rather
 * than summoned — AGENTS.md's rule that a claim from a name ever seen charmed re-arms the
 * charmed set, never the permanent one.
 *
 * Otherwise it binds a SUMMONED pet (idempotent; a charmed mob sends the tell too — the real log
 * shows both — and world.claim() leaves an already-charmed instance's petKind alone, so a
 * charmed pet is never reclassified as summoned). It adds the name to the ATTRIBUTION set only.
 */
function bindPetClaim(st: EngineState, name: string, ts: number, via: ClaimVia): void {
  const key = idKey(name)
  // Anything that names itself YOURS stops being anybody else's (JOS-250). All three claim routes
  // are ownership-definitive and first-person; an ally bind rests on a broadcast, which is weaker
  // by construction, so this direction of the override needs no tie-break.
  st.ally.release(key)
  const promote = !st.world.petInstance(name) && st.charm.claimIsCharmed(key, ts)
  const inst = promote ? st.world.charm(name, ts) : st.world.claim(name, ts)
  st.notePet(key)
  // The claim is also the corroboration a provisional charm bind was waiting for.
  st.charm.notePetEvidence(key)
  // …and it is the ANSWER to the JOS-258 nudge, whichever of the three routes produced it. A bound
  // pet needs no coaching, so the nudge dismisses EARLY here — and one that arrives inside the
  // grace window means it was never drawn at all. All three routes go through this function, which
  // is the whole reason there is one place to say this.
  st.petNudge.noteBound()
  const what = promote ? 'charm claim' : 'pet claim'
  st.log(ts, promote ? 'charm' : 'pet', 'info', `⚡ ${what} ${st.world.label(inst)} [${inst.instanceId}]${CLAIM_NOTE[via]}`)
  // SINGLE-PET SUCCESSION (JOS-54): claiming a NEW summoned pet retires the previous one inside
  // the world model, and the name index has to follow it out or routing would go on admitting
  // the retired pet's swings as yours. Same two-line follow-through death already does — the
  // world model decides, `petNames` and the charm model are told.
  for (const gone of st.syncPetNames()) {
    st.charm.release(gone)
    st.log(ts, 'pet', 'info', `✕ ${gone} retired - one pet at a time; ${name} is yours now`)
  }
}

export function ingestPetClaim(st: EngineState, ev: PetClaimEvent): void {
  bindPetClaim(st, ev.name, ev.ts, ev.via)
}

/**
 * THE UPGRADED PET (JOS-188) — `You begin casting Burnout.` … `<Name> goes berserk.`
 *
 * The reported defect: a magician upgraded a level-10 water elemental to a level-14 one and the
 * new pet never appeared in the meter; relogging did not help. Nothing was broken. The JOS-54
 * succession law never RAN, because succession is triggered by the successor's own claim and an
 * upgraded summon produces none: `world.claim()` binds a NAME, the new pet has a different one,
 * and the only two binding lines the app had both require the player to TALK to the pet. The
 * reporter's 30-minute slice holds 2,446 lines, two pets and ZERO tells — replayed through this
 * engine before the fix it ends with `petDisplayNames() === []` and one row, You. The successor
 * landed 89 hits / 3,385 points into nobody's column; the predecessor's 187 / 5,698 sat frozen
 * in a row that had stopped growing, which is exactly what "they stop showing up" describes.
 *
 * THE THIRD BINDING SIGNAL, and the first that costs the player nothing. 40 spells in the DB are
 * `targetType: Pet` (charmModel.ts PET_TARGET_SPELLS) and the game will not let one land on
 * anything but your own pet; `You begin casting <Spell>.` is printed for the player and NOBODY
 * else. So the pair — own cast, then a landing that resolves it — names your pet as surely as
 * the tell does, and it fires at the moment a summoner buffs the pet they just summoned rather
 * than at the moment they first order it.
 *
 * MEASURED, owner's whole log (1,557,569 lines): 19 binds, 14 distinct names, and every one of
 * the 14 is a name a `… Master.'` tell ALSO bound — no name is bound by this rule alone, and no
 * bind contradicts one. In all 14 this arrives FIRST, by 81 s to 2,528 s, and the damage those
 * pets landed in the gaps is 1,865 hits / 27,088 points the meter throws away today (Giber
 * alone: 947 hits / 11,636 points over 42 minutes). On the reporter's slice it binds Jabektik at
 * 11:26:40, ten seconds before its first swing.
 *
 * THE MESSAGE IS NOT THE GATE — the armed own cast is. `goes berserk.` resolves to
 * Burnout / Fury / Rage / Voice of the Berserker and only Burnout is a pet spell, so the
 * candidate list must contain the spell we are mid-cast of. That is `charmBroadcast`'s test with
 * one more field, and for the same reason: a caster-less line is ours only when it resolved one
 * of our own casts.
 *
 * AND THE RUNG HAS A SILENT PRECONDITION: THE DB MUST BE ABLE TO NAME THE SPELL (JOS-349).
 *
 * The candidate test above is the whole gate, and a landing's candidates come from the spell DB's
 * cast-on-other SUFFIX table — which is keyed on what follows the wiki's `Someone ` subject and
 * nothing else. So a `targetType: Pet` spell whose scraped third-person message carries some OTHER
 * subject token is in no table, can never be a candidate for its OWN landing, and this rung cannot
 * fire for it however correct the arm is. Nothing here is wrong when that happens; the two halves
 * simply never meet, and from the outside it looks exactly like JOS-188 before the fix.
 *
 * MEASURED (report 01M00ACVVFDRVWBXRDCFPHESNZ, a shaman whose re-summoned pet `Zarober` stopped
 * being attributed): his slice holds the pair four seconds apart — `You begin casting Tiny
 * Companion.` then `Zarober shrinks.` — and no tell and no leader say anywhere in 6,544 lines.
 * `Tiny Companion` is one of THREE spells that write ` shrinks.` and the only pet-only one, and the
 * scrape gave it `Target shrinks.`, so it was absent from the candidate list its own landing
 * produces. Replayed before the fix: `petDisplayNames() === []` and 142 pet lines attributed to
 * nobody. The fix is a data row, not a rule change — `spellCorrectionsSubjects.ts`, THE PET-BINDING
 * HALF — because the rule was right and the evidence it reads was missing a word.
 *
 * SIX MORE PET-ONLY SPELLS ARE STILL IN THAT STATE (40 are `targetType: Pet`, 33 key a suffix).
 * They are named in that file and they wait for a log that prints the pair; a pattern is not a
 * measurement. If a report says a pet stopped being attributed, CHECK THE CANDIDATE LIST FIRST —
 * there is no time limit on a summoned pet and no rule here that drops one, so an absent bind is
 * almost always a bind that never happened.
 *
 * WHAT IT DOES NOT FIX, stated rather than papered over: a player who casts no pet-only buff
 * still has a pet the log cannot bind until they order it (JOS-49's accepted blind spot). Report
 * 01KZN569YA6T751QCJW99P1ZCA is that case — its pet buffs (`Spirit of the Puma`, `Spiritual
 * Brawn`, `Inner Fire`) are not `targetType: Pet`, so this rung produces zero binds there and
 * its three `told you, 'Attacking … Master.'` tells remain the only evidence in it. Same root
 * cause, different half: the answer for them is still to order it once.
 *
 * AND IT IS THE COMBAT MODEL'S BIND ONLY. `modules/buffs.ts` runs its own entity-level pet
 * succession off the `petClaim` LOG EVENT (AGENTS.md law 4: two models, different reach, by
 * measurement rather than oversight), and this rung produces no such event — it is a state
 * transition inside the engine, not a line the parser can emit, because the arm is per-stream
 * state and `parseEvent` is per-line. So the buff module's pet slot still waits for the tell,
 * exactly as it did before this ticket: no worse, not yet better. Making it better means either
 * a derived-event seam the session feeds to both, or a second arm in the buffs module — and a
 * second arm is precisely the duplicated retirement path law 4 is a scar from, so it does not
 * get built on the way past without its own measurement.
 */
export function bindPetBuffLanding(st: EngineState, ts: number, target: string, spellNames: readonly string[]): void {
  if (!st.charm.petBuffLanding(spellNames, ts)) return
  // A landing on YOURSELF is a self-buff the DB mislabels, never a pet (the parser emits
  // target 'self' for the msgCastOnYou form, but the third-person form can still name you when
  // another player's buff lands on you in the same second).
  if (target === '' || idKey(target) === st.playerKey) return
  bindPetClaim(st, target, ts, 'petBuff')
}

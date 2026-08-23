// THE ALLY-CHARM MODEL (JOS-250) — whose pet is that, when it is not yours?
//
// ─────────────────────────────────────────────────────────────────────────────
// THE QUESTION, AND WHY THE ANSWER USED TO BE "NOBODY'S"
//
// `<mob> has been charmed.` names no caster (charmModel.ts's header has the whole argument), so
// Task #65 bound it only when it resolved one of the OWNER's own casts and dropped every other
// one on the floor. That was right, and it is still right for YOUR rows — but it also meant a
// group-mate's enchanter contributed literally nothing to the meter, which is the reddit report
// this ticket answers ("i have no idea what these enchanters in my groups are doing").
//
// The line that closes the gap has been parsed since JOS-140 and was never ingested by combat:
//
//     <Name> begins casting <charm spell>.        (otherCastBegin)
//
// MEASURED, owner's whole log, 1,608,483 lines, 2026-08-12 (re-derived through the SHIPPED roster
// and the SHIPPED arm window, not a re-implementation): 456 charm broadcasts — 441 resolve one of
// the owner's own casts, 15 resolve a NAMED third party's, 0 resolve nothing, 0 resolve both. A
// perfect split, with no heuristic in it.
//
// ─────────────────────────────────────────────────────────────────────────────
// BINDING — two paths, both of which NAME BOTH ENDS
//
//   1. CAST + BROADCAST JOIN. A charm-family cast by a PLAYER-SHAPED name arms a window of that
//      spell's own cast time plus the same slack `CharmModel` uses for your casts; a caster-less
//      broadcast landing inside exactly ONE armed window binds that mob to that caster.
//   2. LEADER SAY. `<PetName> says, 'My leader is <Player>.'` (the `allyPetLeader` event) binds
//      outright — it is the only line in the game that names both the pet and its owner, and it
//      covers a stranger's SUMMONED pet as well, which no charm broadcast can.
//
// THE CASTER GATE IS THE WHOLE DEFENCE OF PATH 1. Mobs cast charm songs at you — the log holds
// `A fire giant warrior begins singing Solon's Bewitching Bravura.` — so a rule that read the
// SHAPE of the line without the shape of the NAME would file a fire giant as a charmer.
// shared/playerShape.ts is that gate; a rostered group-mate always qualifies regardless.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE PET IS DECIDES HOW IT ENDS (JOS-270, owner ruling 2026-08-13)
//
// The two paths above bind two DIFFERENT KINDS OF CREATURE, and until JOS-270 both wore the
// charm lifecycle because charm is what path 1 sees. A leader say does not say "charmed"; it
// says "this thing has an owner", and the commonest thing it names is an ally's SUMMONED pet —
// the one creature no charm broadcast can ever reach (that is the whole reason path 2 exists).
//
// **THE LIFECYCLE KEYS ON THE EVIDENCE, NEVER ON WHICH LINE BOUND IT** (owner, in as many
// words). `/pet who leader` is answered by a CHARM pet exactly as readily as by a summoned one,
// so `via: 'leader'` implies nothing whatever about the creature. `AllyBind.kind` is the answer
// to a separate question — what has the log actually said this thing IS — and `bindByLeader`
// derives it from two signals plus a default:
//
//   CHARM EVIDENCE, FOR THIS PET   any `<name> has been charmed.` broadcast has ever named it
//                                  (the caller's `everCharmed`, CharmModel's session-scoped
//                                  `seenCharmed` — ours or a stranger's, both count). The most
//                                  specific signal there is, because it is keyed by the PET, so
//                                  it outranks the other one. ⇒ `kind: 'charm'`.
//   SUMMON EVIDENCE, FOR THIS OWNER   this ally has been seen casting a pet-summon spell at or
//                                  before the say (`noteCast` + JOS-258's `isPetSummonSpell`,
//                                  itself JOS-251's wiki-derived `petSummonRoster`). Weaker on
//                                  purpose, and the weakness is named: it is about the PERSON,
//                                  not about the pet, so it cannot tell which of an ally's
//                                  creatures is talking. ⇒ `kind: 'summon'`.
//   NEITHER                        ⇒ `kind: 'charm'`, THE SAFER DEFAULT, and the asymmetry is
//                                  the owner's own reasoning: wrongly keeping the break rule
//                                  loses some damage, wrongly dropping it can credit a re-hostile
//                                  mob to a player, which is worse.
//
// A `kind: 'summon'` bind is exempt from exactly two of the four ends below, and from nothing
// else:
//
//   NO SOFT-HOSTILE BREAK   there is no charm to break. MEASURED on report
//                           01KZVYMCAD72XFC36D73D8J2E8: the rule fired at 17:33:20 because the
//                           ally's pet Gasarn hit `a wan ghoul knight` — which happened to be
//                           the NAME of the reporter's own charm pet, so `allyFriendly` said
//                           yes. A PURE NAME COLLISION, and it ate 3,409 of the pet's 11,905
//                           (29 percent) for the rest of the fight.
//   NO HOLD CLOCK           `holdUntil` is `Infinity`. The charm hold is a bound derived from a
//                           SPELL's listed duration; a summoned pet outlives every one of them,
//                           and there is no spell here to derive anything from.
//
// It still ends on PET DEATH, on a ZONE, and on a genuine RE-BIND, all below — and it is still
// the log naming both ends that created it. ZERO NEW ADMISSIONS: this ruling did not widen what
// may be believed, it narrowed which endings apply to which creature.
//
// AND THE CHARM LIFECYCLE IS UNTOUCHED FOR EVERYTHING CHARM-SHAPED. Every `broadcast()` bind is
// `kind: 'charm'` by construction (the line that made it says the word), and a leader say about
// a name the zone has seen charmed is `kind: 'charm'` too — all four ends, byte for byte,
// including the soft-hostile proof JOS-250 measured. The whole-log split (441 the owner's, 15 a
// third party's) and the Scooba/Gordon windows still describe this model exactly.
//
// ─────────────────────────────────────────────────────────────────────────────
// UNBINDING — four ends, every one of them a line the log actually prints
//
//   SOFT-HOSTILE PROOF   the bound pet SWINGS AT A FRIENDLY (you, your pet, a rostered member,
//                        its own charmer, any charmer of a live ally pet, any other live ally
//                        pet). A charmed mob does not attack its charmer's side, so this is the
//                        break, at that instant. It is the investigation's own earliest-proof
//                        metric — and it is TIGHT rather than lossy precisely because a broken
//                        pet stops fighting mobs, so the blind window before it contains almost
//                        no mob-vs-mob damage to get wrong. `kind: 'charm'` ONLY (JOS-270): see
//                        the lifecycle section above for why a summoned pet is exempt.
//   PET DEATH            the ordinary death line for the bound name.
//   RE-CHARM             a new broadcast/cast-join for the same mob — by the same charmer it
//                        RESTATES (the hold is re-based), by a different one it REBINDS.
//   SILENCE               the bound name has not acted for a whole window. `kind: 'charm'` ONLY
//                        (JOS-270): a summoned pet holds no clock at all.
//
//                        THIS USED TO BE "HOLD EXPIRY" — a wall clock started at the bind and
//                        run to the spell's LISTED duration plus slack, on the argument that a
//                        charm cannot outlive its spell. **THAT ARGUMENT IS WRONG ABOUT THE
//                        REAL GAME** (owner ruling 2026-08-13, JOS-270): AAs and focus effects
//                        extend a charm well past the figure in the spell DB, so a fixed clock
//                        cuts a still-live charm loose and under-attributes exactly the way
//                        this ticket exists to stop.
//
//                        SO THE HOLD SLIDES ON EVIDENCE. Every line the bound name ACTS on
//                        re-bases `holdUntil` to that line's ts plus the bind's own window, and
//                        `sweep` therefore reaps a pet that has STOPPED APPEARING rather than
//                        one that outlived a wiki number. The window is still the spell's (per
//                        cast where the cast was seen, the default charm duration for a leader
//                        bind), because the question it answers is "how long may this name be
//                        quiet and still plausibly be charmed" — and no better figure exists.
//
//                        THE MIRROR: a CONFIRMED own charm never auto-expires at all
//                        (charmModel.ts — evidence ends it, never a clock). This brings the
//                        ally binds to the same philosophy while keeping the one job the clock
//                        was always really doing, which is reaping a pet that vanished.
//
// A SWING COUNTS, LANDED OR NOT, and that is measured rather than generous. In the Scooba episode
// (Tue Aug 04 16:59) `A Knight of Innoruuk tries to punch Scooba, but misses!` is two seconds
// after the broadcast and its first LANDED punch is twenty-eight seconds after it. The intent is
// what proves the break; refusing the miss would have credited a stranger twenty-six seconds of a
// pet that had already turned on him.
//
// NOTHING IS RETRO-UNCREDITED. Damage booked before the proof stays booked — the pet really was
// charmed then, and reaching backwards would mean a meter that changes numbers it has already
// shown. This is the same "binds forward, not backward" rule the pet-claim tell follows (JOS-49).
//
// ─────────────────────────────────────────────────────────────────────────────
// REFUSALS — the four shapes where the honest answer is nothing at all
//
//   SAME-NAMED TWIN      while a second instance of the pet's name is acting unbound, the name's
//                        mob-vs-mob lines cannot be told apart. The canonical fixture is the rock
//                        golem episode (Thu Jul 30 18:27): the very first line after the
//                        broadcast is `A rock golem pierces a rock golem for 102 points`, and the
//                        window continues that way. Detected off the log rather than guessed —
//                        an attacker whose name equals its target's name IS the ambiguity.
//   MULTI-CASTER TIE     two different charmers armed over one broadcast with nothing to separate
//                        them. Measured exactly once in the whole log: Paladrial and Satya both
//                        casting Cajoling Whispers III at `a lava duct crawler`, Fri Jul 31
//                        21:13:14. Refuse; a coin flip credited to a named person is worse than
//                        silence.
//   BARD CHARM           `Solon's Bewitching Bravura` prints `Someone 's eyes glaze over.`, not
//                        the charm broadcast, so it can never be the cast a broadcast resolved
//                        (charmModel.isCharmBroadcastSpell). JOS-200's standing cost; not
//                        relitigated.
//   NON-PLAYER CASTER    the caster gate above.
//
// ─────────────────────────────────────────────────────────────────────────────
// PURE + CLOCK-INJECTED, exactly like `CharmModel`: no Date.now(), no engine state, no I/O. Every
// method takes the log timestamp it is reasoning at, so a replay and a live tail behave
// identically (tests/foldDeterminism.test.mts's property).

import {
  DEFAULT_CHARM_DURATION_MS,
  DURATION_SLACK_MS,
  armWindowMs,
  isCharmBroadcastSpell,
  provisionalWindowMs
} from './charmModel'
import { isPetSummonSpell } from './petNudge'
import { isPlayerShapedName } from '../../shared/playerShape'
import { spellCanonKey } from '../log/parseCommon'

/** One live third-party charm bind. */
export interface AllyBind {
  /** Canonical key of the bound pet. */
  nameKey: string
  /** The pet's display name as the CHARM BROADCAST spelled it (lowercase article, world-model
   *  law 2) — never the sentence-cased spelling a damage line happens to carry. */
  display: string
  charmerKey: string
  charmer: string
  boundTs: number
  /**
   * HOW LONG THIS NAME MAY BE QUIET and still plausibly be bound — the bind's own window, slid
   * forward by `noteActivity` on every line the name acts on (JOS-270). `Infinity` when `kind` is
   * `'summon'`, which has no clock at all. `sweep` reads this and nothing else, so both "no
   * clock" and "still fighting" need no second code path.
   */
  holdUntil: number
  /**
   * THE WINDOW `holdUntil` IS SLID BY: the charm's own listed duration + slack where a cast was
   * observed, `DEFAULT_CHARM_DURATION_MS + DURATION_SLACK_MS` for a charm-class leader bind (no
   * spell is named), `Infinity` for a summon-class one. Held on the bind rather than recomputed
   * because the spell that explains a bind is knowable only at the moment it is made.
   */
  windowMs: number
  /**
   * A second instance of this NAME has acted unbound, so the name's mob-vs-mob lines are
   * unattributable. Sticky for the life of the bind: the twin does not announce its departure
   * either, so "it got better" is not a thing this log can say.
   */
  ambiguous: boolean
  /** Which line bound it — the debug line reads it, and the test asserts on it. NOT the
   *  lifecycle discriminant: `/pet who leader` is answered by charm pets too (JOS-270). */
  via: 'cast' | 'leader'
  /**
   * WHAT THE EVIDENCE SAYS THIS CREATURE IS, and therefore which endings apply to it — the
   * lifecycle discriminant (JOS-270). `'charm'` wears all four ends below; `'summon'` is exempt
   * from the soft-hostile break and the hold clock. Derived in `bindByLeader`; always `'charm'`
   * for a `broadcast()` bind, because the line that made that one says the word.
   */
  kind: 'charm' | 'summon'
}

/** What a caster-less `<mob> has been charmed.` broadcast means for a THIRD PARTY. */
export type AllyVerdict =
  /** Bound (or re-bound / restated) to a named charmer. */
  | { kind: 'bind'; bind: AllyBind }
  /** Evidence exists but is unusable, and the reason is worth printing. */
  | { kind: 'refuse'; reason: string }
  /** No third-party cast is armed at all — this model has nothing to say about the line. */
  | { kind: 'none' }

/** A bind whose hold has run out, for the caller's processing line. */
export interface AllyExpiry {
  nameKey: string
  display: string
  charmer: string
}

/** One `<Name> begins casting <Spell>.` line, as the ally model asks about it. An args object
 *  rather than five positionals: the caller has already canonicalized the name and already asked
 *  the engine's behavioural guards, and neither answer should be positional. */
export interface AllyCastLine {
  /** The caster's raw display name, exactly as the line spelled it (world-model law 2). */
  caster: string
  /** Canonical key for the same name. */
  casterKey: string
  spell: string
  ts: number
  /** `EngineState.allyCasterAllowed` — the behavioural half of the caster gate. */
  allowed: boolean
}

/** One `<PetName> says, 'My leader is <Player>.'` line about somebody else. */
export interface AllyLeaderLine {
  petKey: string
  /** The pet's display name, as the say spelled it. */
  pet: string
  owner: string
  ownerKey: string
  ts: number
  /**
   * `CharmModel.everCharmed(petKey)` — has ANY charm broadcast, the owner's or a stranger's,
   * ever named this pet in this session? THE CHARM-EVIDENCE HALF of the lifecycle question
   * (JOS-270), and the caller's to answer for the same reason `AllyCastLine.allowed` is: the
   * fact lives in the other charm model, and this one does not reach across for it.
   */
  everCharmed: boolean
}

interface AllyArm {
  charmerKey: string
  charmer: string
  spellKey: string
  ts: number
  until: number
}

export class AllyCharms {
  /**
   * Third-party charm casts in flight, newest last. A MAP KEYED BY CASTER, not the single slot
   * `CharmModel` uses: you cast one spell at a time, but a zone can hold three enchanters, and
   * collapsing them would silently make every one of their broadcasts look like the last caster's.
   */
  private arms = new Map<string, AllyArm>()
  /** nameKey → the live bind. */
  private binds = new Map<string, AllyBind>()
  /**
   * Player-shaped names seen CASTING (`<Name> begins casting …`, any spell) plus every charmer
   * this model has bound for. THE FRIENDLY SET FOR SOFT-HOSTILE PROOF AND NOTHING ELSE — it is
   * never consulted for attribution, never merged into `EngineState.knownPlayers`, and cannot
   * move a point of YOUR damage (see state.ts notePlayer for why that separation is not optional).
   *
   * Why casting at all: it is the one third-person line in this log whose subject is doing
   * something a player does deliberately, and shared/playerShape.ts refuses the article-named
   * mobs that also cast. Its job is to stop a stranger's DPS being inflated with the damage their
   * ex-pet is doing TO THEIR OWN GROUP — measured all over this corpus (Bodegas, Wemby, Sind,
   * Selmak, Gordon, Phatez are each beaten on by a charm pet that had just broken).
   */
  private friendlies = new Set<string>()
  /**
   * casterKey → the timestamp this ally was last seen CASTING A PET SUMMON (JOS-270). The summon
   * half of the lifecycle question, and deliberately the weaker half: it is keyed by the PERSON,
   * because no summon line ever names the pet it makes (that is JOS-49's whole blind spot and
   * JOS-258's whole subject). It can therefore say "this ally has a summoned pet", never "THIS
   * is it" — which is exactly why the pet-keyed charm evidence outranks it in `bindByLeader`.
   *
   * SURVIVES A ZONE, like `friendlies` and unlike the binds: a summoned pet walks through the
   * door with its owner (the world model's own zone rule says so), so the sighting is still true
   * on the other side. Cleared only by `reset()`, which is a different character's session.
   */
  private summons = new Map<string, number>()

  reset(): void {
    this.arms.clear()
    this.binds.clear()
    this.friendlies.clear()
    this.summons.clear()
  }

  /**
   * `<Name> begins casting <Spell>.` — remember a player-shaped caster, and arm the join when the
   * spell is one that could have printed the charm broadcast.
   *
   * `admitted` is the caller's answer to "is this a rostered group-mate" (they always qualify as a
   * caster, whatever their name looks like); `allowed` is the caller's behavioural refusal — a
   * name you have landed damage on, or that has ever been charmed, or that is or was your pet, is
   * a MOB and can never be a charmer (state.ts's three absolute guards, borrowed rather than
   * re-derived).
   */
  noteCast(c: AllyCastLine): void {
    if (!c.allowed) return
    if (!isPlayerShapedName(c.caster)) return
    this.friendlies.add(c.casterKey)
    // THE SUMMON SIGHTING (JOS-270). Behind the same two gates as everything else this method
    // learns, and recorded before the charm-arm return so a summon is never missed by falling
    // through a test about a different spell family. It arms NOTHING — no bind can come of it
    // (that is JOS-49's ruling, untouched); it is read only when a leader say later asks what
    // kind of creature it is looking at.
    if (isPetSummonSpell(c.spell)) this.summons.set(c.casterKey, c.ts)
    if (!isCharmBroadcastSpell(c.spell)) return
    this.arms.set(c.casterKey, {
      charmerKey: c.casterKey,
      charmer: c.caster,
      spellKey: spellCanonKey(c.spell),
      ts: c.ts,
      until: c.ts + armWindowMs(c.spell)
    })
  }

  /** A rostered group-mate is a friendly whatever their name looks like. */
  noteFriendly(nameKey: string): void {
    this.friendlies.add(nameKey)
  }

  /**
   * `<mob> has been charmed.` that the OWNER's model already declined. Returns what the third-party
   * evidence says. Consumes the winning arm, for `charmBroadcast`'s reason: every charm spell in
   * the DB is single-target, so one cast explains exactly one broadcast.
   */
  broadcast(nameKey: string, display: string, ts: number): AllyVerdict {
    this.pruneArms(ts)
    // THE LINE ITSELF IS CHARM EVIDENCE ABOUT THIS NAME, whatever it resolves to (JOS-270). If a
    // live bind of that name is currently wearing the summon lifecycle, the log has just
    // contradicted it and the charm endings come back. One direction only, and it is the safe
    // one: this can ADD the break rule and the hold clock, never remove them.
    const live0 = this.binds.get(nameKey)
    if (live0?.kind === 'summon') {
      live0.kind = 'charm'
      live0.windowMs = DEFAULT_CHARM_DURATION_MS + DURATION_SLACK_MS
      live0.holdUntil = ts + live0.windowMs
    }
    const live = [...this.arms.values()].filter((a) => ts >= a.ts && ts <= a.until)
    if (live.length === 0) return { kind: 'none' }
    const casters = new Set(live.map((a) => a.charmerKey))
    if (casters.size > 1) {
      // Consume them all: a tie says none of these casts is explained by anything else either, and
      // leaving them armed would hand the NEXT broadcast to a cast that has already been spent.
      for (const a of live) this.arms.delete(a.charmerKey)
      this.binds.delete(nameKey)
      return { kind: 'refuse', reason: `${casters.size} casters armed - cannot tell whose charm this is` }
    }
    const arm = live[live.length - 1]
    this.arms.delete(arm.charmerKey)
    const prev = this.binds.get(nameKey)
    const windowMs = provisionalWindowMs(arm.spellKey)
    const bind: AllyBind = {
      nameKey,
      display,
      charmerKey: arm.charmerKey,
      charmer: arm.charmer,
      boundTs: prev?.charmerKey === arm.charmerKey ? prev.boundTs : ts,
      windowMs,
      holdUntil: ts + windowMs,
      // A RE-CHARM BY THE SAME CHARMER DOES NOT CLEAR AMBIGUITY. The twin that made the name
      // unreadable is still standing there; only its own death or a zone line ends it, and neither
      // prints anything this model could read as "you may resume".
      ambiguous: prev?.charmerKey === arm.charmerKey ? prev.ambiguous : false,
      via: 'cast',
      // A charm broadcast made this bind, so the creature is a charmed mob by construction —
      // there is no evidence question to ask here (JOS-270).
      kind: 'charm'
    }
    this.binds.set(nameKey, bind)
    this.friendlies.add(arm.charmerKey)
    return { kind: 'bind', bind }
  }

  /**
   * `<PetName> says, 'My leader is <Player>.'` — the strongest ally bind there is, and the only
   * one that reaches a stranger's SUMMONED pet.
   *
   * AND IT IS WHERE THE LIFECYCLE QUESTION IS ANSWERED (JOS-270, owner ruling 2026-08-13) —
   * because it is the only bind whose creature the line does not state. `/pet who leader` is
   * answered by a CHARM pet just as readily as by a summoned one, so `via: 'leader'` is not the
   * discriminant and must never be used as one; `classify` below reads the evidence instead.
   *
   * WHAT CHANGES WITH THE ANSWER. A `'charm'` bind is exactly what this method has always
   * produced, down to `DEFAULT_CHARM_DURATION_MS + DURATION_SLACK_MS` — the 16-minute figure
   * every charm but two is listed at. A `'summon'` bind drops the two endings a summoned pet
   * does not have: the hold becomes `Infinity` and `softHostile` refuses to break it, leaving
   * death, a zone, and a genuine re-bind.
   *
   * The bind is still only as strong as the line: both ends named, out loud, by the log.
   */
  bindByLeader(l: AllyLeaderLine): AllyBind {
    const prev = this.binds.get(l.petKey)
    const same = prev?.charmerKey === l.ownerKey
    const kind = this.classify(l)
    // A leader say names no spell, so a charm-class one gets the default charm duration — the
    // 16-minute figure every charm but two is listed at. A summon-class one gets no clock.
    const windowMs =
      kind === 'summon'
        ? Number.POSITIVE_INFINITY
        : DEFAULT_CHARM_DURATION_MS + DURATION_SLACK_MS
    const bind: AllyBind = {
      nameKey: l.petKey,
      display: l.pet,
      charmerKey: l.ownerKey,
      charmer: l.owner,
      boundTs: same && prev ? prev.boundTs : l.ts,
      windowMs,
      holdUntil: l.ts + windowMs,
      ambiguous: same && prev ? prev.ambiguous : false,
      via: 'leader',
      kind
    }
    this.binds.set(l.petKey, bind)
    this.friendlies.add(l.ownerKey)
    return bind
  }

  /**
   * WHAT KIND OF CREATURE A LEADER SAY IS ABOUT — the three-rung answer, strongest first. The
   * header section carries the whole argument; this is it in four lines.
   *
   *   1. CHARM EVIDENCE FOR THIS PET   a broadcast has named it. Keyed by the PET, so it wins.
   *   2. SUMMON EVIDENCE FOR THIS OWNER   they were seen casting a pet summon, at or before this
   *      say. Keyed by the PERSON, so it only ever gets asked when rung 1 is silent. A cast
   *      AFTER the say cannot explain a pet that is already talking, hence the `<=`.
   *   3. NEITHER ⇒ `'charm'`, the safer default: keeping a break rule that should not apply
   *      loses some of a pet's damage; dropping one that should have applied can credit a
   *      re-hostile mob to a player, and the owner ruled the second worse than the first.
   */
  private classify(l: AllyLeaderLine): 'charm' | 'summon' {
    if (l.everCharmed) return 'charm'
    const summonedAt = this.summons.get(l.ownerKey)
    return summonedAt !== undefined && summonedAt <= l.ts ? 'summon' : 'charm'
  }

  /** The live bind for a name, or undefined. */
  bindOf(nameKey: string): AllyBind | undefined {
    return this.binds.get(nameKey)
  }

  /**
   * THE BOUND NAME JUST ACTED — slide its hold (JOS-270). The whole of the sliding-window ruling
   * in three lines: a pet that is still swinging has not stopped being a pet, whatever a spell
   * database says its charm was listed at.
   *
   * IT SLIDES ON APPEARANCE, NOT ON CREDIT, and the difference is the AMBIGUOUS bind. A twin has
   * made the name unreadable, so the model books nothing from it — but the name is demonstrably
   * still acting (that is *why* it is unreadable), and reaping it for silence would be false. So
   * the caller offers every line the bound name attacks on, credited or not, and the ambiguity
   * semantics are untouched: `creditable` still refuses, and this still says "it is alive".
   *
   * A summon-class bind's `windowMs` is `Infinity`, so this is a no-op arithmetic identity for
   * it rather than a case to branch on.
   */
  noteActivity(nameKey: string, ts: number): void {
    const b = this.binds.get(nameKey)
    if (!b) return
    const next = ts + b.windowMs
    if (next > b.holdUntil) b.holdUntil = next
  }

  /** The bind a line may be CREDITED to: live and unambiguous. */
  creditable(nameKey: string): AllyBind | undefined {
    const b = this.binds.get(nameKey)
    return b && !b.ambiguous ? b : undefined
  }

  /** True when `nameKey` is on the friendly side of an ally charm — a caster we have seen, or a
   *  charmer we have bound for. Never an attribution test; see `friendlies`. */
  isFriendly(nameKey: string): boolean {
    return this.friendlies.has(nameKey)
  }

  /** True while any bind is live (lets the caller skip the per-line work entirely). */
  get idle(): boolean {
    return this.binds.size === 0
  }

  /** THE TWIN REFUSAL. Sticky — see `AllyBind.ambiguous`. */
  markAmbiguous(nameKey: string): boolean {
    const b = this.binds.get(nameKey)
    if (!b || b.ambiguous) return false
    b.ambiguous = true
    return true
  }

  /**
   * Drop a bind unconditionally — death, a zone, your own charm taking the same mob, a pet claim.
   * Every one of these ends BOTH kinds of bind: a dead pet is not a pet whoever owned it, and a
   * name that has become yours cannot also be somebody else's.
   *
   * THE SOFT-HOSTILE PROOF DOES NOT COME THROUGH HERE (JOS-270) — it is the one ending that
   * depends on which creature this is, so it has its own method below.
   */
  release(nameKey: string): AllyBind | undefined {
    const b = this.binds.get(nameKey)
    if (b) this.binds.delete(nameKey)
    return b
  }

  /**
   * THE SOFT-HOSTILE PROOF, APPLIED — the bound pet has swung at a friendly. Returns the bind it
   * ended, or `undefined` when the swing proves nothing.
   *
   * IT PROVES NOTHING ABOUT A `kind: 'summon'` BIND, and that is the whole of JOS-270's part B.
   * A charmed mob turning on its charmer's side is a charm ending; a summoned pet swinging at a
   * name that happens to be on the friendly list is a NAME COLLISION, which is exactly what
   * report 01KZVYMCAD72XFC36D73D8J2E8 printed (the ally's pet hit `a wan ghoul knight`, the name
   * of the reporter's own charm pet) and exactly what cost 29 percent of that pet's damage.
   *
   * IT READS `kind`, NEVER `via`: a charm pet answers `/pet who leader` too, and a leader bind
   * the evidence calls a charmed mob breaks here like any other.
   *
   * A separate method rather than a flag on `release` because the caller LOGS the ending, and a
   * caller that cannot tell "ended" from "nothing happened" would print a break that never was.
   */
  softHostile(nameKey: string): AllyBind | undefined {
    const b = this.binds.get(nameKey)
    if (!b || b.kind === 'summon') return undefined
    this.binds.delete(nameKey)
    return b
  }

  /**
   * Charm cannot survive a zone, and neither can an arm. The friendly set is kept: it is about
   * PEOPLE, and a person does not stop being one because you walked through a door.
   *
   * THE BIND GOES EITHER WAY, summon or charm (the owner's ruling names a zone as one of the
   * three ends a summoned pet has). What survives is the SUMMON SIGHTING — the pet really did
   * walk through with its owner, so if it speaks again on the other side the evidence is still
   * there to read. Re-binding it costs one line the ally has to print.
   */
  zone(): void {
    this.arms.clear()
    this.binds.clear()
  }

  /**
   * Binds whose pet has GONE SILENT for a whole window as of `now`. Removing them is this call's
   * side effect.
   *
   * Since JOS-270 this is a vanished-pet reaper rather than a spell-duration clock: `holdUntil`
   * slides forward on every line the name acts on (`noteActivity`), so a charm that an AA or a
   * focus effect has stretched past its listed figure keeps its row for as long as its pet keeps
   * swinging. A `kind: 'summon'` bind's `holdUntil` is `Infinity` and is never in the answer.
   */
  sweep(now: number): AllyExpiry[] {
    const out: AllyExpiry[] = []
    for (const [nameKey, b] of this.binds) {
      if (b.holdUntil > now) continue
      out.push({ nameKey, display: b.display, charmer: b.charmer })
    }
    for (const e of out) this.binds.delete(e.nameKey)
    return out
  }

  /** Display names of the live ally pets, newest last — for the debug surface and the tests. */
  boundNames(): string[] {
    return [...this.binds.values()].map((b) => b.display)
  }

  private pruneArms(now: number): void {
    for (const [k, a] of this.arms) if (a.until < now) this.arms.delete(k)
  }
}

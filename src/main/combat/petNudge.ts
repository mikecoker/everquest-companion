// THE NUDGE FOR A PET THE METER CANNOT SEE (JOS-258).
//
// THE REPORT (01KZV95MT7TRYTPSGS5EXFGNK3, 0.23.0): a player swapped Monk/Shaman/Enchanter for
// Monk/Shaman/Magician and their pet's damage vanished from the meter. The characterization found
// no regression to fix — the combat engine has no class gating and receives no loadout signal at
// all. It is JOS-49's ACCEPTED blind spot arriving in the wild: a charmed pet binds off its own
// broadcast, but a SUMMONED pet binds only when the player does something (order it once, ask
// `/pet who leader`, or land a pet-only buff on it — the three routes in petClaims.ts), and a
// never-ordered auto-assisting pet matches none of them, so its damage is dropped at routing.ts.
//
// THE OWNER'S RULING (2026-08-12) was to build the ~30-line honest stopgap rather than reopen
// JOS-49 — auto-adopting the first unknown attacker after a summon is EXACTLY the detector that
// ruling cut — and the ruling is a shape as much as a feature. Verbatim: a simple nudge, not overly
// wordy; rendered in the overlay on the content background of the METER; it appears only for a time
// after summoning and then TIMES OUT. Staleness or repetition is wrong: no persistent banner, no
// re-showing for the same pet, no nagging.
//
// SO THE WHOLE MODULE IS A TIMEOUT, and every constant below exists to keep one of those promises:
//
//   GRACE   a bind that arrives promptly must never draw a nudge at all. The commonest magician
//           and necromancer sequence is summon → buff the pet → bound, and the p2 fixture measures
//           it at SIX SECONDS (`Kintaz's Animation` 12:44:45, `Gonekn told you …` 12:44:51). A
//           nudge drawn at the cast and yanked six seconds later is a flicker that teaches nobody
//           anything, so nothing is drawn until the grace has passed unanswered.
//   SHOW    how long it then stays up. Tens of seconds, by the ruling.
//   QUIET   what stops it nagging. Once a nudge has been shown and TIMED OUT unheeded, the player
//           has read it and chosen not to act; another summon does not get to say it again for a
//           good while. A nudge that ended because the pet BOUND is not covered by this — that one
//           worked, and a genuinely new unbound pet later is a new question.
//
// ONE SLOT, which is what makes it once-per-summon-BURST rather than once-per-line: while an arm is
// live, further summon casts change nothing (chain-summoning cannot stack nudges), and the arm is
// cleared by a bind, by the timeout, or by the summon cast failing to resolve.
//
// PURE + CLOCK-INJECTED, the charmModel.ts rule: no Date.now(), no engine state, no I/O. Every
// method takes the timestamp it is reasoning at, so the ONLY thing that decides whether a nudge is
// on screen is arithmetic over two numbers.

import spellsJson from '../data/spells.json'
import { applySpellCorrections } from '../data/spellCorrections'
import { petSummonRoster } from '../data/spellEffectClass'
import { spellCanonKey } from '../log/parseCommon'
import type { PetSummonNudge } from '../../shared/combat'
import type { SpellDbFile } from '../../shared/types'

/**
 * How long a summon has to produce a bind before the player is told anything. See the header: the
 * measured fast path binds in six seconds, and a nudge that argues with it is noise.
 */
export const NUDGE_GRACE_MS = 10_000

/** How long the nudge is then on screen. The ruling's "for a time … and then TIMES OUT". */
export const NUDGE_SHOW_MS = 45_000

/**
 * How long after a nudge has been shown and IGNORED before another summon may raise one.
 *
 * This is the anti-nagging clause and nothing else. A player who chain-summons without ever
 * ordering the pet has already read the sentence; repeating it every time is the "repetition is
 * wrong" half of the ruling. Five minutes is long enough that the next nudge is about a new
 * session's worth of play rather than the same decision.
 */
export const NUDGE_QUIET_MS = 300_000

/**
 * THE SPELLS THAT SUMMON YOU A PET, derived from the wiki's own effect lines (JOS-251's overlay,
 * `petSummonRoster`) rather than from a name list or the `spellType` column — 104 rows say
 * `Summon Pet:` in so many words against 83 the type column files under Pet, and the 18 in the gap
 * are the magician's Vocarates among others.
 *
 * BOTH SPELLINGS OF EVERY NAME, for the reason charmModel.ts learned the hard way: this set is
 * keyed by name and the parser only ever sees the LOG's spelling, which the corrections overlay
 * exists because it sometimes is not the committed file's (AGENTS.md — a name is a join key).
 */
export const PET_SUMMON_SPELLS: ReadonlySet<string> = (() => {
  const raw = (spellsJson as SpellDbFile).spells
  const keys = petSummonRoster(raw)
  for (const k of petSummonRoster(applySpellCorrections(raw).spells)) keys.add(k)
  return keys
})()

/** Is `spell` — as the log spelled it, rank tail and all — one that summons a pet? */
export function isPetSummonSpell(spell: string): boolean {
  return PET_SUMMON_SPELLS.has(spellCanonKey(spell))
}

/**
 * The one-slot state machine. It knows two facts: the timestamp of the summon cast currently
 * awaiting a bind, and the timestamp at which a SHOWN nudge last timed out unheeded.
 */
export class PetNudgeState {
  /** The summon cast waiting on a bind, or null when nothing is armed. */
  private armedTs: number | null = null
  /** When a nudge last came off the screen having been ignored. 0 = never. */
  private lastIgnoredTs = 0

  reset(): void {
    this.armedTs = null
    this.lastIgnoredTs = 0
  }

  /**
   * `You begin casting <a pet summon>.` — the line only the player prints.
   *
   * Refuses in two cases, which together are the whole of "once per summon burst, no nagging":
   * something is already armed (a chain of summons is one question), or a nudge was shown and
   * ignored inside NUDGE_QUIET_MS.
   */
  noteSummonCast(ts: number): void {
    if (this.armedTs !== null) return
    if (this.lastIgnoredTs > 0 && ts - this.lastIgnoredTs < NUDGE_QUIET_MS) return
    this.armedTs = ts
  }

  /**
   * The summon cast never resolved (fizzle / interrupt), so there is no pet to talk about.
   *
   * The same argument charmModel.ts makes about an armed charm, and it errs toward SILENCE: an
   * interrupted summon that the player then RESUMES loses its nudge, because `castResumed` names no
   * spell and re-deriving one would be a guess. A missed hint is the cheap direction; a nudge about
   * a pet that was never summoned is exactly the staleness the ruling forbids.
   */
  noteCastFailed(): void {
    this.armedTs = null
  }

  /**
   * A pet bound (any of the three petClaims.ts routes). The nudge's whole question is answered, so
   * it dismisses EARLY and — deliberately — does not count as ignored: a player who acted on it is
   * not the player NUDGE_QUIET_MS exists to protect.
   */
  noteBound(): void {
    this.armedTs = null
  }

  /**
   * Retire an arm whose window has fully elapsed. Driven from the event stream AND from
   * `snapshot(now)`, whichever observes the deadline first — the sweepCharm pattern, for the same
   * reason: the log can go quiet for minutes and a screen must not.
   *
   * Only an arm that was actually SHOWN records an ignored nudge. An arm cannot expire unshown
   * (GRACE < GRACE + SHOW), but saying it in the code keeps the quiet period tied to what the
   * player saw rather than to what the engine armed.
   */
  sweep(now: number): void {
    if (this.armedTs === null) return
    const elapsed = now - this.armedTs
    if (elapsed < NUDGE_GRACE_MS + NUDGE_SHOW_MS) return
    if (elapsed >= NUDGE_GRACE_MS) this.lastIgnoredTs = this.armedTs + NUDGE_GRACE_MS + NUDGE_SHOW_MS
    this.armedTs = null
  }

  /**
   * What the snapshot carries: the nudge, or nothing at all.
   *
   * `undefined` is the answer in every state but one — nothing armed, still inside the grace, or
   * past the timeout — which is what makes "no persistent banner" structural rather than a promise
   * the renderer has to keep.
   */
  view(now: number): PetSummonNudge | undefined {
    if (this.armedTs === null) return undefined
    const elapsed = now - this.armedTs
    if (elapsed < NUDGE_GRACE_MS || elapsed >= NUDGE_GRACE_MS + NUDGE_SHOW_MS) return undefined
    return { summonedTs: this.armedTs, expiresTs: this.armedTs + NUDGE_GRACE_MS + NUDGE_SHOW_MS }
  }
}

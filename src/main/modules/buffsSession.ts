// The buffs model's SESSION FRAME (see buffs.ts for the model this belongs to): the last instant
// the character was seen in the log, and the LOG-HOLE state machine built on it.
//
// It is the fourth collaborator beside buffsInstances / buffsStats / buffsEntities, and it holds
// exactly one question: a break in the event stream arrived — did the character LEAVE, or did we
// lose the thread? The two answers are not close together. A logout freezes every buff with the
// character and hands it back at login (BuffInstances.onOfflinePause has the measurement); a lost
// thread means whatever we believed was standing is stale and belongs in the bin.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT WAITS (JOS-134). A hole of SESSION_GAP_MS or more used to be read as a logout on the
// spot and every live instance was cleared. The trouble is one of ORDER: the hole is always
// observed before the thing that explains it. Every login prints a reconnect preamble first —
// 0-22 s of channel/adventure lines over all 19 logins in the real log (sessionDetector.ts) — so
// the first post-absence event tripped the hole, the wipe ran, and the derived `offlineGap` that
// measured the absence arrived moments later to pause a model with nothing left in it. The buff
// EQ had frozen with your character read as expired the instant you logged back in, which is the
// user-visible defect the ticket names.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT WAITS FOR IS NOW EVIDENCE, NOT A CLOCK (JOS-262, owner ruling 2026-08-12). The wait
// used to be LOGIN_CONFIRM_MS of event time, borrowed from the detector's reconnect window; when
// that window elapsed with no login the hole was ruled UNEXPLAINED and the pre-hole buffs were
// dropped. Both halves of that were measured wrong:
//
//   • THE TIMER RULED ON A HOLE THE LOG HAD NOT FINISHED EXPLAINING. Start the app while the
//     game is still loading and the replay ends inside an open hole; the 1 s heartbeat then runs
//     the window out against WALL time and wipes the previous session's buffs a few seconds
//     before the `Welcome` that would have paused them. That is the reported defect, exactly.
//   • THE FIRST EVENT AFTER A HOLE IS NOT EVIDENCE OF ANYTHING. A preamble line, or another
//     player's kill arriving while your character is still being placed (measured — see
//     sessionDetector.ts), says the client is connected and nothing at all about you.
//
// So the ruling is now: a hole is UNEXPLAINED only when {@link inWorldEvidence} — a line that
// could only have been printed for THIS character — arrives with no login in between. One
// predicate, shared with the detector, so the two can never disagree about what "in the world"
// means. Until then the question stays open and the pre-hole rows are HELD: a held row that
// turns out to be a logout is about to have its clock rewound; a held row on a log that simply
// went quiet is the honest picture of a character whose buffs EQ has frozen.
//
//   • `closeHole()` — a login explained it. The gap handler pauses the buffs by the absence the
//     detector measured, and nothing here has an opinion about that number. One authority beats
//     two constants that agree until they don't.
//   • in-world evidence with no login — UNEXPLAINED. `observe` hands back the last-known-online
//     instant so the caller can drop what predates it, exactly as the old blanket clear did.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND THE HOLD IS WIDER THAN THE HOLE (JOS-262). Two thresholds live here now, because the two
// questions are different sizes:
//
//   the HOLD (OFFLINE_GAP_MIN_MS, 60 s) — every absence the detector can report a pause for.
//     `heldBeforeTs` exempts the pre-absence rows from the hygiene sweep for its duration.
//   the HOLE (SESSION_GAP_MS, 30 min) — an absence long enough that, unexplained, it means we
//     lost the thread. Only a hole ever DROPS anything.
//
// The hold used to start at the hole, which left the whole 1-30 minute band unprotected: a 20-
// minute relog reaches `sweepHygiene` at the `Welcome` with no hold in place, and the derived
// gap that would have rewound the clocks is drained one event LATER — so a pet or ally row past
// its 60 s unwitnessed grace was culled a beat before the pause could save it (JOS-149's cull
// racing JOS-134's pause). The row the user loses is the one the pause exists for.

import type { LogEvent } from '../../shared/logEvents'
import { inWorldEvidence, OFFLINE_GAP_MIN_MS } from '../log/sessionDetector'
import { SESSION_GAP_MS } from './buffsShapes'

export class SessionFrame {
  /** ts of the newest primary event folded so far (0 before the first). */
  private lastEventTs = 0
  /** Last instant seen before an OPEN absence, or 0 when there is none. */
  private fromTs = 0
  /** True when the open absence is past the log-HOLE boundary, so ruling it drops rows. */
  private isHole = false
  /** True once a login turned up for the open absence: the pause is on its way. */
  private explained = false

  reset(): void {
    this.lastEventTs = 0
    this.closeHole()
  }

  /**
   * The last-known-online instant of an OPEN absence, or 0. A BUFF older than this is exempt
   * from the hygiene sweep for as long as the absence is unresolved: if it turns out to be a
   * logout, that buff's clock is about to be rewound by the absence, and judging it against a
   * `now` from the far side would retire — a beat before the pause lands — the very buff the
   * pause protects.
   */
  get heldBeforeTs(): number {
    return this.fromTs
  }

  /** A login (or a character rebirth) settled the question: close the hole with no casualties. */
  closeHole(): void {
    this.fromTs = 0
    this.isHole = false
    this.explained = false
  }

  /**
   * Fold one primary event. Returns the last-known-online instant of a hole that has JUST been
   * ruled unexplained — the caller drops what predates it — or null.
   */
  observe(ev: LogEvent): number | null {
    // OPEN FIRST, THEN RULE, and the order is load-bearing in both directions. A hole is always
    // revealed BY the event on its far side, so the same event has to be able to open it and
    // answer it: a login on the far side of a 13-hour camp explains the hole it just opened, and
    // a `You gain experience!` on the far side of one is a character who was in the world with
    // no login line — we lost the thread, and that is the ruling.
    this.openAbsence(ev)
    const ruling = this.rule(ev)
    this.lastEventTs = ev.ts
    return ruling
  }

  /**
   * Rule on the OPEN absence, if this event says anything about it. Three answers:
   * a login EXPLAINS it (and the hold stays up until the gap that follows closes it, or the
   * sweep on this very event would judge the rows the pause is about to rewind); in-world
   * evidence with no login RULES it — dropping what predates a hole, and merely releasing the
   * hold for a shorter absence, which was a lull in play rather than a lost thread; anything
   * else leaves the question open.
   */
  private rule(ev: LogEvent): number | null {
    if (this.fromTs === 0) return null
    if (ev.kind === 'sessionStart') {
      this.explained = true
      return null
    }
    if (!inWorldEvidence(ev)) return null
    const from = this.fromTs
    const unexplainedHole = this.isHole && !this.explained
    this.closeHole()
    return unexplainedHole ? from : null
  }

  /** Open an absence when this event follows a quiet stretch worth pausing for. */
  private openAbsence(ev: LogEvent): void {
    if (this.lastEventTs <= 0) return
    const quietMs = ev.ts - this.lastEventTs
    if (quietMs < OFFLINE_GAP_MIN_MS) return
    // A second quiet stretch before the first was resolved is the SAME unresolved absence: keep
    // the oldest known-online instant (it is what the pre-absence rows are held against) and let
    // either stretch make it a hole.
    if (this.fromTs === 0) this.fromTs = this.lastEventTs
    if (quietMs >= SESSION_GAP_MS) this.isHole = true
  }
}

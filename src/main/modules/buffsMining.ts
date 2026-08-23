// ============================================================================
// buffsMining.ts — FEEDING THE OBSERVED-MESSAGE OVERLAY (Task #36; lifted out for JOS-208).
// ============================================================================
//
// The buffs model's fifth collaborator, and the last one still living inside `buffs.ts`: which
// log lines are offered to the `MessageOverlayMiner`, and the cache that stops the served overlay
// from being rebuilt on every snapshot. Lifted here VERBATIM (the same events, the same order,
// the same dirty rule) when the checkpoint seam pushed `buffs.ts` past the repo's 400-code-line
// ceiling — the house answer to that being a split, never a widened threshold. It is also the
// natural home: everything about "how the overlay learns" is now in one file with the miner it
// learns into, beside `buffsStats` / `buffsEntities` / `buffsInstances` / `buffsSession`.
//
// IT MINES THE SAME WAY IN REPLAY AND LIVE, which is what makes the overlay a fold rather than a
// session artifact — and therefore what makes it checkpointable at all.

import type { MessageOverlay } from '../../shared/types'
import type { SpellDb } from '../data/spellDb'
import { MessageOverlayMiner, type OverlayRegister, type OverlaySeed } from '../data/messageOverlay'
import type { LogEvent } from '../../shared/logEvents'
import { looksLandingMessage } from './buffsShapes'

/** Strip the `[timestamp] ` prefix from a raw line → the bare message text (for the overlay). */
function messageTextOf(raw: string): string {
  const i = raw.indexOf('] ')
  return i >= 0 ? raw.slice(i + 2) : raw
}

export class OverlayMining {
  private readonly miner: MessageOverlayMiner
  /** The built overlay, rebuilt only when the miner has observed something new. */
  private cache: MessageOverlay | null = null
  private dirty = true

  /**
   * Seeded warm with the committed baseline + the user's persisted buckets, so a fresh install
   * benefits from the shipped baseline and a returning user keeps everything their own logs have
   * taught (Task #36). EACH SEED CARRIES ITS SOURCE KEY (JOS-231): the bucket a log is filed
   * under is what lets `beginSource` replace it when that log is folded again, instead of the
   * fold accumulating on top of its own previous output.
   */
  constructor(db?: SpellDb, seeds?: readonly OverlaySeed[]) {
    this.miner = new MessageOverlayMiner(db?.byKey)
    for (const s of seeds ?? []) this.miner.merge(s.counts, s.key)
  }

  /**
   * A log is about to be folded from its first byte — file what it teaches under `key` and drop
   * whatever that key held (JOS-231). Called once per character attach, before the scan.
   */
  beginSource(key: string): void {
    this.miner.beginSource(key)
    this.dirty = true
  }

  /** The per-source register — what persistence writes and re-seeds the next launch from. */
  register(): OverlayRegister {
    return this.miner.register()
  }

  /**
   * Offer one event to the miner. A `castBegin` is the association ANCHOR; the message-bearing
   * events (buffApply / spellEmote = landing, buffWearOff / illusionFade / buffFade = wears-off)
   * are candidate messages associated to the nearest anchor within the window.
   */
  observe(ev: LogEvent): void {
    switch (ev.kind) {
      case 'castBegin':
        this.miner.observeCast(ev.spell, ev.ts)
        break
      case 'buffApply':
      case 'spellEmote':
        this.note(messageTextOf(ev.raw), ev.ts, 'landing')
        break
      case 'buffWearOff':
      case 'illusionFade':
      case 'buffFade':
        this.note(messageTextOf(ev.raw), ev.ts, 'wearsOff')
        break
      // The AA potion quaff is a LANDING message that the leveling analytics now claim as their
      // own kind. It fell through here as `unknown` before that rule existed and the overlay
      // learned it as a verified Bottle of Alternate Adventure landing (it is absent from
      // spells.json, so the DB table never had it) — so it keeps the same miner path, and the
      // learned overlay is byte-identical to what it was.
      case 'aaPotion':
      case 'unknown': {
        // A line the parser classified as NOTHING but that could be an un-catalogued landing
        // message (e.g. Symbol of Pinzarn's real "The symbol of Pinzarn flashes before your
        // eyes." — the wiki's msg_cast_on_you is WRONG, so the DB table never matched it). Feed
        // only flavor-SHAPED lines; the unambiguous-anchor + count rules in the miner discard
        // coincidental pairings, so a wrong candidate never verifies.
        const t = messageTextOf(ev.raw)
        if (looksLandingMessage(t)) this.note(t, ev.ts, 'landing')
        break
      }
    }
  }

  private note(text: string, ts: number, role: 'landing' | 'wearsOff'): void {
    this.miner.observeMessage(text, ts, role)
    this.dirty = true
  }

  /** The served/persisted overlay, rebuilt only when something was observed since the last one. */
  build(): MessageOverlay {
    if (this.dirty || this.cache === null) {
      this.cache = this.miner.build()
      this.dirty = false
    }
    return this.cache
  }
}

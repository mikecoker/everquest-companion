// alertsFields.ts — READING ONE FIELD OF AN ARBITRARY LogEvent, which is what an alert `where`
// matcher does and what a spoken alert needs to name the spell that set it off.
//
// Split out of modules/alerts.ts unchanged (JOS-235, purely to keep that file under its factoring
// ceiling): these are the file's PURE half — no compiled defs, no module state, no cooldowns —
// and they are the half two other readers want. `fieldText` and `spellCandidateNames` are the
// matcher's; `SPELL_FIELD_BY_KIND` and `firingSpell` are the firing payload's. Every line of the
// argument for each of them travelled with it; nothing about what they compute changed.
//
// `withAutoCaptures` (JOS-353) joined them for the same reason and by the same cut: it turns one
// matched LogEvent into one field of the firing payload, exactly like `firingSpell`, and adding it
// to alerts.ts put that file three lines past the same ceiling.

import { MAX_CAPTURE_GROUPS } from '../../shared/alertCaptures'
import { resolveTarget, type AutoTokenName } from '../../shared/alertTargets'
import type { LogEvent } from '../../shared/logEvents'

/**
 * Stringify ONE event field for matching. A `where` key names an arbitrary field of an
 * arbitrary LogEvent, so the value is nearly always a string/number/boolean — but a few fields
 * hold arrays (`damage.modifiers`, the buff-landing `candidates` lists, one of which is an
 * array of OBJECTS).
 *
 * This reproduces JS's own `String()` coercion rather than improving on it, because the coerced
 * text is exactly what every existing alert def is matched against: an array joins its elements
 * with ',' (a nullish element contributing ''), and an object element renders as the literal
 * '[object Object]'. That last one IS what a def matching on the object-shaped `candidates` list
 * sees today — making it nicer would silently change which alerts fire. The final fallback also
 * absorbs bigint/symbol/function, which no LogEvent field holds.
 */
export function fieldText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return '' // only reachable as an array ELEMENT — join() renders nullish as ''
  if (Array.isArray(value)) return (value as unknown[]).map(fieldText).join(',')
  return '[object Object]'
}

/**
 * THE SPELL NAMES ONE EVENT CAN HONESTLY ANSWER TO (JOS-84) — `ev.spell` plus every name in the
 * event's `candidates` list, or an empty array when the event carries no candidates.
 *
 * WHY THIS EXISTS. `buffApply.spell` / `buffWearOff.spell` are documented as a BEST-EFFORT PICK:
 * EQ's landing and wears-off sentences are shared across a whole spell family (`<mob> slows
 * down.` is Forlorn Deeds / Languid Pace / Rejuvenation / Shiftless Deeds / Tepid Deeds; `<mob>
 * looks frail.` is Disempower / Incapacitate / Listless Power), so the parser cannot name the
 * spell from the line and puts the FIRST DB candidate in `spell` while `candidates` carries the
 * truth. The suggestion wizard authored `where:{spell:'<your spell>'}` against that first pick,
 * which is a coin flip the user always loses: an enchanter's Shiftless Deeds alert was compared
 * to the string "Forlorn Deeds" and could never fire. MEASURED against the reporter's own log
 * lines — that is the whole of JOS-84.
 *
 * So a `where.spell` matcher tests the WHOLE SET. It is the same reading shared/alertGroups.ts
 * already argues for the on-you slow ("both sentences are shared by a whole slow family and name
 * no spell, so this alert reports that a slow expired, never which one"), applied to the mob side
 * as well: when the game prints one sentence for five spells, an alert on any one of them is an
 * alert on the family, and firing is the honest answer. The alternative — silence — is the bug.
 *
 * SCOPE. Only the `spell` key widens, and only when the event actually carries `candidates`.
 * `where:{candidates:…}` is untouched (it still sees `fieldText`'s '[object Object]' join, which
 * is what today's defs are matched against), families with no candidate list (castBegin, resist,
 * buffFade, the derived buffExpired) are byte-for-byte unchanged, and an event that carries
 * candidates but no `spell` field at all (poisonProc names its `strike`) still fails the
 * pre-existing "field is absent ⇒ no match" test before this is ever consulted.
 */
export function spellCandidateNames(ev: LogEvent): string[] {
  const cands = (ev as unknown as Record<string, unknown>).candidates
  if (!Array.isArray(cands)) return []
  const out: string[] = []
  for (const c of cands as unknown[]) {
    if (typeof c === 'string') out.push(c)
    else if (typeof c === 'object' && c !== null) {
      const name = (c as { name?: unknown }).name
      if (typeof name === 'string') out.push(name)
    }
  }
  return out
}

// ---- spell context on the firing payload (docs/plans/voice-alerts.md §1) ----
//
// A spoken alert can say the spell that set it off ("Mesmerization", "Swift"), which means the
// FIRING has to carry it: the renderer receives `FiredAlert`, and before this it carried only
// the alert id, the timestamp and the matched raw line. Re-deriving the spell renderer-side
// would mean a second parser for lines main has already parsed.
//
// WHICH FIELD NAMES THE SPELL, PER KIND — measured against shared/logEvents.ts, not assumed.
// Most of the families spell it `spell`; three do not, and the exceptions are the whole reason
// this is a table instead of a property read:
//   * poisonProc  → `strike`  (the Strike's own name; a proc has no cast line at all)
//   * poisonCoat  → `poison`  (and it is the literal string 'unknown' for the generic
//                              third-person coat line, which is filtered below — 'unknown' is
//                              a stated absence, not a spell name)
//   * damage      → `skill`, but ONLY for dtype 'spell' | 'dot' (verified in log/parseCombat.ts:
//                   the typed-nuke and DoT shapes put the spell name there). For 'melee' it is
//                   a melee skill and for 'ds' it is the damage-shield element — neither is a
//                   spell, so neither is claimed. Handled separately, below.
//                   THE MATCHER NOW DRAWS THE SAME LINE (JOS-276): `foldReaches` in
//                   modules/alerts.ts gates the rank fold on this exact dtype pair, so "which
//                   damage lines name a spell" has one answer and two readers, not two answers.
//
// FAMILIES THAT CARRY NO SPELL, and therefore fall back to the alert's name when a spell speech
// mode fires on them: zone, loot, offer, trade, level, expGain, aaGain, aaSpend, aaActivate (an
// AA name is not a spell), death, playerDeath, mitigation, miss, charm, uncharm, petClaim,
// spellEmote (the emote text names no spell — that ambiguity is the point of the family),
// illusionFade (27-way ambiguous by design), poisonDry, stanceChange, invocationChange, selfWho,
// skillUp, itemActivate, itemMerge, itemMergeFailed, consider, epoch, sessionStart, campStart,
// campAbort, offlineGap, unknown — plus EVERY 'raw' trigger that matched a spell-less line and
// every renderer-evaluated 'app' signal (bossDefeat / questComplete, which arrive via appFired
// and never see a LogEvent at all).
//
// `cc` and `heal` declare `spell?` — present on some shapes only (a CC application names no
// spell; its worn-off keep-alive does). An absent field is simply an absent spell.

/** Event kind → the field on that event whose value is the triggering spell's DISPLAY name. */
const SPELL_FIELD_BY_KIND: Partial<Record<LogEvent['kind'], string>> = {
  castBegin: 'spell',
  castFizzle: 'spell',
  castInterrupted: 'spell',
  resist: 'spell',
  cc: 'spell',
  heal: 'spell',
  buffApply: 'spell',
  buffFade: 'spell',
  buffWearOff: 'spell',
  buffExpired: 'spell',
  poisonProc: 'strike',
  poisonCoat: 'poison'
}

/**
 * The spell that set this event off, DISPLAY form with the rank suffix INTACT — or undefined
 * when the family names none. Rank-stripping belongs to the speech resolver
 * (shared/speechText.ts), never to the producer: a consumer that wants "Mesmerization III"
 * must still be able to see the III.
 *
 * The one dynamic read mirrors `conditionMatches`'s own field access (the `where` matcher has
 * always indexed events by an arbitrary key), so this introduces no new escape hatch.
 */
export function firingSpell(ev: LogEvent): string | undefined {
  if (ev.kind === 'damage') {
    return ev.dtype === 'spell' || ev.dtype === 'dot' ? ev.skill.trim() || undefined : undefined
  }
  const field = SPELL_FIELD_BY_KIND[ev.kind]
  if (field === undefined) return undefined
  const value = (ev as unknown as Record<string, unknown>)[field]
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  // 'unknown' is what a poisonCoat says when the line deliberately hides which poison it was.
  return name && name !== 'unknown' ? name : undefined
}

// ---- the auto token on the firing payload (JOS-353) ----

/**
 * The captures a firing carries: what the def's own pattern named, plus the auto tokens its phrase
 * asked for — and THE PATTERN ALWAYS WINS.
 *
 * A def that declared `(?<target>…)` is a def whose author said what they meant that word to be,
 * and control 4 of shared/alertCaptures.ts's threat model is that a declaration is readable off
 * the pattern. So the derived value fills a HOLE and never overwrites one; a user who wants the
 * parser's answer simply does not name a group `target`.
 *
 * MAX_CAPTURE_GROUPS still bounds the map. A pattern that already named eight things has spent the
 * budget, and the auto token renders literally rather than pushing the payload past the cap — the
 * same visible degradation `harvestCaptures` chose for the ninth named group.
 *
 * `autoTokens` is EMPTY for nearly every alert (modules/alerts.ts compiles it from the def's own
 * phrase), and this returns its argument untouched when it is — so a firing that asked for nothing
 * is not even reallocated, and the `module:delta` stays byte-identical to what it was before the
 * token existed.
 *
 * It lives here, beside `firingSpell`, because it is the same kind of thing: a PURE reader that
 * turns one matched LogEvent into one field of the firing payload. modules/alerts.ts holds the
 * compiled defs and the cooldowns; this file holds the readers.
 */
export function withAutoCaptures(
  captures: Record<string, string> | undefined,
  autoTokens: readonly AutoTokenName[],
  ev: LogEvent
): Record<string, string> | undefined {
  if (autoTokens.length === 0) return captures
  let out = captures
  for (const name of autoTokens) {
    if (out && (name in out || Object.keys(out).length >= MAX_CAPTURE_GROUPS)) continue
    const value = name === 'target' ? resolveTarget(ev) : null
    if (value === null) continue
    out = { ...(out ?? {}), [name]: value }
  }
  return out
}

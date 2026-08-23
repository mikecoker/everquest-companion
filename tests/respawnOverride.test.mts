// OVERRULING THE NUMBER (JOS-194, prototype round 9) — the parser, the state, and the way back.
//
// Its own file for the reason tests/respawnWorking.test.mts and tests/respawnSeen.test.mts are:
// tests/respawnTimers.test.mts is at the repo's factoring ceiling and this is a self-contained
// ruling rather than more cases of the ladder already pinned there.
//
// THE RULING. Round 7's bare seconds box is superseded by an edit ICON on the duration and a MODAL
// behind it. Most of that is renderer work the e2e drives; what is PURE, and therefore what belongs
// here, is:
//
//   * `parseRespawnDuration` — the one parser, "plain seconds by default plus shorthand like 44m or
//     44m 30s". The owner asked for it to be unit-tested thoroughly INCLUDING JUNK INPUT, so the
//     junk half below is deliberately longer than the happy half: a grammar is defined as much by
//     what it refuses as by what it reads, and a half-read duration is a fabricated countdown
//     (world-model law 1, and `parseWikiRespawn`'s whole argument one file over).
//   * `formatRespawnDuration` — its inverse, which is what the modal's field opens with. Tested AS
//     an inverse: a player who opens the modal, changes nothing and presses Save must not thereby
//     change the clock.
//   * `respawnOverridden` — the state, one definition for the two surfaces that paint it.
//   * `respawnCalculated` — what the clear/revert control returns to, stated as a number before it
//     is pressed rather than promised.
//   * `respawnDurationText` — the duration as both surfaces print it, `<=` included, now that the
//     tab has bolted it to the rung that produced it.
//   * The card's new lines (every measured gap, and the wiki default) and the row's new `wikiPage`,
//     which is what lets the modal LINK to the page it is quoting.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { RespawnModule } from '../src/main/modules/respawn'
import {
  RESPAWN_CUSTOM_MAX_SEC,
  RESPAWN_CUSTOM_MIN_SEC,
  RESPAWN_SHAPE_VERSION,
  formatRespawnDuration,
  parseRespawnDuration,
  respawnCalculated,
  respawnCardNote,
  respawnDurationText,
  respawnOverridden,
  respawnProvenance,
  respawnSourceLabel,
  respawnWikiDefaultLine,
  type RespawnPrefs,
  type RespawnRow,
  type RespawnSnap
} from '../src/shared/respawn'

/** A duration formatter with no dependency on the renderer's — `fmt` is injected everywhere. */
const fmt = (ms: number | null | undefined): string => (ms == null ? '-' : `${String(Math.round(ms / 1000))}s`)

/** A row with the fields these assertions need; each test overrides what it is about. */
function row(over: Partial<RespawnRow> = {}): RespawnRow {
  return {
    id: 'z::m',
    key: 'm',
    display: 'M',
    zone: 'Z',
    baseTs: 0,
    basis: 'death',
    source: 'none',
    samples: 0,
    kills: 1,
    ...over
  }
}

/** The parser's answer, flattened to something an assertion table can compare. */
function read(text: string): number | string {
  const p = parseRespawnDuration(text)
  return p.ok ? p.sec : p.reason
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PARSER — WHAT IT READS
// ─────────────────────────────────────────────────────────────────────────────

test('a bare number is SECONDS, which is what the retired box took and what the store holds', () => {
  assert.equal(read('90'), 90)
  assert.equal(read('  2640  '), 2640, 'the edges are trimmed, not refused')
  assert.equal(read('1'), RESPAWN_CUSTOM_MIN_SEC, 'the floor is a readable number, not an edge case')
  assert.equal(read('604800'), RESPAWN_CUSTOM_MAX_SEC)
  // The store holds WHOLE seconds, so a fractional entry rounds rather than being refused: somebody
  // typing 90.5 has said a duration, and half a second is not a fact about a spawn cycle.
  assert.equal(read('90.4'), 90)
  assert.equal(read('90.5'), 91)
})

test('the shorthand the owner asked for, and the rest of the same grammar', () => {
  assert.equal(read('44m'), 2640, 'the example in the ruling')
  assert.equal(read('44m 30s'), 2670, 'and the other one')
  assert.equal(read('1h 10m'), 4200, 'and the third')
  assert.equal(read('2d'), 172_800)
  assert.equal(read('1h10m30s'), 4230, 'the spaces are optional')
  assert.equal(read('1h, 10m'), 4200, 'a comma is a separator like whitespace')
  assert.equal(read('44 m'), 2640, 'so is the space between a number and its unit')
  assert.equal(read('1.5h'), 5400, 'a fractional term is a duration too')
})

test('the long spellings, because a player types words as often as letters', () => {
  assert.equal(read('44 min'), 2640)
  assert.equal(read('44 mins'), 2640)
  assert.equal(read('44 minutes'), 2640)
  assert.equal(read('1 hour'), 3600)
  assert.equal(read('2 hours 30 minutes'), 9000)
  assert.equal(read('90 sec'), 90)
  assert.equal(read('90 seconds'), 90)
  assert.equal(read('1 day'), 86_400)
  assert.equal(read('44M'), 2640, 'case is not a claim')
  assert.equal(read('1H 10M'), 4200)
})

// ─────────────────────────────────────────────────────────────────────────────
// THE PARSER — WHAT IT REFUSES, WHICH IS THE HALF THAT MATTERS
// ─────────────────────────────────────────────────────────────────────────────

test('an empty field is the REVERT, not an error', () => {
  // The distinction is load-bearing: the modal's Save is disabled on unreadable text, but an empty
  // box means "use the calculated value" and the clear control depends on it being its own answer.
  assert.equal(read(''), 'empty')
  assert.equal(read('   '), 'empty')
  assert.equal(read('\t\n'), 'empty')
})

test('junk is REFUSED rather than half-read - the whole string must be consumed', () => {
  for (const junk of [
    'abc',
    'm',
    's',
    '44x',
    '44 mo',
    '44m 30', // a bare number is the WHOLE field or nothing
    '44m x',
    'about 44m', // the wiki grammar forgives prose; a field the user types into does not
    'every 44m',
    '~44m',
    '44m?',
    '44m!',
    '1e3', // reads as a number to JS and is not a duration anybody typed
    '0x10',
    '1,5m', // a comma is a separator here, never a decimal point
    '44m 30s 12', // trailing residue
    '500ms', // reads as 500 minutes with an `s` the grammar cannot use, so it is refused
    'NaN',
    'Infinity',
    '-',
    '+',
    '.',
    '..',
    '1..5m'
  ]) {
    assert.equal(read(junk), 'unreadable', `"${junk}" must be refused, not guessed at`)
  }
})

test('a SIGNED number is not a duration', () => {
  // The term regex is unsigned by construction, so a sign never reaches the arithmetic — which is
  // what stops "-5" from becoming a negative estimate and a countdown that starts overdue.
  assert.equal(read('-5'), 'unreadable')
  assert.equal(read('-5m'), 'unreadable')
  assert.equal(read('+5m'), 'unreadable')
  assert.equal(read('1h -10m'), 'unreadable')
})

test('units must DESCEND, and may not repeat', () => {
  // A reordered or repeated unit means something the field cannot know — is `44m 44m` eighty-eight
  // minutes, or somebody's finger slipping? — so it refuses instead of picking.
  assert.equal(read('30s 44m'), 'unreadable')
  assert.equal(read('44m 44m'), 'unreadable')
  assert.equal(read('1m 1h'), 'unreadable')
  assert.equal(read('1s 1s'), 'unreadable')
  // …while the same terms in order are fine, which is the point of testing both.
  assert.equal(read('44m 30s'), 2670)
})

test('a COLON is refused on purpose, because this app cannot know which clock you meant', () => {
  // `1:30` is minutes:seconds on a wiki page (readClock, argued from the catalog's own camps) and
  // hours:minutes on a wall clock. Guessing would put a countdown out by a factor of sixty; `1h 30m`
  // and `1m 30s` each say it in one keystroke more.
  assert.equal(read('1:30'), 'unreadable')
  assert.equal(read('01:30:00'), 'unreadable')
  assert.equal(read('6:40'), 'unreadable')
})

test('a readable duration outside the range says SO, rather than reading as gibberish', () => {
  // The two failures are different facts and the modal says different things about them: one is
  // "I did not understand you", the other is "I understood and will not store that".
  assert.equal(read('0'), 'range')
  assert.equal(read('0s'), 'range')
  assert.equal(read('0.4'), 'range', 'rounds to zero, which is not a spawn cycle')
  assert.equal(read('8d'), 'range')
  assert.equal(read('604801'), 'range')
  assert.equal(read('7d 1s'), 'range', 'the bound is on the total, not on any one term')
  // …and the boundaries themselves are IN.
  assert.equal(read('7d'), RESPAWN_CUSTOM_MAX_SEC)
  assert.equal(read('1s'), RESPAWN_CUSTOM_MIN_SEC)
})

// ─────────────────────────────────────────────────────────────────────────────
// THE FORMATTER, TESTED AS THE PARSER'S INVERSE
// ─────────────────────────────────────────────────────────────────────────────

test('the field opens with the duration written the way the field accepts it', () => {
  assert.equal(formatRespawnDuration(570), '9m 30s')
  assert.equal(formatRespawnDuration(3600), '1h', 'zero terms are dropped, not printed')
  assert.equal(formatRespawnDuration(1), '1s')
  assert.equal(formatRespawnDuration(90), '1m 30s')
  assert.equal(formatRespawnDuration(90_061), '1d 1h 1m 1s')
  assert.equal(formatRespawnDuration(0), '0s', 'never the empty string, which reads as CLEARED')
})

test('opening the modal, changing nothing and saving cannot move the clock', () => {
  // The round-trip property, over the boundaries, the ruling's own examples, and a spread through
  // the range. If this ever fails, prefilling is unsafe and the modal has to open empty instead.
  for (const sec of [1, 59, 60, 61, 90, 570, 600, 2640, 2670, 4200, 3599, 3600, 86_399, 86_400, 604_800]) {
    const text = formatRespawnDuration(sec)
    const back = parseRespawnDuration(text)
    assert.ok(back.ok, `${String(sec)} formatted to "${text}", which the parser then refused`)
    assert.equal(back.sec, sec, `"${text}" round-tripped to ${String(back.sec)}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// THE OVERRIDDEN STATE, AND THE WAY BACK
// ─────────────────────────────────────────────────────────────────────────────

test('OVERRIDDEN is the ladder’s answer, never the presence of a stored number', () => {
  assert.equal(respawnOverridden(row({ source: 'custom', estimateMs: 90_000, customMs: 90_000 })), true)
  assert.equal(respawnOverridden(row({ source: 'wiki', estimateMs: 570_000 })), false)
  assert.equal(respawnOverridden(row({ source: 'observed', estimateMs: 300_000, samples: 2 })), false)
  assert.equal(respawnOverridden(row()), false)
  // The one that would go wrong if this read `customMs`: a stored number the ladder DECLINED must
  // not light up a row it is not numbering. (`resolveRespawn` refuses a non-positive custom.)
  assert.equal(respawnOverridden(row({ source: 'wiki', estimateMs: 570_000, customMs: 0 })), false)
})

test('the clear control knows the number it would go back to, before it is pressed', () => {
  const overridden = row({
    source: 'custom',
    estimateMs: 90_000,
    customMs: 90_000,
    observedMs: 300_000,
    samples: 2,
    wikiMs: 570_000,
    wikiText: '9.5 min'
  })
  const calc = respawnCalculated(overridden)
  // Rung 1 removed, the rest of the ladder run exactly as the module runs it — including the wiki
  // FLOOR, which here lifts a 5m bound to the wiki's 9m 30s.
  assert.equal(calc.source, 'observed')
  assert.equal(calc.estimateMs, 570_000)
  assert.equal(calc.customMs, undefined, 'the number being reverted is not carried into the answer')
  assert.equal(respawnSourceLabel(calc), 'your kills (2 gaps), floored by the wiki')
  assert.equal(respawnDurationText(calc, fmt), '<= 570s')

  // With nothing but the user's number behind it, reverting honestly leads nowhere — and says so.
  const bare = respawnCalculated(row({ source: 'custom', estimateMs: 90_000, customMs: 90_000 }))
  assert.equal(bare.source, 'none')
  assert.equal(bare.estimateMs, undefined)
  assert.equal(respawnDurationText(bare, fmt), 'no estimate')

  // On a row nobody overruled it is the row itself, which is the honest answer to "what would
  // clearing do" there: nothing.
  const plain = row({ source: 'wiki', estimateMs: 570_000, wikiMs: 570_000 })
  assert.deepEqual(respawnCalculated(plain), plain)
})

test('the duration prints its upper-bound sign on YOUR kills and nowhere else', () => {
  // The `<=` is the honesty of the whole feature in one character (a gap is a bound, not a
  // measurement), and it was spelled inline on two surfaces until round 9 bolted it to the rung.
  assert.equal(respawnDurationText(row({ source: 'observed', estimateMs: 300_000, samples: 1 }), fmt), '<= 300s')
  assert.equal(respawnDurationText(row({ source: 'wiki', estimateMs: 570_000 }), fmt), '570s')
  assert.equal(respawnDurationText(row({ source: 'custom', estimateMs: 90_000 }), fmt), '90s')
  assert.equal(respawnDurationText(row(), fmt), 'no estimate')
})

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE CARD GREW, AND WHAT THE ROW GREW TO FEED THE LINK
// ─────────────────────────────────────────────────────────────────────────────

test('the hover card shows every gap it measured and the wiki default, as LINES', () => {
  const r = row({
    source: 'observed',
    samples: 3,
    estimateMs: 240_000,
    observedMs: 240_000,
    gapsMs: [240_000, 480_000, 300_000],
    wikiText: '9.5 min',
    wikiMs: 570_000
  })
  const note = respawnCardNote(r, fmt)
  // The SENTENCE is unchanged and is still the one string both surfaces read — round 5's cap is on
  // it, and growing the card by growing that sentence is exactly what this must not do.
  assert.equal(note.text, respawnProvenance(r, fmt))
  assert.ok(note.text.length <= 200, note.text)
  // The gaps: ALL of what the row publishes, newest first, in the wording that says GAPS.
  assert.deepEqual(note.lines, ['gaps: 240s · 480s · 300s', 'wiki default: 570s ("9.5 min")'])
})

test('the card says nothing where a source said nothing', () => {
  // A row with no gaps and no wiki page has no lines at all, so the card renders the block and gets
  // the sentence and nothing else (law 1: never an empty list dressed up as an answer).
  assert.deepEqual(respawnCardNote(row({ source: 'none' }), fmt).lines, [])
})

test('a wiki that stated something OTHER than a duration is quoted, not dropped', () => {
  // 111 of the 522 pages that state a `|respawn_time` at all state "Triggered" / "?" / "Night", and
  // a surface that printed only parsed seconds would silently lose the page's answer for a fifth of
  // the pages that HAVE one.
  assert.equal(respawnWikiDefaultLine(row({ wikiText: 'Triggered' }), fmt), 'wiki: "Triggered" - not a duration')
  assert.equal(respawnWikiDefaultLine(row({ wikiText: '9.5 min', wikiMs: 570_000 }), fmt), 'wiki default: 570s ("9.5 min")')
  assert.equal(respawnWikiDefaultLine(row(), fmt), '', 'silence is empty, never a sentence about silence')
})

/** Watch these mobs with no number of your own — tracking is opt-in, so a test wanting rows asks. */
function watching(...keys: string[]): RespawnPrefs {
  return { watches: keys.map((key) => ({ key, display: key })) }
}

function fold(lines: readonly string[], prefs: RespawnPrefs, nowMs: number): RespawnSnap {
  const mod = new RespawnModule(prefs)
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  mod.onTick(nowMs)
  return mod.snapshot().state
}

test('the row carries the wiki PAGE, so the modal can link to what it is quoting', () => {
  // The committed floor has carried `page` since the scrape was written and nothing had ever read
  // it; quoting a source the reader cannot open is half of provenance. `a frenzied ghoul` is one of
  // the 507 rows in that file — page title "A frenzied ghoul", text "9.5 min".
  const snap = fold(
    [
      '[Sun Aug 02 23:45:41 2026] You have entered The Ruins of Old Guk.',
      '[Sun Aug 02 23:50:00 2026] You have slain a frenzied ghoul!'
    ],
    watching('a frenzied ghoul'),
    Date.parse('2026-08-02T23:51:00Z')
  )
  const r = snap.rows[0]
  assert.equal(r.wikiPage, 'A frenzied ghoul')
  assert.equal(r.wikiText, '9.5 min')
  assert.equal(r.wikiMs, 570_000)
  assert.equal(snap.v, RESPAWN_SHAPE_VERSION, 'the shape moved when the field was added')
})

test('a mob the floor says nothing about carries no page, and claims none', () => {
  // The 85 % case in the dungeons this ticket targets. The modal then offers whatever page the mob
  // lookup resolved, or no link at all — never a fabricated title.
  const snap = fold(
    [
      '[Sun Aug 02 23:45:41 2026] You have entered The Ruins of Old Guk.',
      '[Sun Aug 02 23:50:00 2026] You have slain a wan ghoul knight!'
    ],
    watching('a wan ghoul knight'),
    Date.parse('2026-08-02T23:51:00Z')
  )
  const r = snap.rows[0]
  assert.equal(r.wikiPage, undefined)
  assert.equal(r.wikiText, undefined)
})

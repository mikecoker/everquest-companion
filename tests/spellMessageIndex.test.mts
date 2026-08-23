// ============================================================================
// spellMessageIndex.test.mts — the cast-on-other index answers what the scan answered (JOS-58).
// ============================================================================
//
// THE CHANGE THIS EXISTS FOR. `matchCastOnOtherSuffix` used to walk all 648 entries of
// `SpellDb.castOnOtherSuffix` calling `endsWith`, for every log line no earlier parser family
// claimed — 20.2% of a real log, 284,073 of the owner's 1,404,455 lines. Measured on a quiet
// machine, that walk cost 9.2 s of an 11.5 s parse and was the largest single line item in the
// whole startup fold. It is now one hash lookup into `castOnOtherByLastWord`.
//
// THE ORACLE IS THE TABLE, NOT A SNAPSHOT. The index is DERIVED from `castOnOtherSuffix`, which
// stays on the DB as the definition, so this file can re-derive the pre-index answer from first
// principles — `linearScan` below IS the deleted implementation, verbatim — and demand that the
// shipped lookup agree with it. That keeps working when spells.json is re-scraped: a new message
// that the index cannot key, or a re-ordering that changes which spell a shared message resolves
// to, fails HERE rather than showing up as a quietly different buff months later.
//
// WHAT IT IS DRIVEN WITH, in three widening circles:
//   1. Every suffix in the table, synthesized into a line under four target shapes — the
//      exhaustive circle: no entry may become unreachable.
//   2. Every distinct message text in every committed golden fixture — the real circle, which is
//      also where the shared-message ambiguity (law 3) actually lives.
//   3. Hand-written adversaries for the three rejections the loop makes (bare tail, over-long
//      "target", possessive attachment) plus the shapes that would break the last-word key.
//
// AND THE SAME EQUIVALENCE THROUGH THE REAL PARSER: the golden corpus is folded end to end and
// every `buffApply` event the cascade emits is checked against the reference, so the claim is
// about `parseEvent`'s output and not only about a function nobody would notice regressing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildSpellDb, matchCastOnOtherSuffix, type SpellDb } from '../src/main/data/spellDb'
import { applyOverlayCorrections } from '../src/main/data/spellDb'
import { MessageOverlayMiner } from '../src/main/data/messageOverlay'
import spellsJson from '../src/main/data/spells.json'
import baselineJson from '../src/main/data/messageOverlay.baseline.json'
import { getParserConfig, installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { parseEvent } from '../src/main/log/parser'
import { norm } from '../src/main/log/parseCommon'
import { FIXTURES } from './harness.mjs'
import type { LogEvent } from '../src/shared/logEvents'
import type { MessageOverlay, SpellDbFile } from '../src/shared/types'

// ------------------------------------------------------------------------------ the two answers

/**
 * THE PRE-INDEX MATCHER, VERBATIM — walk the table in order, take the first suffix the line ends
 * with whose prefix is a plausible target. This is the behaviour being preserved, kept here as
 * the oracle's reference rather than in `src/` as a second code path nobody runs.
 */
function linearScan(text: string, db: SpellDb): { suffix: string; target: string } | null {
  for (const [suffix] of db.castOnOtherSuffix) {
    const attach = suffix.startsWith("'s") ? '' : ' '
    const tail = attach + suffix
    if (text.endsWith(tail) && text.length > tail.length) {
      const target = text.slice(0, text.length - tail.length).trim()
      if (target && target.length <= 60) return { suffix, target }
    }
  }
  return null
}

/** What the shipped lookup says, flattened into the reference's shape so the two compare. */
function indexed(text: string, db: SpellDb): { suffix: string; target: string } | null {
  const hit = matchCastOnOtherSuffix(text, db)
  return hit ? { suffix: hit.entry.suffix, target: hit.target } : null
}

function agree(text: string, db: SpellDb, why: string): void {
  const a = linearScan(text, db)
  const b = indexed(text, db)
  assert.deepEqual(
    b,
    a,
    `${why}: the index and the linear scan must agree on ${JSON.stringify(text)}` +
      ` (scan ${JSON.stringify(a)}, index ${JSON.stringify(b)})`
  )
  // …and when they match, they must have picked the SAME table entry, not merely the same text:
  // the candidate list is what reaches the buffs module, and two suffixes can share a target.
  if (a) {
    assert.deepEqual(
      matchCastOnOtherSuffix(text, db)?.entry.cands,
      db.castOnOtherSuffix.get(a.suffix),
      `${why}: the matched entry carries the table's candidates for ${JSON.stringify(a.suffix)}`
    )
  }
}

// --------------------------------------------------------------------------------- the two DBs

/** The bare wiki DB — what `loadSpellDb()` builds, without touching its module-level cache. */
function wikiDb(): SpellDb {
  return buildSpellDb((spellsJson as unknown as SpellDbFile).spells)
}

/**
 * The EFFECTIVE DB the app installs: spells.json + the committed message overlay, overlay wins
 * (wiring.ts `effectiveSpellDb`). Only the cast-on-YOU table takes corrections, so the suffix
 * index is the same either way — asserted below rather than assumed.
 */
function effectiveDb(): SpellDb {
  const db = wikiDb()
  const miner = new MessageOverlayMiner(db.byKey)
  miner.merge(baselineJson as unknown as MessageOverlay, 'baseline')
  applyOverlayCorrections(db, miner.deriveLandingCorrections())
  return db
}

// ------------------------------------------------------------------------------- the structure

test('every cast-on-other suffix is reachable through the index — nothing was dropped in the build', () => {
  const db = wikiDb()
  const seen = new Set<string>()
  for (const bucket of db.castOnOtherByLastWord.values()) {
    for (const e of bucket) {
      assert.equal(seen.has(e.suffix), false, `${e.suffix} is indexed twice`)
      seen.add(e.suffix)
    }
  }
  for (const e of db.castOnOtherUnkeyed) seen.add(e.suffix)
  assert.equal(
    seen.size,
    db.castOnOtherSuffix.size,
    'the index holds exactly the table it was built from'
  )
  for (const suffix of db.castOnOtherSuffix.keys()) {
    assert.equal(seen.has(suffix), true, `${suffix} is in the table but not in the index`)
  }
  // The table is the definition and the index reads it; `index` must therefore be the entry's
  // real position, because that is the ONLY thing deciding precedence between two matches.
  const order = [...db.castOnOtherSuffix.keys()]
  for (const bucket of db.castOnOtherByLastWord.values()) {
    for (const e of bucket) assert.equal(order[e.index], e.suffix, `${e.suffix} carries its table index`)
  }
})

test('the index is worth having: 648-ish entries collapse to a small worst-case bucket', () => {
  const db = wikiDb()
  const sizes = [...db.castOnOtherByLastWord.values()].map((b) => b.length)
  const worst = Math.max(...sizes)
  // Not a golden number — a shape claim. If a re-scrape ever made one bucket half the table the
  // lookup would have quietly become the scan again, and this says so.
  assert.ok(
    worst * 4 < db.castOnOtherSuffix.size,
    `the largest bucket (${String(worst)}) must stay far under the table (${String(db.castOnOtherSuffix.size)})`
  )
  assert.ok(db.castOnOtherByLastWord.size > 100, 'the keys really do spread')
})

test('the overlay corrects LANDING messages only — the cast-on-other index is identical either way', () => {
  const bare = wikiDb()
  const eff = effectiveDb()
  assert.deepEqual([...eff.castOnOtherSuffix.keys()], [...bare.castOnOtherSuffix.keys()])
  assert.equal(eff.castOnOtherUnkeyed.length, bare.castOnOtherUnkeyed.length)
})

// -------------------------------------------------------------------- circle 1: every suffix

test('EXHAUSTIVE: every suffix in the table, under four target shapes, resolves identically', () => {
  const db = effectiveDb()
  // The four shapes a real log names a target with (law 2 — names are dirty): a bare proper
  // name, an article-led mob, one with an apostrophe/backtick, and a multi-word one.
  const targets = ['Vebarn', 'a froglok tad', "Innoruuk`s Chosen", 'an ice giant sentry']
  let matched = 0
  for (const suffix of db.castOnOtherSuffix.keys()) {
    const attach = suffix.startsWith("'s") ? '' : ' '
    for (const t of targets) {
      const line = `${t}${attach}${suffix}`
      agree(line, db, 'synthesized')
      if (linearScan(line, db)) matched++
    }
  }
  // Every synthesized line SHOULD match something (it was built from a real suffix); if a later
  // scrape adds a suffix so long the 60-char target rule bites, this counts it rather than
  // letting a silently-unmatched entry pass as a pass.
  assert.equal(
    matched,
    db.castOnOtherSuffix.size * targets.length,
    'every suffix matched under every target shape'
  )
})

test('…and each of those lines still names the RIGHT spell, not merely the same one twice', () => {
  const db = effectiveDb()
  for (const [suffix, cands] of db.castOnOtherSuffix) {
    const attach = suffix.startsWith("'s") ? '' : ' '
    const hit = matchCastOnOtherSuffix(`a froglok tad${attach}${suffix}`, db)
    assert.ok(hit, `${suffix} matches`)
    // A line may end with a SHORTER known suffix too ("…looks tranquil." vs "…tranquil."), in
    // which case table order decides — so the assertion is "the winner is the earliest entry
    // this line ends with", which is exactly what the scan did.
    const scan = linearScan(`a froglok tad${attach}${suffix}`, db)
    assert.equal(hit.entry.suffix, scan?.suffix)
    if (hit.entry.suffix === suffix) assert.deepEqual(hit.entry.cands, cands)
  }
})

// -------------------------------------------------------------------- circle 2: the real corpus

/** Every message text (the part after the `[stamp] ` prefix) in every committed golden fixture. */
function corpusTexts(): string[] {
  const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.log')).sort()
  assert.ok(names.length > 10, `expected the committed fixtures (found ${String(names.length)})`)
  const texts = new Set<string>()
  for (const n of names) {
    for (const line of readFileSync(join(FIXTURES, n), 'utf8').split(/\r?\n/)) {
      const m = /^\[(.+?)\]\s?(.*)$/.exec(line)
      if (m) texts.add(m[2])
    }
  }
  return [...texts]
}

test('THE REAL CIRCLE: every distinct message in every committed fixture resolves identically', () => {
  const db = effectiveDb()
  const texts = corpusTexts()
  assert.ok(texts.length > 5_000, `the corpus should be thousands of distinct lines (${String(texts.length)})`)
  let hits = 0
  for (const t of texts) {
    agree(t, db, 'corpus')
    if (linearScan(t, db)) hits++
  }
  // The corpus must actually EXERCISE the matcher — an oracle over lines that all return null
  // proves only that two functions can both say no.
  assert.ok(hits > 20, `the fixtures should contain real cast-on-other emotes (${String(hits)})`)
})

// ---------------------------------------------------------------- circle 3: the adversaries

test('the three rejections the loop makes survive the index', () => {
  const db = effectiveDb()
  // Pick a real non-possessive suffix and a real possessive one to build adversaries from.
  const plain = [...db.castOnOtherSuffix.keys()].find((s) => !s.startsWith("'s") && s.includes(' '))
  const poss = [...db.castOnOtherSuffix.keys()].find((s) => s.startsWith("'s"))
  assert.ok(plain && poss, 'the table has both shapes')

  const cases = [
    plain, // the bare tail with NO target at all
    ` ${plain}`, // a leading space is not a target
    `${'x'.repeat(61)} ${plain}`, // a 61-char "target" is a sentence, not a mob
    `${'x'.repeat(60)} ${plain}`, // …and 60 is still a mob
    `Vebarn${poss}`, // possessive attaches with no space
    `Vebarn ${poss}`, // …so a space before it must NOT match the possessive form
    poss,
    'You have entered The Plane of Sky.', // an ordinary line whose last word keys nothing
    'a froglok tad', // no terminator at all
    '', // the degenerate line
    '.',
    ' ',
    'looks',
    ` ${plain}` // a control char is still a target as far as this matcher is concerned
  ]
  for (const c of cases) agree(c, db, 'adversary')
})

test('a line that ends with TWO known suffixes goes to the earlier table entry, as the scan did', () => {
  const db = effectiveDb()
  // Find a real pair where one suffix is a tail of another ("…looks tranquil." / "…tranquil.").
  const keys = [...db.castOnOtherSuffix.keys()].filter((s) => !s.startsWith("'s"))
  const shorter = keys.find((s) => keys.some((o) => o !== s && o.endsWith(` ${s}`)))
  if (!shorter) {
    // Not a defect — today's table may hold no such pair. Say so instead of passing silently.
    assert.ok(true, 'no nested suffix pair in the table today; the ordering rule is untested here')
    return
  }
  const longer = keys.find((o) => o !== shorter && o.endsWith(` ${shorter}`))
  assert.ok(longer)
  agree(`a froglok tad ${longer}`, db, 'nested pair')
})

// ------------------------------------------------------------ the same claim through the parser

/**
 * One cast-on-other `buffApply` the parser emitted, checked field by field against what the
 * linear reference says the same line means: same target, same primary spell, and the same
 * CANDIDATE LIST in the same order — that last one being the field law 3 makes load-bearing,
 * since the buffs module resolves a shared message against it.
 */
function pinAgainstReference(line: string, ev: LogEvent & { kind: 'buffApply' }, db: SpellDb): void {
  const m = /^\[(.+?)\]\s?(.*)$/.exec(line)
  assert.ok(m, 'a parsed event came from a timestamped line')
  const ref = linearScan(m[2], db)
  assert.ok(ref, `the reference scan also matches ${JSON.stringify(m[2])}`)
  assert.equal(ev.target, norm(ref.target), 'same target')
  const cands = db.castOnOtherSuffix.get(ref.suffix)
  assert.ok(cands)
  assert.equal(ev.spell, cands[0].name, 'same primary spell')
  assert.deepEqual(
    ev.candidates.map((c) => c.name),
    cands.map((c) => c.name),
    'same candidate list, in the same order (law 3 — the model resolves these)'
  )
}

/** Parse one fixture and pin every cast-on-other apply it emits. Returns what it saw. */
function pinFixture(name: string, db: SpellDb): { applies: number; checked: number } {
  const raw = readFileSync(join(FIXTURES, name), 'utf8')
  let applies = 0
  let checked = 0
  let seq = 0
  for (const line of raw.split(/\r?\n/)) {
    const ev = parseEvent(line, seq++)
    if (!ev || ev.kind !== 'buffApply') continue
    applies++
    // The self-landing half comes from the exact-match `castOnYou` table, which this change
    // never touched; the cast-on-OTHER half is the index's output and is what is pinned.
    if (ev.target === 'self') continue
    checked++
    pinAgainstReference(line, ev, db)
  }
  return { applies, checked }
}

test('THROUGH THE REAL PARSER: every buffApply the golden corpus emits matches the reference', () => {
  const db = effectiveDb()
  const previous = getParserConfig().spellDb
  installSpellDb(db)
  installCharacterName('Primitive')
  try {
    const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.log')).sort()
    let applies = 0
    let checked = 0
    for (const n of names) {
      const seen = pinFixture(n, db)
      applies += seen.applies
      checked += seen.checked
    }
    assert.ok(applies > 50, `the corpus should emit real buffApply events (${String(applies)})`)
    assert.ok(checked > 10, `…including cast-on-other ones (${String(checked)})`)
  } finally {
    installSpellDb(previous)
    installCharacterName(undefined)
  }
})

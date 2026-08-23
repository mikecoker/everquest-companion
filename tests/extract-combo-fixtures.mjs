// Class-combo fixture extractor (docs/plans/class-combo-inference.md § 11).
//
// Slices real spans out of the live log and keeps ONLY the lines that carry class evidence:
// the character's own `/who` rows (the single Tier-A observation — the only line in the game
// that states the loadout), level dings (the structural swap signal, since a displayed level
// is the MINIMUM of the loadout's class levels), casts, stances, invocations, rogue poison
// coats, and skill-ups (the only window into BER / MNK / WAR / ROG, which have 0/0/0/9 spells
// between them).
//
// Routed through the SHARED scrub (tests/fixture-scrub.mjs `scrubKeep`) like every other
// extractor: ONE definition of "third-party chat" for the whole tree, and never a hand-copied
// raw span. That is what drops all 410 strangers' `/who` rows while keeping Primitive's own
// 11 — and it is why the design document's quoted chat lines never reach a fixture.
//
// Usage: node tests/extract-combo-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { scrubKeep } from './fixture-scrub.mjs'

// Fixtures resolve RELATIVE to this file — the repo moved once and these extractors kept
// writing into the old absolute path. Never hardcode a repo path here again.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

const KEEP = [
  // Tier A — the ONLY authoritative statement of the loadout. Survives via the scrub's
  // self-name carve-out; every stranger's row in the same grammar is dropped.
  /\] *(?:\* RIP \*\s*)?(?:AFK\s+)?\[\d+ [A-Z]{3}(?:\/[A-Z]{3})*\] Primitive\b/,
  // Tier D — the structural swap signal (a NON-INCREASING ding means the loadout changed).
  /\] You have gained a level! Welcome to level \d+!$/,
  // Tier C — casts (weakest evidence, highest volume; both the cast and the bard-song shape).
  /\] You begin (?:casting|singing) /,
  // Tier B — the class-GATED signals.
  /\] You assume an? .+ stance\.$/,
  /\] You begin reciting the .+ invocation\.$/,
  /\] You coat your blades /,
  /\] You have become better at .+!/
]
const keep = (l) => l.startsWith('[') && scrubKeep(l) && KEEP.some((re) => re.test(l))

function cut(fromLine, toLine) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) if (keep(lines[i])) seg.push(lines[i])
  return seg
}

function slice(fromLine, toLine, out) {
  const seg = cut(fromLine, toLine)
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

/**
 * SEVERAL SMALL RANGES, IN LOG ORDER, AS ONE FIXTURE — for a shape whose defect lives in the
 * BOUNDARIES rather than in a span of evidence (JOS-287).
 *
 * Every line still comes out of the real log through the same `keep` filter and the same shared
 * scrub; what changes is that the evidence-free stretches BETWEEN the anchors are not carried.
 * That is legitimate exactly when the assertion is about where boundaries land — a `/who` row and
 * a level ding date themselves, so the hours between them add megabytes and no information — and
 * it is NOT legitimate for the sustain-based fixtures above (CW2/CW5/CW6), where thinning would
 * manufacture a silence the real session never had. Ranges must be given in ascending order.
 */
function splice(ranges, out) {
  const seg = ranges.flatMap(([from, to]) => cut(from, to))
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  const raw = ranges.reduce((n, [from, to]) => n + (to - from + 1), 0)
  console.log(`${out}: ${seg.length} lines (from raw ${raw} across ${ranges.length} ranges)`)
}

// ─────────────────────────────────────────────────────────────────────────────
// LINE RANGES. Located in eqlog_Primitive_freeport.txt on 2026-08-03. The log GROWS by
// append, so these stay valid; re-locate only if it is ever truncated/rotated.
// EPOCH: every span starts at/after the official launch anchor (2026-07-28 00:00 local,
// epochDetector.ts LAUNCH_MS), so the epoch reset never fires mid-fixture and no pre-launch
// beta-character evidence (the Jul 19–20 Bard window) can leak in.
// ─────────────────────────────────────────────────────────────────────────────

// CW1 WHO-ANCHORED — Tue Jul 28 14:00:00 → 20:45:00. The densest `/who` day in the log:
// SEVEN self rows, covering all four DISTINCT anchor combos the design names — [7 CLR/BER]
// (14:11:26), [7 PAL/ENC] (14:14:48), [10 PAL/ROG/ENC] (17:25:15), [17 PAL/MNK/ENC]
// (20:16:48, plus repeats at 20:30/20:31 and [18 …] at 20:42). That is the 2→3 slot
// transition — the tertiary slot unlocks at level 10 — stated by the game itself, and it
// carries the Jul 28 Backstab + Frenzy skill-ups that place ROG and BER in the same day.
slice(178804, 250545, 'cw1-who-anchored.log')

// CW2 THE UNLOGGED SWAP — Fri Jul 31 16:00:00 → the log's end at extraction (Mon Aug 03
// 15:17). Spans the ONE loadout swap in the post-launch log and, critically, the
// EVIDENCE-SHIFT WINDOW inside it: the last MNK evidence is `Feign Death! (108)` at
// Sun Aug 02 00:57:55 and the first ROG evidence is `Backstab! (2)` at 01:57:42 — one hour
// apart, with no line between them announcing anything. The wide structural bracket is here
// too: `Welcome to level 50!` at Jul 31 16:19:04 and the drop to `level 11!` at Aug 02
// 02:13:34, the honest 33.9 h boundary. Both sides need to be long enough to establish
// SUSTAIN (evidence in ≥2 hourly buckets), which is what a one-hour slice around the shift
// could not show, so the span is deliberately the full three days.
// It is the largest fixture this wave adds (~440 KB, vs the accepted 289 KB precedent of
// wl44-swap-boundary.log). It cannot be trimmed by dropping evidence-free stretches: after
// the KEEP filter EVERY retained line is evidence, and thinning it would manufacture a
// sustain gap the real session never had.
slice(663705, 1124605, 'cw2-loadout-swap-aug2.log')

// CW3 CLR/PAL AMBIGUITY — Tue Jul 28 13:41:00 → 14:41:00 (the design's "14:11 ±30 min").
// The `[7 CLR/BER]` anchor and the window around it, where every cast the character makes is
// a {CLR,PAL} shared spell (Reckless Strength, Wrath, Smite, Furor, Center, Courage, Daring,
// Stun, Holy Armor). CLR is NEVER exclusively evidenced anywhere in this log, so cast
// evidence alone can only ever report the SET {CLR,PAL} — never a guess of PAL.
// NOTE for the module wave: this span contains TWO self `/who` rows ([7 CLR/BER] at 14:11:26
// and [7 PAL/ENC] at 14:14:48). They are the ground truth the ambiguity is measured against,
// but they will also ANCHOR the interval at provenance 'who' — so the "stays ambiguous"
// assertion belongs on the scorer's own output (observations → slots), not on a /who-anchored
// interval.
slice(177648, 185280, 'cw3-ambiguous-clr-pal.log')

// CW4 THE STRAY CAST — Sun Aug 02 18:00:00 → 21:00:00, deep inside the post-swap PAL/ROG/BER
// period. Exactly ONE cast in the whole window names a class the loadout does not have:
// `You begin casting Rampage I.` at 20:52:33, which spells.json maps to {ENC}. One cast in
// one hourly bucket must NOT admit ENC (the sustain ≥ 2 rule).
// THE DESIGN NAMES THE WRONG LINE: § 2/C1 and § 10 call this "the lone Chaos Flux". There is
// no player Chaos Flux cast on Aug 2 at all — the only Aug 2 occurrences are a MOB's
// (`A ghoul scribe begins casting Chaos Flux.` 19:37:27 and its interrupt), which the parser
// never turns into a castBegin. Rampage I is the real instance of the case the design
// describes, and it is inside the span the design already chose.
slice(1019360, 1040292, 'cw4-stray-cast.log')

// CW5 THE WIZARD SWAP — Tue Aug 04 00:00:00 → the log's end at extraction (Thu Aug 06 22:38).
// The JOS-79 window, and it needs all three days for a reason the other fixtures do not:
//   * Aug 04 00:00 – 20:57 is the tail of the PAL/ROG/BER era, and 20:57:35's `Welcome to level
//     50!` is the ding that OPENS the level-drop window the bug lives in.
//   * Aug 04 23:38:01 is a swap into ENC/MNK/PAL that the game never dinged for (all three were
//     already capped), so only the evidence shift dates it.
//   * Aug 06 19:31:23 dings NON-INCREASING — the swap into a wizard loadout, whose window
//     therefore reaches all the way back to Aug 04 20:57:35 and swallowed the shift above.
//     Two real swaps, 43.9 h apart, arriving as ONE boundary. The fixture is the whole shape.
//   * Aug 06 19:31 → the end is the wizard evening itself: `Shock of Lightning` at 19:31:49,
//     `Lightning Bolt`, `Garrison's Mighty Mana Shock` — 824 wizard-exclusive observations that
//     the old clicky-suppression rule discarded to the last one, because this character casts
//     under a Spell Haste II focus that shimmers in the same second as every cast.
// Cannot be trimmed to the evening alone: the departure half of the reinstatement test needs
// MNK sustained BEFORE the ding, and the shift at Aug 04 23:38 needs BER/ROG sustained before
// IT — thinning either side would manufacture a silence the real session never had.
slice(1232428, 1434122, 'cw5-wizard-swap-aug6.log')

// CW6 THE WHOLE ARC — Tue Aug 04 00:00:00 → the end of Sun Aug 09. CW5's span with the SWAP BACK
// on it, and the reason it exists is that CW5's right edge is the blind spot that let JOS-79's
// guard die silently (JOS-239).
//
// CW5 stops inside the wizard evening. `reinstatedDrops` asks whether a class DEPARTED across the
// absorbed ding, and its window runs to the end of the observations — so inside CW5 the monk is
// gone and the guard fires, while on the LIVE log the owner swapped back and MNK/ENC return, so
// nothing departs, the Aug 06 19:31 cut is never reinstated, and one 4.5-day interval swallowed
// two swaps. The fixture passed the whole time. A regression guard whose window ends before the
// evidence that breaks it is not a guard.
//
// What the span carries, in order:
//   * Aug 04 20:57:35 `Welcome to level 50!` — the previous ding, which is where the Aug 06
//     drop's window opens (46.6 h wide).
//   * Aug 04 23:38:01 the silent swap into PAL/MNK/ENC (all three capped, so no ding).
//   * Aug 05 20:48:20 `You have slain Lord Nagafen!` at Solo 4 — the kill the ticket is about.
//     Not in the fixture (this extractor keeps class evidence only); the test states its
//     timestamp and joins a recorded kill to the intervals, which is what the surface does.
//   * Aug 06 19:31:23 the NON-INCREASING ding into the level-11 wizard, and the evening that
//     follows it (level 25 by 22:27:32).
//   * Aug 08 the swap BACK to PAL/MNK/ENC, which dings for nothing — going back up to 50 is not
//     a level GAIN — so only the evidence dates it.
//   * Aug 09 10:41:31 `[50 PAL/MNK/ENC] Primitive` — the game stating the loadout on the far
//     side, the anchor the whole arc is measured against.
// It cannot be trimmed at either end: cut the tail and the swap-back disappears (which is CW5),
// cut the head and the ding that opens the absorbed window is gone.
slice(1232428, 1557569, 'cw6-swap-back-aug9.log')

// CW7 THE SWAP-BOUNDARY SHAPE — five small ranges, Thu Aug 06 22:27 → Wed Aug 12 22:47 (JOS-287).
// Located 2026-08-13; the log grows by append, so they stay valid.
//
// The defect this pins is a MERGE defect, so the fixture carries the lines that DATE boundaries
// and nothing else. What the shape needs, and why each range is in it:
//   * 1433674  `Welcome to level 25!` (Aug 06 22:27:32) — the previous ding, and therefore where
//     the level-drop window OPENS. Without it the drop has no left edge and the defect cannot
//     form.
//   * 1442262  `[50 PAL/MNK/ENC] Primitive` (Aug 09 10:41:31) — THE ROW THE TRIPWIRE IS ABOUT,
//     the loadout the owner was playing that morning.
//   * 1561125  `[50 PAL/ROG/BER]` (Aug 10 20:13:00) — the loadout he swapped INTO, a day later.
//   * 1594342  `[50 PAL/MNK/ENC]` (Aug 11 21:01:24) and 1628111 `[10 PAL/RNG/SHM]` (Aug 12
//     22:42:20) — two more swaps, because the failure needs several rows under ONE window.
//   * 1629165  `Welcome to level 11!` (Aug 12 22:47:00) — the re-roll's NON-INCREASING ding
//     (50 → 11), whose window therefore reaches back SIX DAYS to the Aug 06 ding and overlaps
//     every row cut above.
//
// That is the whole bug in one file: the six-day window overlapped four `/who` cuts,
// `mergeBoundaries` read the overlap as one swap, kept the narrowest window and clamped the cut
// into it — one boundary where there were four — and the surviving slice held rows that
// contradict each other, so `slotsFor`'s last-row rule stated `PAL/ROG/BER` over the Aug 09
// morning. A row applied BACKWARDS across a swap boundary.
splice(
  [
    [1433600, 1433700],
    [1442160, 1442360],
    [1561000, 1561200],
    [1594250, 1594450],
    [1628000, 1629200]
  ],
  'cw7-who-swap-boundary-aug12.log'
)

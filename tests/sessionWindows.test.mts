// SESSION-FRAME TESTS — login/logout in the world model.
//
// Three layers, in the order the model was built:
//
//   1. PARSER GOLDENS over real, scrubbed log windows (tests/fixtures/s1–s5-session-*.log, cut
//      by tests/extract-session-fixtures.mjs): the three new line families, byte-exact.
//
//   2. OFFLINE-GAP GOLDENS: the same windows replayed through the real parser + the real
//      SessionDetector, pinning every field of every derived `offlineGap`. These windows were
//      chosen to cover the four outcomes the log actually contains — an overnight camp, a
//      crash with no camp at all, a pair of ABORTED camps (the only two in the log), and a
//      sub-minute relog that must produce nothing.
//
//   3. BUFF-TIMER PAUSE: first the EVIDENCE (fixture s5, a real cast/camp/login/wear-off
//      chain whose arithmetic can only be explained by timers that stop while you are out of
//      the world), then the CONTRACT it justifies, driven through BuffsModule with
//      hand-built events so the pause and the mining censor are pinned independently of the
//      30-minute log hole that would otherwise mask them.
//
// WHAT THE MODEL DOES ABOUT ALL THIS lives next door in tests/buffPauseOffline.test.mts —
// JOS-134's half: that a buff survives a real overnight camp (the case layer 3 could not reach,
// because the hole used to wipe it before the gap arrived), and that a DEBUFF pointedly does not
// pause with it.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import type { LogEvent, OfflineGapEvent } from '../src/shared/logEvents'
import * as sessionDetector from '../src/main/log/sessionDetector'
import {
  CAMP_PAIRING_MS,
  inWorldEvidence,
  OFFLINE_GAP_MIN_MS,
  SessionDetector
} from '../src/main/log/sessionDetector'
import { BuffsModule } from '../src/main/modules/buffs'
import { MAX_SAMPLE_MS, SESSION_GAP_MS } from '../src/main/modules/buffsShapes'
import { loadSpellDb } from '../src/main/data/spellDb'
import { installSpellDb } from '../src/main/log/rulesets'
import { readFixture } from './harness.mts'

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

// THE PARSER GETS ITS SPELL DB, because the app's does (JOS-262). The wear-off families are
// DB-driven — `Your power fades.` is `unknown` without one and a `buffWearOff` with one — and
// since the anchor rule now reads event KINDS, a DB-less parse is a configuration this app
// never ships and would date an absence differently from the running product.
installSpellDb(loadSpellDb())

/** Parse a fixture into the LogEvent stream the app would see. */
function events(lines: string[]): LogEvent[] {
  const out: LogEvent[] = []
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) out.push(ev)
  }
  return out
}

/** Replay a fixture through the real detector and collect every derived gap. */
function gaps(lines: string[]): OfflineGapEvent[] {
  const det = new SessionDetector()
  const out: OfflineGapEvent[] = []
  for (const ev of events(lines)) {
    const g = det.observe(ev)
    if (g) out.push(g)
  }
  return out
}

/** How many events of a kind the window yields. */
function count(lines: string[], kind: LogEvent['kind']): number {
  return events(lines).filter((e) => e.kind === kind).length
}

/** The ts of the single fixture line whose text ends with `suffix` (asserts uniqueness). */
function tsOfLine(lines: string[], suffix: string): number {
  const hits = lines.filter((l) => l.endsWith(suffix))
  assert.equal(hits.length, 1, `expected exactly one line ending "${suffix}", got ${hits.length}`)
  const ev = parseEvent(hits[0], 0)
  assert.ok(ev, 'line must parse')
  return ev.ts
}

/** An EQ-format timestamp → epoch ms, so goldens read as the log's own clock, not a number. */
function at(text: string): number {
  const ev = parseEvent(`[${text}] x`, 0)
  assert.ok(ev && ev.ts > 0, `unparseable stamp: ${text}`)
  return ev.ts
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * Epoch ms → the game's own `Sat Aug 01 13:00:28 2026` stamp — the inverse of {@link at}, so a
 * synthetic case can be written as a REAL log line and go through the real cascade rather than
 * hand-assembling an event object the parser would never have produced. LOCAL time, matching
 * parseEqTimestamp (see epochDetector.ts on why local is correct here).
 */
function stamp(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`
}

// =============================================================================
// 1. PARSER GOLDENS — the three new line families
// =============================================================================

test('the login line is claimed exactly, and only when it stands alone', () => {
  const ev = parseEvent('[Fri Jul 31 14:49:15 2026] Welcome to EverQuest Legends!', 7)
  assert.deepEqual(ev, {
    kind: 'sessionStart',
    seq: 7,
    ts: at('Fri Jul 31 14:49:15 2026'),
    raw: '[Fri Jul 31 14:49:15 2026] Welcome to EverQuest Legends!'
  })
  // The same words QUOTED by another player are chat, not a login. The fixture scrub drops
  // chat, but the runtime parser sees every line, so the exact-match rule is what protects us.
  assert.equal(
    parseEvent("[Fri Jul 31 14:49:15 2026] Rykkerr tells General:1, 'Welcome to EverQuest Legends!'", 0)?.kind,
    'unknown'
  )
  // `Welcome to level 44!` belongs to the level family and must not drift into this one.
  assert.notEqual(parseEvent('[Fri Jul 31 14:49:15 2026] Welcome to level 44!', 0)?.kind, 'sessionStart')
})

test('camp initiation and camp abort are separate events; the countdown ticks stay unknown', () => {
  assert.equal(
    parseEvent('[Fri Jul 31 01:05:43 2026] It will take you about 30 seconds to prepare your camp.', 0)?.kind,
    'campStart'
  )
  assert.equal(
    parseEvent('[Sun Aug 02 01:34:09 2026] You abandon your preparations to camp.', 0)?.kind,
    'campAbort'
  )
  // The five ticks restate the initiation and nothing consumes them; leaving them `unknown` is
  // what keeps the last-known-online timestamp advancing THROUGH the camp (see sessionDetector).
  for (const n of [25, 20, 15, 10, 5]) {
    assert.equal(
      parseEvent(`[Fri Jul 31 01:05:47 2026] It will take about ${n} more seconds to prepare your camp.`, 0)?.kind,
      'unknown'
    )
  }
})

// =============================================================================
// 2. OFFLINE-GAP GOLDENS — real windows, hand-read
// =============================================================================

test('S1 overnight camp: an orderly logout, 13h43m away, and a login', () => {
  const lines = readFixture('s1-session-overnight-camp.log')
  assert.equal(count(lines, 'campStart'), 1)
  assert.equal(count(lines, 'campAbort'), 0)
  assert.equal(count(lines, 'sessionStart'), 1)

  const [g] = gaps(lines)
  assert.ok(g, 'the window must produce exactly one gap')
  assert.equal(gaps(lines).length, 1)
  // fromTs is the CAMP-INITIATION LINE (01:05:43) — the newest line in the window that could
  // only have been printed for this character. It is NOT the last countdown tick 24s later
  // (01:06:07): the five ticks are deliberately `unknown` (parseSession.ts) and JOS-262's
  // evidence anchor cannot read them, which is the priced cost of the rule (see
  // sessionDetector.ts — an ordinary camp reports 24s long, and 13 of the log's 45 logins do).
  // And it is emphatically not the reconnect preamble that starts at 14:49:09.
  assert.equal(g.fromTs, at('Fri Jul 31 01:05:43 2026'))
  assert.equal(g.toTs, at('Fri Jul 31 14:49:15 2026'))
  assert.equal(g.toTs - g.fromTs, 13 * HOUR + 43 * MIN + 32 * SEC)
  assert.equal(g.camped, true)
  // The event's own ts is the login instant, so it slots into the stream where it happened.
  assert.equal(g.ts, g.toTs)

  // THE TRAP THIS WINDOW EXISTS TO CATCH: the newest event before the Welcome is the
  // `Channels: 1=General1(400)` preamble line, TWO SECONDS earlier. A "last event" anchor
  // would have called this 13h43m absence a 2-second one and emitted nothing at all.
  const evs = events(lines)
  const welcome = evs.findIndex((e) => e.kind === 'sessionStart')
  assert.equal(evs[welcome].ts - evs[welcome - 1].ts, 2 * SEC)
  // …and the reason the anchor is immune to it: NOTHING between the camp and the Welcome is
  // evidence about this character. Preamble length simply cannot enter the arithmetic.
  const between = evs.filter((e) => e.ts > g.fromTs && e.ts < g.toTs)
  assert.ok(between.length >= 5, 'ticks + preamble are in the window')
  assert.deepEqual(between.filter(inWorldEvidence), [])
})

test('S2 crash/quit: a login with no camp anywhere in the window reads camped=false', () => {
  const lines = readFixture('s2-session-crash-relog.log')
  assert.equal(count(lines, 'campStart'), 0)
  assert.equal(count(lines, 'sessionStart'), 1)

  const [g] = gaps(lines)
  assert.ok(g)
  // Nothing announced the logout, and NOTHING ABOUT THIS CHARACTER was printed for the last
  // hour of it either — he went A.F.K. inside somebody else's raid. `Your power fades.` at
  // 21:03:14 is the last line the game addressed to him; the DoT ticks and melee that follow
  // it (21:20:59) all name other people, which is the same thing a reconnect preamble carries
  // and therefore no evidence at all (JOS-262). The full-log replay agrees to the second.
  assert.equal(g.fromTs, at('Fri Jul 31 21:03:14 2026'))
  assert.equal(g.toTs, at('Fri Jul 31 22:07:34 2026'))
  assert.equal(g.toTs - g.fromTs, HOUR + 4 * MIN + 20 * SEC)
  assert.equal(g.camped, false)
  // THE COST, IN THE ONE WINDOW THAT SHOWS IT: the character really was in the world until
  // ~21:21, so this gap runs ~18 minutes long. It errs by OVER-stating the absence, which is
  // the direction the model is built to survive (the learner censors every sample that spans a
  // gap either way, and an over-long pause leaves a buff standing rather than culling it).
  assert.ok(g.toTs - g.fromTs > 46 * MIN + 35 * SEC, 'the old window rule read 46m35s here')
})

test('S3 aborted camps: the two abandon lines in the log, and a relog too short to report', () => {
  const lines = readFixture('s3-session-camp-aborted.log')
  // Three camps started, two abandoned outright, the third completed.
  assert.equal(count(lines, 'campStart'), 3)
  assert.equal(count(lines, 'campAbort'), 2)
  assert.equal(count(lines, 'sessionStart'), 1)
  // A BLIP STAYS A BLIP, and this is the window where that was in doubt. The measured absence
  // is the third camp's initiation (01:34:23) → the Welcome (01:35:21): 58 seconds, against a
  // 60-second floor. Under the old window rule it read 34s (from the last countdown tick), so
  // JOS-262's anchor spends 24 of the 26 seconds of margin here — and it is still a blip, which
  // is what the full-log check confirms for all four sub-minute relogs in the log (26 / 34 /
  // 50 / 58 s measured 2026-08-12). A relog is not an event worth modelling.
  assert.equal(gaps(lines).length, 0)
  assert.equal(
    at('Sun Aug 02 01:35:21 2026') - at('Sun Aug 02 01:34:23 2026'),
    58 * SEC
  )
  assert.ok(58 * SEC < OFFLINE_GAP_MIN_MS)
})

test('S4 fast relog: a 50-second camp cycle produces no gap', () => {
  const lines = readFixture('s4-session-fast-relog.log')
  assert.equal(count(lines, 'campStart'), 1)
  assert.equal(count(lines, 'campAbort'), 0)
  assert.equal(count(lines, 'sessionStart'), 1)
  assert.equal(gaps(lines).length, 0)
})

test('an abandoned camp does not make the following absence look orderly', () => {
  // Synthetic, because the real log never happens to crash right after an abort — but the
  // combination is the whole reason `campAbort` is read rather than inferred. Camp at t, ABORT
  // at t+1s, one more in-world line, then a 10-minute absence: the player did NOT camp out.
  const t = at('Sun Aug 02 01:34:09 2026')
  /** Build a REAL log line at `ts` and parse it, so these cases go through the same cascade. */
  const line = (ts: number, text: string): LogEvent => {
    const ev = parseEvent(`[${stamp(ts)}] ${text}`, 0)
    assert.ok(ev, `synthetic line must parse: ${text}`)
    assert.equal(ev.ts, ts, 'the synthetic stamp must round-trip')
    return ev
  }
  const feed = (evs: LogEvent[]): OfflineGapEvent[] => {
    const det = new SessionDetector()
    const out: OfflineGapEvent[] = []
    for (const e of evs) {
      const g = det.observe(e)
      if (g) out.push(g)
    }
    return out
  }
  const abortedThenGone = feed([
    line(t, 'It will take you about 30 seconds to prepare your camp.'),
    line(t + SEC, 'You abandon your preparations to camp.'),
    line(t + 2 * SEC, 'You have become better at Hide! (5)'),
    line(t + 2 * SEC + 10 * MIN, 'Welcome to EverQuest Legends!')
  ])
  assert.equal(abortedThenGone.length, 1)
  assert.equal(abortedThenGone[0].camped, false, 'an abandoned camp is not a logout')

  // The identical sequence WITHOUT the abandon line is an orderly camp.
  const campedThenGone = feed([
    line(t, 'It will take you about 30 seconds to prepare your camp.'),
    line(t + 2 * SEC, 'You have become better at Hide! (5)'),
    line(t + 2 * SEC + 10 * MIN, 'Welcome to EverQuest Legends!')
  ])
  assert.equal(campedThenGone.length, 1)
  assert.equal(campedThenGone[0].camped, true)
  // …and the pairing is a WINDOW, not "the most recent camp ever": a camp from an hour before
  // the last-known-online instant describes a different logout entirely.
  const staleCamp = feed([
    line(t, 'It will take you about 30 seconds to prepare your camp.'),
    line(t + HOUR, 'You have become better at Hide! (5)'),
    line(t + HOUR + 10 * MIN, 'Welcome to EverQuest Legends!')
  ])
  assert.equal(staleCamp[0].camped, false)
  assert.ok(HOUR > CAMP_PAIRING_MS)
})

test('a slow login is measured by the absence, not by how long the client took (JOS-262)', () => {
  // THE DEFECT THIS TICKET IS: the anchor used to be "the newest event at least 30s before the
  // Welcome", so the reconnect preamble — a CLIENT-SIDE duration nobody controls — decided the
  // answer. Measured on the shipped detector before the change: a 31s preamble emitted NO GAP
  // AT ALL (the anchor landed on a preamble line 31s back, 31s is under the 60s floor, and a
  // 13-hour absence vanished), 45s did the same, and a sparse 5-minute preamble reported 120s
  // of it. The reporter's machine loads the game slowly and his previous session's buffs were
  // missing at app start; this is that, in the arithmetic.
  const line = (ts: number, text: string): LogEvent => {
    const ev = parseEvent(`[${stamp(ts)}] ${text}`, 0)
    assert.ok(ev, `synthetic line must parse: ${text}`)
    return ev
  }
  const feed = (evs: LogEvent[]): OfflineGapEvent[] => {
    const det = new SessionDetector()
    const out: OfflineGapEvent[] = []
    for (const e of evs) {
      const g = det.observe(e)
      if (g) out.push(g)
    }
    return out
  }
  // The real preamble's own sentences, verbatim from the S1 window — all `unknown`, none of
  // them about this character. `spans` is how long the client spent printing them.
  const PREAMBLE = [
    'You are not currently assigned to an adventure.',
    'The Marketplace is unavailable at this time. Please try again later.',
    'Channel General was too full to join',
    'Channels: 1=General1(400)'
  ]
  const camp = at('Fri Jul 31 01:05:43 2026')
  const welcome = at('Fri Jul 31 14:49:15 2026')
  const ABSENCE = welcome - camp
  assert.equal(ABSENCE, 13 * HOUR + 43 * MIN + 32 * SEC)

  for (const spanMs of [6 * SEC, 31 * SEC, 45 * SEC, 5 * MIN]) {
    const preamble = PREAMBLE.map((text, i) =>
      line(welcome - spanMs + Math.round((i * spanMs) / PREAMBLE.length), text)
    )
    const [g] = feed([
      line(camp - 8 * SEC, 'You have slain an abhorrent!'),
      line(camp, 'It will take you about 30 seconds to prepare your camp.'),
      line(camp + 24 * SEC, 'It will take about 5 more seconds to prepare your camp.'),
      ...preamble,
      line(welcome, 'Welcome to EverQuest Legends!')
    ])
    assert.ok(g, `a ${spanMs / SEC}s preamble must not swallow a 13-hour absence`)
    assert.equal(g.fromTs, camp, `${spanMs / SEC}s preamble: the anchor is the camp line`)
    assert.equal(g.toTs - g.fromTs, ABSENCE, `${spanMs / SEC}s preamble: the whole absence`)
    assert.equal(g.camped, true)
  }
})

test("another player's kill in the preamble is not evidence that YOU are in the world", () => {
  // MEASURED, and it is why "the newest TYPED event" is too weak a test for in-world (the
  // ruling's first draft). Real log, the Aug 07 20:32:35 login after a 58m48s absence:
  //   [Fri Aug 07 20:32:33] A swirlspine seahorse has been slain by Dyson!
  //   [Fri Aug 07 20:32:33] A seahorse patriarch has been slain by Madoxide!
  //   [Fri Aug 07 20:32:35] Welcome to EverQuest Legends!
  // The client is already taking zone updates while the character is being placed, so two
  // fully-typed `death` events land TWO SECONDS before the login. Anchoring on them reads that
  // absence as two seconds and emits nothing at all.
  const line = (ts: number, text: string): LogEvent => {
    const ev = parseEvent(`[${stamp(ts)}] ${text}`, 0)
    assert.ok(ev, `synthetic line must parse: ${text}`)
    return ev
  }
  const welcome = at('Fri Aug 07 20:32:35 2026')
  const mine = welcome - (58 * MIN + 48 * SEC)
  const evs = [
    line(mine, 'You have slain a swirlspine seahorse!'),
    line(welcome - 6 * SEC, 'You are not currently assigned to an adventure.'),
    line(welcome - 2 * SEC, 'A swirlspine seahorse has been slain by Dyson!'),
    line(welcome - 2 * SEC, 'Madoxide punches a ferocious hammerhead for 106 points of damage.'),
    line(welcome - SEC, 'Lorelei healed itself for 142 hit points by Echoing Light.'),
    line(welcome, 'Welcome to EverQuest Legends!')
  ]
  // Every third-party line here IS typed — that is the point of the case.
  assert.deepEqual(
    evs.slice(2, 5).map((e) => e.kind),
    ['death', 'damage', 'heal']
  )
  assert.deepEqual(evs.slice(1, 5).filter(inWorldEvidence), [])

  const det = new SessionDetector()
  const out: OfflineGapEvent[] = []
  for (const e of evs) {
    const g = det.observe(e)
    if (g) out.push(g)
  }
  assert.equal(out.length, 1)
  assert.equal(out[0].fromTs, mine, 'the anchor is YOUR kill, not theirs')
  assert.equal(out[0].toTs - out[0].fromTs, 58 * MIN + 48 * SEC)
})

test('the same shapes DO anchor when the log names you', () => {
  // The other side of the rule, so the refusals above cannot be satisfied by refusing the whole
  // family: a swing, a heal and a kill that name the character are in-world evidence.
  const line = (text: string): LogEvent => {
    const ev = parseEvent(`[Fri Aug 07 20:00:00 2026] ${text}`, 0)
    assert.ok(ev, `synthetic line must parse: ${text}`)
    return ev
  }
  for (const text of [
    'You have slain a swirlspine seahorse!',
    'You punch a ferocious hammerhead for 106 points of damage.',
    'A ferocious hammerhead tries to crush YOU, but misses!',
    'Lorelei healed you for 142 hit points by Echoing Light.',
    'You have become better at Swimming! (163)',
    'You gain experience! (2.149%)',
    'You begin casting Shiftless Deeds IV.',
    'It will take you about 30 seconds to prepare your camp.',
    'Welcome to EverQuest Legends!'
  ]) {
    assert.equal(inWorldEvidence(line(text)), true, text)
  }
  for (const text of [
    'A swirlspine seahorse has been slain by Dyson!',
    'Madoxide punches a ferocious hammerhead for 106 points of damage.',
    'Lorelei healed itself for 142 hit points by Echoing Light.',
    'Dyson begins casting Quickness.',
    'A ferocious hammerhead tries to crush Madoxide, but misses!',
    'Channels: 1=General1(400)',
    'It will take about 5 more seconds to prepare your camp.'
  ]) {
    assert.equal(inWorldEvidence(line(text)), false, text)
  }
})

test('the detector is inert without a login, and never reports the first login of a log', () => {
  // A camp at the very end of the log (the real one ends on exactly this shape) is an intent
  // with no observed outcome — no Welcome, no gap.
  const campOnly = readFixture('s1-session-overnight-camp.log').slice(0, 13)
  assert.equal(campOnly.filter((l) => l.includes('Welcome to EverQuest')).length, 0)
  assert.equal(gaps(campOnly).length, 0)

  // A log that OPENS on a login has no observed "before". Inventing one out of the reconnect
  // preamble is exactly the mistake the reconnect window exists to prevent, so we emit nothing.
  const det = new SessionDetector()
  assert.equal(
    det.observe(parseEvent('[Fri Jul 31 14:49:15 2026] Welcome to EverQuest Legends!', 0) as LogEvent),
    null
  )
})

test('reset() forgets the previous log entirely', () => {
  const det = new SessionDetector()
  det.observe(parseEvent('[Fri Jul 31 01:06:07 2026] You have become better at Hide! (5)', 0) as LogEvent)
  det.reset()
  assert.equal(
    det.observe(parseEvent('[Fri Jul 31 14:49:15 2026] Welcome to EverQuest Legends!', 1) as LogEvent),
    null,
    'a new character must not inherit the old log as its fromTs'
  )
})

// =============================================================================
// 3. BUFF TIMERS PAUSE WHILE OFFLINE — the evidence, then the contract
// =============================================================================

test('S5 EVIDENCE: a haste cast before an overnight camp wears off 73 seconds after login', () => {
  const lines = readFixture('s5-session-buff-pause-evidence.log')

  const landTs = tsOfLine(lines, 'You feel much faster.')
  const wearOffTs = tsOfLine(lines, 'Your speed returns to normal.')
  const [g] = gaps(lines)
  assert.ok(g, 'the evidence window contains the absence')

  // The chain, in the log's own clock.
  assert.equal(landTs, at('Fri Jul 31 00:51:59 2026')) // Swift Like the Wind lands
  assert.equal(g.fromTs, at('Fri Jul 31 01:05:43 2026')) // the camp line (JOS-262's anchor)
  assert.equal(g.toTs, at('Fri Jul 31 14:49:15 2026')) // Welcome
  assert.equal(wearOffTs, at('Fri Jul 31 14:50:28 2026')) // `Your speed returns to normal.`
  assert.equal(g.camped, true)

  const elapsed = wearOffTs - landTs
  const offline = g.toTs - g.fromTs
  assert.equal(elapsed, 13 * HOUR + 58 * MIN + 29 * SEC)
  assert.equal(offline, 13 * HOUR + 43 * MIN + 32 * SEC)

  // THE RUN-OFFLINE HYPOTHESIS IS IMPOSSIBLE. If buff timers kept running while the character
  // was out of the world, a 16-minute haste landed at 00:51:59 would have expired unobserved
  // around 01:08 and this line could never have printed at 14:50:28 — the wall-clock span is
  // longer than any buff the model will even accept as a sample.
  assert.ok(elapsed > MAX_SAMPLE_MS, 'wall-clock elapsed exceeds the 3h sanity ceiling')

  // THE PAUSE HYPOTHESIS FITS TO THE SECOND — AND THE RESIDUE IS A KNOWN QUANTITY. Subtract the
  // absence and what remains is the spell's real duration: 14m57s against the scraped DB's
  // 16 min for Swift Like The Wind. The shortfall is 63 seconds and it is not slack in the
  // hypothesis, it is the CAMP: the anchor is the camp-initiation line and the character stayed
  // in the world for the ~30s countdown that follows it (+24s of it observable here, as five
  // `unknown` ticks) plus the seconds the client takes to drop. Add those back and the estimate
  // lands inside the DB's own minute, exactly as it did when `fromTs` was the last tick
  // (15m21s). This character's two clean same-evening online pairs measured 15m13s and 15m09s.
  const SWIFT_LIKE_THE_WIND_DB_MS = 16 * MIN
  const onlineElapsed = elapsed - offline
  assert.equal(onlineElapsed, 14 * MIN + 57 * SEC)
  const lastTickTs = tsOfLine(lines, 'It will take about 5 more seconds to prepare your camp.')
  assert.equal(lastTickTs - g.fromTs, 24 * SEC, 'the countdown the anchor cannot read')
  assert.ok(
    Math.abs(onlineElapsed + (lastTickTs - g.fromTs) - SWIFT_LIKE_THE_WIND_DB_MS) < MIN,
    `online elapsed ${onlineElapsed}ms + the camp countdown should be within a minute of the DB's ${SWIFT_LIKE_THE_WIND_DB_MS}ms`
  )
  // The run-offline hypothesis is not saved by any of this: it is out by THIRTEEN HOURS.
  assert.ok(elapsed - SWIFT_LIKE_THE_WIND_DB_MS > 13 * HOUR)

  // And the remainder resumed: the timer had 1m13s left when the login came, which is exactly
  // how long after it the wears-off line printed.
  assert.equal(wearOffTs - g.toTs, 73 * SEC)
})

test('CONTRACT: an offline gap shifts a surviving buff countdown and censors its duration sample', () => {
  // Hand-built events, for two reasons stated plainly: (a) the shift is only observable for
  // absences SHORTER than the 30-minute session-gap clear, which wipes every live instance
  // before a longer gap is ever delivered — and the real log's short gaps happen to have no
  // buff up across them; (b) driving the module directly is how the repo's other module
  // contracts are pinned. The SEMANTICS being encoded are the ones measured above.
  const t0 = at('Fri Jul 31 00:51:59 2026')
  const SPELL = 'Swift Like The Wind'
  const DUR = 16 * MIN
  const OFFLINE = 5 * MIN
  assert.ok(OFFLINE < SESSION_GAP_MS, 'the gap must be short enough to leave the buff standing')

  const mod = new BuffsModule()
  mod.reset()
  let seq = 0
  const send = (ev: Omit<LogEvent, 'seq' | 'raw'> & { raw?: string }): void => {
    mod.onEvent({ ...ev, seq: seq++, raw: ev.raw ?? '' } as LogEvent)
  }

  // Own cast, then the landing message one second later (own-cast attribution satisfied).
  send({ kind: 'castBegin', ts: t0, spell: SPELL } as LogEvent)
  send({
    kind: 'buffApply',
    ts: t0 + SEC,
    spell: SPELL,
    target: 'self',
    illusion: false,
    durationMs: DUR,
    candidates: [{ name: SPELL, durationMs: DUR, illusion: false }]
  } as LogEvent)

  const before = mod.snapshot().state.active
  assert.equal(before.length, 1)
  assert.equal(before[0].startedTs, t0 + SEC)

  // Out of the world from t0+60s to t0+360s, then back. The Welcome is the primary event; the
  // gap is the derived one the detector hands back onto the same bus.
  send({ kind: 'sessionStart', ts: t0 + 60 * SEC + OFFLINE } as LogEvent)
  send({
    kind: 'offlineGap',
    ts: t0 + 60 * SEC + OFFLINE,
    fromTs: t0 + 60 * SEC,
    toTs: t0 + 60 * SEC + OFFLINE,
    camped: true
  } as LogEvent)

  // THE PAUSE: the buff is still up and its clock moved forward by the absence, so the
  // countdown reads the ONLINE time that has actually elapsed — 59 seconds — rather than the
  // 359 seconds of wall clock that would have shown it as nearly a third spent.
  const after = mod.snapshot().state.active
  assert.equal(after.length, 1, 'the buff survives the absence')
  assert.equal(after[0].startedTs, t0 + SEC + OFFLINE)
  assert.equal(t0 + 60 * SEC + OFFLINE - after[0].startedTs, 59 * SEC)

  // 40 more seconds in-world, then the authoritative wears-off line. The buff clears — that
  // was never in question, the message is the authority (law 1).
  const wearOffTs = t0 + 100 * SEC + OFFLINE
  send({ kind: 'buffWearOff', ts: wearOffTs, spell: SPELL, candidates: [SPELL], target: 'self' } as LogEvent)
  const snap = mod.snapshot().state
  assert.equal(snap.active.length, 0)

  // THE CENSOR (law 5): the land→fade span crossed an absence we only know to within the
  // reconnect window, so it is NOT a duration observation. Ninety-nine seconds recorded as a
  // sample for a sixteen-minute spell would be exactly the kind of censored, too-short value
  // the recency-weighted MAX exists to avoid — and the drop is silent, not a zero.
  const stat = Object.values(snap.stats).find((s) => s.spell.toLowerCase() === SPELL.toLowerCase())
  assert.ok(stat, 'the spell is known to the model')
  assert.equal(stat.n, 0, 'no duration sample may be mined across an offline gap')
  assert.equal(stat.medianMs, null)
})

test('the measured constants are documented, and the reconnect WINDOW is gone', () => {
  // These are MEASURED values, not preferences (see sessionDetector.ts). Pinning them here
  // means a change has to be a deliberate edit to a failing test, with the log to back it.
  assert.equal(OFFLINE_GAP_MIN_MS, 60 * SEC)
  assert.equal(CAMP_PAIRING_MS, 60 * SEC)
  // RECONNECT_WINDOW_MS (30s) USED TO BE THE THIRD, and JOS-262 deleted it rather than tuning
  // it: the anchor is evidence now, so there is no constant left for a slow login to outrun.
  // The module exports exactly two numbers, and this is what says so.
  const exported = Object.keys(sessionDetector).filter((k) => k.endsWith('_MS'))
  assert.deepEqual(exported.sort(), ['CAMP_PAIRING_MS', 'OFFLINE_GAP_MIN_MS'])
})

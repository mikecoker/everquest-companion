// ============================================================================
// releaseNotes — what changed, release by release, and who has not read it yet (JOS-73).
// ============================================================================
//
// THE NOTES ARE COMMITTED SOURCE, not a fetch. Three reasons, in order of weight:
//
//   1. The app must be able to say what changed while offline, in a game session, with no
//      network and no GitHub. A release note that needs a request is a release note that is
//      sometimes absent, which is worse than none at all.
//   2. The bundler INLINES this module into the renderer exactly the way it inlines spells.json
//      and the mob catalog, so the notes ship with the build that they describe. A build can
//      never show a newer release's notes, and never lose its own.
//   3. It is reviewable in the diff that ships it. The owner reads the sentence in the pull
//      request, not on a web page afterwards.
//
// THE STORE KEY IS A VERSION, NOT A BOOLEAN. `lastSeenNotesVersion` (src/main/store.ts) holds
// the newest release whose notes this install has been SHOWN. That is what makes the A→D case
// work without bookkeeping: somebody who was on 0.6.3 and lands on 0.8.0 has TWO releases of
// news, and the panel marks both, because "new" is a comparison and not a flag somebody had to
// remember to set per release.
//
// AND AN ABSENT KEY MEANS A FRESH INSTALL, WHICH HAS NO NEWS. Nothing is marked, and the teaser
// strip never appears — a person who installed the app twenty minutes ago did not live through
// any of these changes, and telling them "Updated to v0.8.0" on their first launch would be a
// small lie in the first sentence the app ever says to them. The panel is still there to browse;
// it is history, and history is available to everyone.
//
// WHY THE STAMP IS THE NEWEST NOTE VERSION AND NOT `app.getVersion()`. package.json carries
// `0.1.0` forever — CI stamps the real version FROM THE TAG and never commits it (AGENTS.md,
// Shipping), so `app.getVersion()` reads 0.1.0 on every dev run. Stamping that would make every
// release look new on every launch in dev, and comparing against it would blank the whole
// feature there. The newest entry in this list IS the running version in every published build
// (the release job refuses a tag with no entry — scripts/check-release-notes.mjs), so reading it
// from the data is both honest and testable from a checkout.
//
// VOICE: player-centric and plain. What YOU can now do, or what stopped being wrong. Not wave
// names, not module names, not ticket ids. `kind` is the only structure — the panel groups by it
// into "New" / "Fixed" / "Changed" sub-headers, and a release whose entries carry no kind (the
// one-line historical headlines below) renders as a bare line with no sub-header at all.
//
// A NEW SURFACE EARNS EXTRA BULLETS — AT MOST FIVE (JOS-80, owner direction). The rule to apply
// when writing a release's notes, including the per-release draft cut at tag time:
//
//   * A FIX, A CHANGE, A NEW OPTION → ONE bullet. "What changed" is the whole answer. A player
//     reading "Maps render north correctly" needs nothing more, and explaining why north matters
//     would be padding.
//   * A NEW TAB, OR A MAJOR NEW SURFACE (a new mode on a tab, a new window, a way of working that
//     did not exist) → TWO TO FIVE bullets, never more than five. One says what it is; the others
//     say why it was built — the problem, in the player's terms and from before the thing existed
//     — and what they can now do with it. Nobody has any idea why a tab they have never seen is
//     there, and the one line that names it cannot tell them.
//
// IT IS PLAIN BULLETS IN THE SAME LIST, and that is the whole mechanism (owner ruling, 2026-08-07,
// which reversed a `detail` sub-paragraph field this ticket started out building). No extra field,
// no second rendering, no card, no header: an introduction is simply a change that took a few more
// lines to state. The renderer never learns that some bullets are special, so there is no way for
// the panel to become shouty and no shape for a future author to misuse.
//
//   * WHEN IN DOUBT, LEAVE IT OUT. The contrast is the signal: if most changes carried three
//     bullets the introductions would stop standing out. A release that was a rollup of fixes gets
//     no "why" at all — inventing one for a batch of repairs is the failure this rule prevents.
//
// A bullet NEVER restates its neighbour, never names a file, a module or a wave, and never
// explains how the app works internally (state, never process — the UI conventions).

/** Which sub-header an entry sits under. Absent ⇒ the entry is a bullet under no sub-header. */
export type ReleaseEntryKind = 'new' | 'fixed' | 'changed'

/** One bullet of a release's notes. */
export interface ReleaseEntry {
  readonly kind?: ReleaseEntryKind
  readonly text: string
  /**
   * THIS ONE CAME FROM A PLAYER (JOS-76, owner direction).
   *
   * Set only where a user report actually generated the work — the panel renders a small
   * "player report" chip on the bullet, and any release carrying one gets a single plain thanks
   * line under its header. NOBODY IS EVER NAMED: reports arrive with an install id and, when the
   * reporter chose to leave one, a contact — none of which belongs on a screen every other user
   * can read. The thanks is collective on purpose.
   *
   * THE BAR IS TRACEABILITY, NOT PLAUSIBILITY. A flag is set here only when the commit that did
   * the work cites a report (a report id, "the YouTube report", "Mac/CrossOver user report").
   * Owner-found defects are NOT tagged even though they were also "reported" — thanking the
   * community for the owner's own bug reports would make the chip mean nothing. When the trail is
   * unclear, the entry ships untagged: an unearned thanks costs more than a missing one.
   */
  readonly fromReport?: boolean
}

/** One release. `date` is an ISO calendar date (YYYY-MM-DD), rendered through the app's own
 *  local-date formatter — never parsed for arithmetic. */
export interface ReleaseNote {
  readonly version: string
  readonly date: string
  readonly entries: readonly ReleaseEntry[]
}

/**
 * Every release, NEWEST FIRST — the order the panel renders and the order every derivation
 * below assumes (`releaseNotesProblems` pins it, so the assumption is checked rather than
 * trusted).
 *
 * EVERY RELEASE IS BULLETS (JOS-76). The backfilled ones shipped first as single comma-separated
 * sentences, which is how "four things happened" gets read as one thing: a bullet per change is
 * the whole difference between a list somebody scans and a paragraph somebody skips. Each
 * historical release is split only as far as its own tag range honestly supports — two to four
 * bullets where the range holds that many player-facing changes, one where it holds one. Nothing
 * is invented to reach a count.
 *
 * …and a release that INTRODUCED a surface spends a few more of them on it (JOS-80 — see the
 * header's voice section for the cap and the rule). Four introductions carry that treatment
 * today: the What's new panel and the "This week" lockout view in 0.9.0, and, backfilled where
 * the tag range supports honest prose, the exaltation planner and the celebration cards in
 * 0.4.0 — plus in-app feedback in 0.3.0, which is the one judgment call in the set.
 *
 * The releases before 0.7.0 carry no `kind`. They are backfilled from the tag dates and the
 * commits in each tag's range, and sorting them into New/Fixed/Changed after the fact would be
 * guessing at a distinction nobody drew at the time — so they render as plain bullets, which is
 * an honest shape rather than a degraded one.
 *
 * v0.3.3 is deliberately ABSENT: its tag points at the same commit as v0.3.2, so there is
 * nothing it changed. The comparison is by version, not by row, so an install stamped 0.3.3
 * still sees exactly the releases above it.
 */
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: '0.12.0',
    date: '2026-08-08',
    entries: [
      {
        kind: 'changed',
        text: 'Anonymous usage reporting (if you have it on) now includes error counts — how many errors happened, never what they said — so a buggy release gets noticed and fixed faster.'
      }
    ]
  },
  {
    version: '0.11.1',
    date: '2026-08-07',
    entries: [
      {
        kind: 'fixed',
        text: "The combat log no longer jumps to the bottom while you're reading: scroll up and your place holds; scroll back to the bottom and it follows new lines again.",
        fromReport: true
      }
    ]
  },
  {
    version: '0.11.0',
    date: '2026-08-07',
    entries: [
      {
        kind: 'new',
        text: 'Set your loadout classes yourself when autodetection guesses wrong: the Profiles panel shows which classes are in effect and where that answer came from, and one click hands it back to auto.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Bow damage gets its own Ranged bar beside Melee, so a stance-switching ranger can compare bow and dual-wield numbers within a fight.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The Loot window can sort by last looted.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "Pointing the app at your logs works wherever they are: you can pick the log file itself, the folder card names the exact folder logs are read from, and a folder the app can't read says so instead of claiming you have no logs.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Alerts created from Suggested actually fire — a landing message shared by several spells now matches whichever of them you cast, and the alert speaks the right spell name.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "Bard crowd-control breaks are detected across the whole song ladder, not just the level-20 song — and a mez break is announced as a mez break, not a charm break.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Group members show up in the meters even when your group formed before the app was running: your own group buff landing on them is believed, once the log has shown party experience.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "Dying to a damage-over-time now counts as dying: buffs clear and the death alert fires even when the log names no killer.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "Monk Mend appears in the healing breakdown — counted every time, with the amount shown as unstated because the game never says one.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The celebration overlay introduces itself the first time it appears — named, with a close button, and a way to turn it off right on the card.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "The Sky tab's Hide completed choice sticks across tab switches and restarts.",
        fromReport: true
      }
    ]
  },
  {
    version: '0.10.0',
    date: '2026-08-07',
    entries: [
      {
        kind: 'new',
        text: "Every item's detail now shows where it drops for you: each zone with your observed drops, your drops per hour of active time there, and how long you actually farmed.",
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The leveling tab highlights what has been dropping in your selected time window — motes and farm targets float to the top — and clicking an item jumps to its detail.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Comparing farming spots used to mean notes and guesswork; now Befallen versus Plane of Hate is two clicks.'
      },
      {
        kind: 'fixed',
        text: 'Cleave has its own row in the damage breakdown instead of hiding inside Melee.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Smite has its own row too — the skill swings split out from the Smiting Strike spell.'
      },
      {
        kind: 'fixed',
        text: 'Loadout detection believes the swap you are playing: wizard casts under a haste focus were invisible, and a new swap could hide behind an older one. Your current classes now show within the half hour.'
      }
    ]
  },
  {
    version: '0.9.0',
    date: '2026-08-07',
    entries: [
      {
        kind: 'new',
        text: 'Raid targets: a "This week" view lists the lockouts you are holding right now, one row per difficulty.'
      },
      {
        kind: 'new',
        text: 'Lockouts are per difficulty and they all reset on Tuesday, which is easy to lose track of when one target has four tiers you killed on different nights.'
      },
      {
        kind: 'new',
        text: 'Each row names the kill that locked it and counts down to the reset, so what is still worth going after is a glance rather than an argument.'
      },
      {
        kind: 'new',
        text: 'My sounds: import your own audio files from the alerts toolbar and use them for any alert.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The exp graph has a timescale picker — and the whole leveling dashboard follows it: rates, AA pace and zone stats all read the window you chose.'
      },
      {
        kind: 'new',
        text: "What's new: this panel — every release, newest first, with a strip along the bottom the first time you launch after an update."
      },
      {
        kind: 'new',
        text: 'The app updates itself quietly in the background, so releases were arriving with nothing to say they had — no way to know what was different, or that a fix was there because somebody asked for it.'
      },
      {
        kind: 'new',
        text: 'Everything that landed since the version you were last on is marked new, and the changes that came from a player report are tagged as such.'
      },
      {
        kind: 'fixed',
        text: 'A kill or gain landing at the exact edge of a selected range was drawn on the chart but missing from the totals.'
      }
    ]
  },
  {
    version: '0.8.0',
    date: '2026-08-07',
    entries: [
      {
        kind: 'new',
        text: 'Suggested alerts for slows wearing off, mote drops, and receiving tells.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The exaltation planner has ear, wrist and finger slots — plan two ring effects at once.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Maps render north correctly (north and south were mirrored).',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Plane of Sky items on your Equipment keyring now count as owned.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Items whose wiki pages hide their slot (like the Golem Metal Wand) can donate their effects, and an empty planner result now says which filters are hiding rows.',
        fromReport: true
      },
      { text: 'The log engine is faster again.' }
    ]
  },
  {
    version: '0.7.0',
    date: '2026-08-07',
    entries: [
      {
        kind: 'changed',
        text: 'The meter no longer asks “your pet?” — order your pet once (/pet attack) or use /pet who leader and it is yours from that moment; re-summoning retires the old pet.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Raid mobs that lifetap are never misfiled as players, so your pet’s damage against them counts.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Loading no longer pegs a CPU core, and the overlays and cursor ring stay out of the way — and off your mouse — until parsing finishes.'
      },
      { kind: 'fixed', text: 'Switching characters no longer replays old alerts and celebrations.' },
      {
        kind: 'fixed',
        text: 'The game-folder setting works pointed at the install folder, the Logs folder, or a log file.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'The exaltation teaching card opens from the ? button instead of appearing on its own.'
      }
    ]
  },
  {
    version: '0.6.3',
    date: '2026-08-06',
    entries: [
      { text: 'The planner tab is called Exaltations.' },
      { text: 'Back returns you where you came from, from every drill in the app.' },
      { text: 'Every /outputfile export says which command to type and how old your last one is.' },
      {
        text: 'Two graphics switches for a card that dislikes the overlays: software rendering, and solid instead of transparent overlays.',
        fromReport: true
      }
    ]
  },
  {
    version: '0.6.2',
    date: '2026-08-05',
    entries: [
      { text: 'Your group appears in the meters, with a scope you choose.' },
      { text: 'Overlay text can be sized, and every overlay follows the same setting.' },
      { text: 'The Maps sidebar becomes one search box over mobs, labels and zones.' },
      { text: 'The planner gains a card that teaches exaltation, and fills its Inventory tab from your own dump.' }
    ]
  },
  {
    version: '0.6.1',
    date: '2026-08-05',
    entries: [
      {
        text: 'Closing the app really closes it — a failed teardown could leave it running with no window, and block the next launch.',
        fromReport: true
      }
    ]
  },
  {
    version: '0.6.0',
    date: '2026-08-05',
    entries: [
      { text: 'Attack-round stats, honest about what the log states and what it infers.' },
      {
        text: 'Picking your EverQuest folder attaches right away — and so does typing /log on, without a restart.',
        fromReport: true
      },
      { text: 'The installer runs under Wine and CrossOver instead of dead-ending.', fromReport: true }
    ]
  },
  {
    version: '0.5.0',
    date: '2026-08-05',
    entries: [
      {
        text: 'Monk special attacks get their real names — Dragon Punch and Flying Kick stop being counted as anonymous swings.',
        fromReport: true
      },
      { text: 'Your /outputfile dumps are read the moment you write them.' },
      { text: 'AA purchases read as ladders per ability instead of a flat list of lines.' }
    ]
  },
  {
    version: '0.4.0',
    date: '2026-08-05',
    entries: [
      { text: 'The exaltation planner arrives: plan sets over a class-filtered effect browser.' },
      {
        text: 'Working out which exaltation combinations are even legal, and then what the donor items would cost you to farm, was a job for a spreadsheet and a lot of wiki tabs.'
      },
      {
        text: 'Pick your classes, browse every effect you could transfer, fill a socket, and see which zones drop the pieces you are still missing.'
      },
      { text: 'Celebration cards appear over EverQuest when a raid target dies or a Sky quest completes.' },
      {
        text: 'Those moments are the payoff for a long night, and the app used to note them quietly in a list you would find later.'
      },
      {
        text: 'A card names what you just did, fades on its own, and takes you to the tab with the details if you click it.'
      },
      { text: 'Healing joins the meters, in the panel and in a floating overlay of its own.' },
      { text: 'Only kills credited to you celebrate — a boss a stranger killed nearby no longer does.' }
    ]
  },
  {
    version: '0.3.5',
    date: '2026-08-04',
    entries: [
      { text: 'Maps gain a zone pane that says what lives there, pinned where the wiki says.' },
      { text: 'Overview tiles link where you would click — a drop opens its item, a fight opens the meter.' },
      { text: 'Kill records go per instance tier, so a d4 badge no longer stands under a d0 loadout.' }
    ]
  },
  {
    version: '0.3.4',
    date: '2026-08-04',
    entries: [{ text: 'A stranger’s charmed pet no longer turns up in your damage meter.' }]
  },
  {
    version: '0.3.2',
    date: '2026-08-04',
    entries: [{ text: 'The app’s source code is public, under FSL-1.1-MIT.' }]
  },
  {
    version: '0.3.1',
    date: '2026-08-04',
    entries: [
      { text: 'Reading your log history no longer blocks the app while it loads.' },
      { text: 'The pet setting stops folding your pet permanently into your own row.' }
    ]
  },
  {
    version: '0.3.0',
    date: '2026-08-04',
    entries: [
      { text: 'Alerts learn to speak, in a system voice or a downloadable natural one.' },
      { text: 'A cursor ring finds your mouse over the EverQuest window.' },
      { text: 'Poison and slow alerts arrive, and the suggestion dialog becomes one search.' },
      { text: 'You can send feedback, with a scrubbed log window attached, from inside the app.' },
      {
        text: 'When something looked wrong there was nowhere to say so, and a problem nobody can see is a problem nobody fixes.'
      },
      {
        text: 'The attached window carries combat, casts and loot — never chat, and never anyone else’s words — so a defect can be diagnosed from what actually happened instead of from a description of it.'
      }
    ]
  },
  {
    version: '0.2.1',
    date: '2026-08-03',
    entries: [{ text: 'Copy on the combat meter puts the numbers on your clipboard again.' }]
  },
  {
    version: '0.2.0',
    date: '2026-08-03',
    entries: [
      { text: 'The first stable release.' },
      { text: 'An Overview landing tab: live DPS, current mob, zone, leveling pace and recent drops.' },
      { text: 'A Maps tab with zone search, label declutter and floor slicing.' },
      { text: 'Proc analytics, class-loadout inference, and leveling stats over a range you drag out.' }
    ]
  }
]

// ---------------------------------------------------------------- versions

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** The `-rc.1` half of a prerelease tag, or '' for a plain release. */
  readonly pre: string
}

/**
 * `v0.8.0` / `0.8.0` / `0.8.0-main.3` → its parts. Anything unparseable reads as 0.0.0, which
 * sorts below every real release — the safe direction: an unreadable stored value makes
 * everything look new rather than silently hiding a release.
 */
export function parseVersion(value: string): ParsedVersion {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim())
  if (!m) return { major: 0, minor: 0, patch: 0, pre: '' }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' }
}

/**
 * Semver ordering, enough of it: numeric triple first, then semver's own rule that a release
 * outranks its own prereleases (`0.8.0` > `0.8.0-main.3`). The prerelease tail itself is
 * compared as text, which is not the full spec — it is right for the only prerelease shapes this
 * repo has ever tagged (`-main.N`, `-sign.N`) and it is never the deciding factor for anything
 * the user sees, because every entry above is a plain release.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (x.major !== y.major) return x.major < y.major ? -1 : 1
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1
  if (x.pre === y.pre) return 0
  if (x.pre === '') return 1
  if (y.pre === '') return -1
  return x.pre < y.pre ? -1 : 1
}

/** The newest release these notes describe — the value an install is stamped with once it has
 *  been shown them. See the header for why this, and not `app.getVersion()`. */
export function latestReleaseVersion(notes: readonly ReleaseNote[] = RELEASE_NOTES): string {
  return notes[0]?.version ?? '0.0.0'
}

/** Does `version` (a tag name is fine — the leading `v` and any prerelease tail are ignored)
 *  have an entry? The release job's gate; see scripts/check-release-notes.mjs. */
export function hasReleaseNote(
  version: string,
  notes: readonly ReleaseNote[] = RELEASE_NOTES
): boolean {
  const want = parseVersion(version)
  return notes.some((n) => {
    const got = parseVersion(n.version)
    return got.major === want.major && got.minor === want.minor && got.patch === want.patch
  })
}

/** Does this release carry any player-reported entry? — whether it gets a thanks line (JOS-76). */
export function hasReportedEntry(note: ReleaseNote): boolean {
  return note.entries.some((e) => e.fromReport === true)
}

// ---------------------------------------------------------------- the state

/** What the teaser strip and the What's new panel both render from. */
export interface WhatsNewState {
  /** No stored last-seen version: a fresh install, which has no news. */
  readonly fresh: boolean
  /** Every release newer than the stored last-seen version, NEWEST FIRST. Marked "new" in the
   *  panel — all of them, which is the A→D case: 0.6.3 → 0.8.0 marks 0.7.0 and 0.8.0. */
  readonly newVersions: readonly string[]
  /** The one version the teaser strip names, or null for no teaser. The NEWEST — one line
   *  saying where you landed, never a list of everything you missed. */
  readonly teaserVersion: string | null
}

/**
 * The whole derivation, and it is a pure function of two values so it can be unit-tested and
 * driven by hand (the DEV variant control writes the store key and nothing else).
 *
 * `lastSeen` is whatever the store held: a version string, or null/undefined/'' for absent.
 */
export function whatsNewState(
  lastSeen: string | null | undefined,
  notes: readonly ReleaseNote[] = RELEASE_NOTES
): WhatsNewState {
  if (typeof lastSeen !== 'string' || lastSeen.trim() === '') {
    return { fresh: true, newVersions: [], teaserVersion: null }
  }
  const newVersions = notes
    .filter((n) => compareVersions(n.version, lastSeen) > 0)
    .map((n) => n.version)
  return { fresh: false, newVersions, teaserVersion: newVersions[0] ?? null }
}

/**
 * The three states the DEV variant control can put an install into (JOS-73's hand-test brief).
 * Pure and derived from the notes themselves, so the buttons never name a version that has been
 * deleted from the list:
 *
 *   'fresh'    — no stored key at all. No teaser, nothing marked.
 *   'previous' — stamped at the release before the newest. One release of news.
 *   'several'  — stamped several back, which is the A→D case the marking exists for.
 *
 * The fourth variant, "reset to real", is not here: it restores the value this session STARTED
 * with, which is a fact about the running app and not about the data.
 */
export type WhatsNewVariant = 'fresh' | 'previous' | 'several'

/** How far back 'several' reaches. Five releases in, so the marking has to hold a list. */
const SEVERAL_BACK = 4

export function variantLastSeen(
  variant: WhatsNewVariant,
  notes: readonly ReleaseNote[] = RELEASE_NOTES
): string | null {
  if (variant === 'fresh' || notes.length === 0) return null
  const idx = variant === 'previous' ? 1 : SEVERAL_BACK
  return notes[Math.min(idx, notes.length - 1)]?.version ?? null
}

// ---------------------------------------------------------------- validity

const VERSION_RE = /^\d+\.\d+\.\d+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const KINDS: readonly string[] = ['new', 'fixed', 'changed']

/**
 * Everything wrong with a notes list, as sentences — [] means it is sound.
 *
 * A function rather than a test body because it has TWO callers that must agree: the unit suite
 * (tests/releaseNotes.test.mts) and the release job's gate (scripts/check-release-notes.mjs).
 * A tag that ships is a tag whose notes passed the same check the suite runs.
 */
export function releaseNotesProblems(notes: readonly ReleaseNote[] = RELEASE_NOTES): string[] {
  const problems: string[] = []
  if (notes.length === 0) problems.push('the notes list is empty')
  notes.forEach((n, i) => {
    if (!VERSION_RE.test(n.version)) problems.push(`${n.version}: not a plain MAJOR.MINOR.PATCH version`)
    if (!DATE_RE.test(n.date)) problems.push(`${n.version}: date "${n.date}" is not YYYY-MM-DD`)
    if (n.entries.length === 0) problems.push(`${n.version}: no entries`)
    for (const e of n.entries) {
      if (e.text.trim() === '') problems.push(`${n.version}: an entry has no text`)
      if (e.kind !== undefined && !KINDS.includes(e.kind)) problems.push(`${n.version}: unknown kind "${e.kind}"`)
      // `fromReport: false` is not a third state — an untagged entry is simply absent, and a
      // stored `false` would read as "we checked and it wasn't a report", which is a claim this
      // file has no way to make. Present means true.
      if (e.fromReport !== undefined && !e.fromReport) {
        problems.push(`${n.version}: fromReport is a flag — set it to true or leave it out`)
      }
    }
    const prev = notes[i - 1]
    if (prev && compareVersions(prev.version, n.version) <= 0) {
      problems.push(`${n.version} must sort strictly below ${prev.version} — the list is newest first`)
    }
  })
  return problems
}

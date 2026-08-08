// TELEMETRY.md, GENERATED FROM THE SCHEMA — plan decision T4.
//
// "`TELEMETRY.md` committed in the repo enumerates every event/field/bucket, generated from the
// schema so it cannot drift (a test pins schema↔doc parity)."
//
// That is the whole reason this module exists rather than a hand-written markdown file. The
// enum members, the bucket edges and the funnel steps below are READ OUT OF `shared/telemetry.ts`
// at render time — they are never retyped here — so a schema change that is not reflected in the
// committed doc fails `tests/telemetryDoc.test.mts`, and the fix is `npm run gen:telemetry-doc`,
// never an edit to the markdown.
//
// The only hand-written content here is PROSE: what each event is for, and the promises at the
// top and bottom of the page. Prose cannot drift from the schema because it makes no claims the
// schema could contradict — every claim that could is rendered from the tables.
//
// The rows are also the completeness check: `TELEMETRY_DOC_EVENTS` must cover
// `TELEMETRY_EVENT_KINDS` exactly, which is what makes "adding an event means adding a doc row"
// a test failure rather than a good intention.

import {
  ALERT_COUNT_EDGES,
  CHAR_COUNT_EDGES,
  COLD_START_MS_EDGES,
  LOG_SIZE_BYTES_EDGES,
  MAX_TZ_OFFSET_HOURS,
  MIN_TZ_OFFSET_HOURS,
  TELEMETRY_API_VERSION,
  TELEMETRY_BUFFER_CAP,
  TELEMETRY_EVENT_KINDS,
  TELEMETRY_FAILURE_CLASSES,
  TELEMETRY_FEATURES,
  TELEMETRY_FUNNELS,
  TELEMETRY_FUNNEL_STEPS,
  TELEMETRY_OUTCOMES,
  TELEMETRY_OVERLAY_KINDS,
  TELEMETRY_UPDATE_CHANNELS,
  TELEMETRY_UPDATE_STEPS,
  TELEMETRY_VIEWS,
  TELEMETRY_VOICE_ENGINES,
  bucketRange,
  type TelemetryEventKind
} from './telemetry'

// ------------------------------------------------------------------ the tables

export interface DocField {
  name: string
  /** Rendered from the schema's own enums/edges — never a hand-typed list of values. */
  type: string
  note: string
}

export interface DocEvent {
  t: TelemetryEventKind
  when: string
  fields: DocField[]
}

export interface DocBucket {
  /** The field name the bucket index appears under. */
  field: string
  edges: readonly number[]
  format: 'count' | 'ms' | 'bytes'
  what: string
}

/** `` `a` · `b` · `c` `` — one spelling for every closed enum in the doc. */
function values(list: readonly string[]): string {
  return list.map((v) => `\`${v}\``).join(' · ')
}

const COUNT = 'whole number'
const BUCKET = 'bucket index'

/**
 * The one place the log-line counter is described, shared by both events that carry it — a
 * second copy of this sentence is a second thing to keep true.
 *
 * It says "how many, including re-reads" out loud because the number is bigger than a reader
 * would expect: the app re-reads your log's history each time it starts, and every one of those
 * lines is parsed again. The count is of PARSING WORK; nothing about a line survives it.
 */
const LINES_PARSED =
  'How many log lines were read since the last one of these. A count of lines only — no line, ' +
  'and no part of one, is ever sent. Starting the app re-reads your log history, so those ' +
  'lines are counted again each launch.'

/**
 * The startup-replay group, listed on BOTH events that can carry it — one array, spread twice, for
 * the same reason `LINES_PARSED` is one sentence: a second copy is a second thing to keep true.
 *
 * The rows are named `startup.x` because that is where they live in the payload the Preferences
 * viewer prints, and a reader comparing the two should find the same names.
 */
const STARTUP_FIELDS: DocField[] = [
  {
    name: 'startup.replayMs',
    type: `${COUNT} (optional)`,
    note: 'How long the app took to read your log history when it started.'
  },
  {
    name: 'startup.eventsReplayed',
    type: COUNT,
    note: 'How many log lines that was. A count only — no line, and no part of one, is sent.'
  },
  {
    name: 'startup.dutyPct',
    type: COUNT,
    note: 'What share of that time was spent working rather than deliberately pausing, 0–100.'
  },
  {
    name: 'startup.maxBlockMs',
    type: COUNT,
    note: 'The longest single moment the app was unresponsive while reading.'
  },
  {
    name: 'startup.blocksOver50',
    type: COUNT,
    note: 'How many of those moments were longer than 50 ms.'
  },
  {
    name: 'startup.logSizeBucket',
    type: BUCKET,
    note: 'How big the log it read is — a RANGE (see below), never the size itself.'
  }
]

/** Why the group is optional and where it appears — said once, printed on both events. */
const STARTUP_WHEN =
  'Present on the first of these that follows startup, once per launch: how long reading your ' +
  'log history took, and how smoothly. Reading a log after switching character is deliberately ' +
  'not measured.'

export const TELEMETRY_DOC_EVENTS: readonly DocEvent[] = [
  {
    t: 'sessionStart',
    when: 'Once, when the app finishes starting up.',
    fields: [
      { name: 'coldStartMsBucket', type: BUCKET, note: 'How long the app took to become usable.' }
    ]
  },
  {
    t: 'sessionHeartbeat',
    when:
      'Every 5 minutes while the app is open — the "is anyone using it right now" signal. ' +
      STARTUP_WHEN,
    fields: [
      { name: 'uptimeMs', type: COUNT, note: 'How long this session has been running.' },
      { name: 'linesParsed', type: `${COUNT} (optional)`, note: LINES_PARSED },
      ...STARTUP_FIELDS
    ]
  },
  {
    t: 'sessionEnd',
    when: `Once, when the app closes. ${STARTUP_WHEN}`,
    fields: [
      { name: 'durationMs', type: COUNT, note: 'How long the session lasted.' },
      { name: 'viewsVisited', type: COUNT, note: 'How many different tabs were opened.' },
      { name: 'linesParsed', type: `${COUNT} (optional)`, note: LINES_PARSED },
      ...STARTUP_FIELDS
    ]
  },
  {
    t: 'viewDwell',
    when: 'When you switch away from a tab.',
    fields: [
      { name: 'view', type: values(TELEMETRY_VIEWS), note: 'Which tab. A fixed list of tab names.' },
      { name: 'ms', type: COUNT, note: 'How long it was on screen.' }
    ]
  },
  {
    t: 'overlayToggle',
    when: 'When you open or close a floating meter.',
    fields: [
      { name: 'kind', type: values(TELEMETRY_OVERLAY_KINDS), note: 'Which overlay.' },
      { name: 'open', type: 'true / false', note: 'Opened or closed.' }
    ]
  },
  {
    t: 'featureUse',
    when: 'When you use one of the listed features.',
    fields: [
      { name: 'feature', type: values(TELEMETRY_FEATURES), note: 'Which one. A fixed list.' },
      { name: 'count', type: COUNT, note: 'How many times, since the last batch.' }
    ]
  },
  {
    t: 'alertFired',
    when: 'A rollup of how many alerts fired — never which alert, and never its text.',
    fields: [
      { name: 'count', type: COUNT, note: 'Alerts fired.' },
      { name: 'spokenCount', type: COUNT, note: 'How many of those were spoken aloud.' }
    ]
  },
  {
    t: 'setupSnapshot',
    when: 'Once per session: what a typical install looks like.',
    fields: [
      { name: 'charCountBucket', type: BUCKET, note: 'How many character logs the app can see.' },
      { name: 'logSizeBucket', type: BUCKET, note: 'How big the log it reads is.' },
      { name: 'alertCountBucket', type: BUCKET, note: 'How many alerts you keep.' },
      {
        name: 'overlaysEnabled',
        type: `list of ${values(TELEMETRY_OVERLAY_KINDS)}`,
        note: 'Which floating meters are open.'
      },
      { name: 'cursorRing', type: 'true / false', note: 'Is the cursor ring on.' },
      { name: 'autoHide', type: 'true / false', note: 'Is overlay auto-hide on.' },
      {
        name: 'voiceEngine',
        type: values(TELEMETRY_VOICE_ENGINES),
        note: 'Which speech tier your spoken alerts use — off when no alert is set to speak.'
      },
      { name: 'soundPackCount', type: COUNT, note: 'How many sound packs are installed.' },
      { name: 'updateChannel', type: values(TELEMETRY_UPDATE_CHANNELS), note: 'Update channel.' }
    ]
  },
  {
    t: 'funnelStep',
    when: 'When you reach a step of one of the three flows listed below.',
    fields: [
      { name: 'funnel', type: values(TELEMETRY_FUNNELS), note: 'Which flow.' },
      { name: 'step', type: 'a step of that flow (below)', note: 'Which step it reached.' },
      { name: 'outcome', type: `${values(TELEMETRY_OUTCOMES)} (optional)`, note: 'How it ended.' },
      {
        name: 'failureClass',
        type: `${values(TELEMETRY_FAILURE_CLASSES)} (optional)`,
        note: 'A coarse category when it failed. Never an error message.'
      }
    ]
  },
  {
    t: 'healthCounters',
    // The cadence is stated exactly, because it is what a reader would otherwise get wrong: this
    // rides the session reports (every 5 minutes, and again at close) rather than arriving once,
    // and it is sent even when every count is zero. A report with nothing in it is how we know a
    // build is reporting at all — without it, a version that is running fine and a version too old
    // to have this code would look identical.
    when: 'With each session report (every few minutes, and at close): counts of things that went wrong since the last one. Sent even when they are all zero. Counts only, never messages.',
    fields: [
      { name: 'rendererCrashes', type: COUNT, note: 'Window crashes. The main window only.' },
      { name: 'mainErrorLogLines', type: COUNT, note: 'Lines written to the local error log.' },
      // SAID OUT LOUD rather than left as an implied zero: nothing in the app detects a stall, so
      // this field reports 0 from every client and means "not measured". A note claiming it counts
      // stalls would be a promise the code does not keep.
      { name: 'parserStalls', type: COUNT, note: 'Times log reading stalled. Not currently measured — always 0.' },
      { name: 'presenceRestarts', type: COUNT, note: 'Times the game-window watcher restarted.' },
      { name: 'speechFailures', type: COUNT, note: 'Times an utterance failed to speak. Downloaded voices only.' }
    ]
  },
  {
    t: 'updateOutcome',
    when: 'When an app update is checked for, downloaded, or applied.',
    fields: [
      { name: 'step', type: values(TELEMETRY_UPDATE_STEPS), note: 'Which step.' },
      { name: 'ok', type: 'true / false', note: 'Did it succeed.' },
      {
        name: 'failureClass',
        type: `${values(TELEMETRY_FAILURE_CLASSES)} (optional)`,
        note: 'A coarse category when it failed.'
      }
    ]
  }
]

export const TELEMETRY_DOC_BUCKETS: readonly DocBucket[] = [
  {
    field: 'coldStartMsBucket',
    edges: COLD_START_MS_EDGES,
    format: 'ms',
    what: 'How long the app took to start.'
  },
  {
    field: 'charCountBucket',
    edges: CHAR_COUNT_EDGES,
    format: 'count',
    what: 'How many character logs the app can see.'
  },
  {
    field: 'logSizeBucket',
    edges: LOG_SIZE_BYTES_EDGES,
    format: 'bytes',
    what: 'Size of the log file being read.'
  },
  {
    field: 'alertCountBucket',
    edges: ALERT_COUNT_EDGES,
    format: 'count',
    what: 'How many alerts are configured.'
  }
]

// ------------------------------------------------------------------ rendering

function fmtBytes(n: number): string {
  const mb = n / 1_048_576
  return mb >= 1024 ? `${String(Math.round(mb / 1024))} GB` : `${String(Math.round(mb))} MB`
}

function fmtValue(n: number, format: DocBucket['format']): string {
  if (format === 'bytes') return fmtBytes(n)
  if (format === 'ms') return n >= 1000 ? `${String(n / 1000)} s` : `${String(n)} ms`
  return String(n)
}

/**
 * Every range a bucket index can mean: `< 1 s` · `1 s – 2.5 s` · `≥ 20 s`.
 *
 * Ranges are half-open `[lo, hi)`. For a COUNT that reads wrong ("1 – 2" for a bucket that only
 * ever holds 1), so counts print the inclusive integer span instead — `1`, `3 – 4`, `≥ 9`.
 */
function bucketLabels(b: DocBucket): string[] {
  const out: string[] = []
  for (let i = 0; i <= b.edges.length; i++) {
    const { lo, hi } = bucketRange(b.edges, i)
    if (hi === null) out.push(`≥ ${fmtValue(lo, b.format)}`)
    else if (b.format !== 'count') out.push(i === 0 ? `< ${fmtValue(hi, b.format)}` : `${fmtValue(lo, b.format)} – ${fmtValue(hi, b.format)}`)
    else out.push(hi - lo === 1 ? String(lo) : `${String(lo)} – ${String(hi - 1)}`)
  }
  return out
}

function eventSection(e: DocEvent): string[] {
  const lines = [`### \`${e.t}\``, '', e.when, '', '| Field | Values | What it means |', '| --- | --- | --- |']
  for (const f of e.fields) lines.push(`| \`${f.name}\` | ${f.type} | ${f.note} |`)
  lines.push('')
  return lines
}

function bucketSection(): string[] {
  const lines = [
    '## Buckets',
    '',
    'Where a raw number would say too much about one person, the app sends a RANGE instead.',
    'These are the exact ranges, taken from the schema:',
    ''
  ]
  for (const b of TELEMETRY_DOC_BUCKETS) {
    lines.push(`**\`${b.field}\`** — ${b.what}`, '')
    lines.push('| Bucket | Range |', '| --- | --- |')
    bucketLabels(b).forEach((label, i) => lines.push(`| ${String(i)} | ${label} |`))
    lines.push('')
  }
  return lines
}

function funnelSection(): string[] {
  const lines = [
    '## Flows',
    '',
    'A `funnelStep` event says which step of one of these you reached — nothing else.',
    ''
  ]
  for (const funnel of TELEMETRY_FUNNELS) {
    lines.push(`**\`${funnel}\`** — ${TELEMETRY_FUNNEL_STEPS[funnel].map((s) => `\`${s}\``).join(' → ')}`, '')
  }
  return lines
}

function headerSection(): string[] {
  return [
    '# What this app measures',
    '',
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Rendered from src/shared/telemetry.ts by `npm run gen:telemetry-doc`.',
    '     tests/telemetryDoc.test.mts fails if this file and the schema disagree. -->',
    '',
    'EQ Legends Companion can send anonymous usage counts so the person building it can see',
    'which parts are used and which parts break. It is **on by default**, you are asked about',
    'it the first time you run the app, and you can turn it off at any time in',
    '**Preferences → Usage analytics** — where you can also read the exact events waiting to be',
    'sent, as JSON.',
    '',
    '**This build does send.** The counts on this page go to one address, run by the person who',
    'builds this app, in an account used for nothing else — the address is compiled in, and',
    'nothing in your settings, in the app, or on disk can point it somewhere else. Nothing is',
    'sent before the notice on your first run has appeared, and turning this off deletes',
    'everything waiting to be sent **and** your anonymous id, straight away. Preferences shows',
    'you the last batch that actually left, in full.',
    '',
    '## What can never be collected',
    '',
    'Not "what we choose not to collect" — what the schema has no room for. Every field below',
    'is either a number or one value from a fixed list printed on this page. There is no',
    'free-text field anywhere in it, so there is nowhere for any of this to go:',
    '',
    '- your character names, your server, your guild, anyone you play with',
    '- zone, mob, spell, item or quest names',
    '- anything you typed: chat, tells, search boxes, alert names, feedback text',
    '- any line of your log, or any file path',
    '- your IP address, your machine name, your account — there is no account',
    '',
    '## What identifies a send',
    '',
    'One random id (`analyticsId`), generated on your machine, stored in your settings file, and',
    'deliberately **different from** the id a feedback report uses — the two cannot be joined.',
    'You can replace it at any time from Preferences; doing so also throws away everything',
    'waiting to be sent, and the new id looks like a brand-new install.',
    '',
    '| Field | Values |',
    '| --- | --- |',
    '| `analyticsId` | a random UUID, replaceable from Preferences |',
    '| `appVersion` | the app version, e.g. `0.2.0` |',
    `| \`channel\` | ${values(['prod', 'dev'])} |`,
    '| `platform` | `win32` · `darwin` · `linux` · `other` |',
    `| \`tzOffsetBucket\` | your UTC offset in whole hours (${String(MIN_TZ_OFFSET_HOURS)} to ${String(MAX_TZ_OFFSET_HOURS)}) |`,
    '',
    `Events are held on your machine (at most ${String(TELEMETRY_BUFFER_CAP)} of them, oldest dropped first) and would`,
    'be sent in batches, not one by one. Schema version: ' + String(TELEMETRY_API_VERSION) + '.',
    '',
    '## Events',
    ''
  ]
}

function footerSection(): string[] {
  return [
    '## Turning it off',
    '',
    '**Preferences → Usage analytics** has one switch. Turning it off stops collection, throws',
    'away everything currently held on your machine, and discards the random id — all',
    'immediately. Nothing is kept to be sent later. Turning it back on starts from empty, with a',
    'new id, which counts as a brand-new install.',
    ''
  ]
}

/** The whole page. Deterministic: same schema in, byte-identical markdown out. */
export function renderTelemetryDoc(): string {
  const lines = [...headerSection()]
  for (const e of TELEMETRY_DOC_EVENTS) lines.push(...eventSection(e))
  lines.push(...funnelSection(), ...bucketSection(), ...footerSection())
  return lines.join('\n')
}

/** Event kinds the doc covers, in doc order — the completeness check's left-hand side. */
export const DOC_EVENT_KINDS: readonly TelemetryEventKind[] = TELEMETRY_DOC_EVENTS.map((e) => e.t)

/** True when the doc describes exactly the schema's event union — no extras, no omissions. */
export function docCoversSchema(): boolean {
  return (
    DOC_EVENT_KINDS.length === TELEMETRY_EVENT_KINDS.length &&
    TELEMETRY_EVENT_KINDS.every((k, i) => DOC_EVENT_KINDS[i] === k)
  )
}

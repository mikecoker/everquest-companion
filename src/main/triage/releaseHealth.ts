// ============================================================================
// releaseHealth.ts — "did I release buggy code", answered honestly (JOS-96).
// ============================================================================
//
// PURE, like `./analytics.ts` beside it, which is where it is called from. It is its own file
// rather than a seventh section in that one for the repo's usual reason: analytics.ts is at the
// 400-code-line ceiling and a split is the answer to that, not a widened threshold.
//
// ---------------------------------------------------------------------------------------
// THE QUESTION, AND WHY IT NEEDS FOUR DIFFERENT SOURCES
// ---------------------------------------------------------------------------------------
// An error count on its own answers nothing. Ten crashes on a build a hundred people run is a
// better week than two on a build three people run, and neither number means anything without
// knowing when the build went out. So the readout puts four things on one time base:
//
//   1. ERROR RATE — `health` / `healthReports`, both dimmed by version. SELF-NORMALIZING at one
//      version: it is errors per reporting session ON THAT BUILD, so popularity cannot masquerade
//      as bugginess.
//   2. ADOPTION — the `version` envelope fact, which every client has sent since the endpoint was
//      lit. This is why the adoption curve runs back through history while the error curve
//      begins the day a capable client shipped, and the two being different lengths is
//      information rather than a defect.
//   3. RELEASE DATES — `RELEASE_NOTES`, committed source. The marker that turns "errors went up
//      on the 6th" into "errors went up the day 0.9.0 shipped".
//   4. BUG REPORTS — the feedback table's `app_version`. A different KIND of evidence (a human
//      was annoyed enough to type something) and never added to the error counts, but it is the
//      ONLY signal that exists for builds predating health reporting, which makes it the thing
//      that keeps this section useful during the rollout instead of after it.
//
// ---------------------------------------------------------------------------------------
// THE HOUSE RULE: A QUIET VERSION IS NOT A CLEAN VERSION
// ---------------------------------------------------------------------------------------
// This is the failure mode the whole design is bent around. Health reporting arrives in a build;
// every build before it sends nothing. To a SUM, "sent nothing" and "sent reports and found no
// errors" are the same absent row — so the naive rendering of this panel would show every
// historical release as a flawless one, which is the exact opposite of the truth (they are the
// builds we know least about).
//
// Three mechanisms keep them apart, and none of them is a label:
//
//   * `reporting` is derived from the DENOMINATOR (`healthReports` at that version), never from
//     the error counts. A build with zero errors still has a denominator; a build that predates
//     the client has none. That is a structural difference, not an interpretive one.
//   * `rate` is NULL rather than 0 when nothing reported. `ratio()` already refuses a zero
//     denominator for exactly this reason, and every renderer in this codebase draws a null as a
//     dash rather than as a good number.
//   * COVERAGE is computed and surfaced: what share of the fleet, day by day, was on a build that
//     could report at all. It is the honesty meter for everything else on the chart — an error
//     curve at 20% coverage is a rumour, and the reader can see that it is.

import { compareVersions, RELEASE_NOTES } from '../../shared/releaseNotes'
import { DIM_NONE, USAGE_METRICS } from '../../shared/telemetryRollup'
import type {
  TriageAnalyticsReleaseHealth,
  TriageMixRow,
  TriageReleaseCoverageDay,
  TriageReleaseHealthDay,
  TriageReleaseHealthVersion
} from '../../shared/triage'
import { dimsOf, mixRows, ratio, type BugReportRow, type UsageRow } from './usageRows'

/** Builds shown. The funnel and startup sections' own cap, plus a little: this table deliberately
 *  includes NON-reporting builds, and those are exactly the historical ones. */
const MAX_RELEASE_VERSIONS = 8

/** `version -> release date`, from committed source. Built once at module load — `RELEASE_NOTES`
 *  is a frozen literal and cannot change while the process runs. */
const RELEASE_DATES: ReadonlyMap<string, string> = new Map(
  RELEASE_NOTES.map((n) => [n.version, n.date])
)

/**
 * A `<version>:<field>` dim, split back into its two halves — or null when the dim carries no
 * colon at all.
 *
 * THE VERSION IS EVERYTHING BEFORE THE LAST COLON, which is `startupHistogram`'s rule in
 * analytics.ts and is chosen for the same reason: a semver's prerelease tail cannot contain a
 * colon, so reading from the right is free and cannot be wrong, while reading from the left would
 * break the day a version string grows one.
 *
 * NULL IS THE OLD ENCODING. Before JOS-96 the dim was a bare field name, and while no client ever
 * emitted the event (so no such row exists in the live table), a row folded by an ingest Lambda
 * that has not yet been redeployed WILL land in that shape. Those rows are skipped here rather
 * than guessed at: attributing them to a version we do not know would be an invention, and they
 * still show up correctly in the fleet-wide Health section, which does not need a version.
 */
function splitHealthDim(dim: string): { version: string; field: string } | null {
  const cut = dim.lastIndexOf(':')
  if (cut <= 0 || cut === dim.length - 1) return null
  return { version: dim.slice(0, cut), field: dim.slice(cut + 1) }
}

/** `day -> n`, for one metric, optionally restricted to one dim. */
function byDay(rows: readonly UsageRow[], metric: string, dim?: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    if (r.metric !== metric) continue
    if (dim !== undefined && r.dim !== dim) continue
    out.set(r.day, (out.get(r.day) ?? 0) + r.n)
  }
  return out
}

/** `day -> summed error count`, for one version, across all five fields. */
function errorsByDay(rows: readonly UsageRow[], version: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    if (r.metric !== USAGE_METRICS.health) continue
    const split = splitHealthDim(r.dim)
    if (split?.version !== version) continue
    out.set(r.day, (out.get(r.day) ?? 0) + r.n)
  }
  return out
}

/** One version's error mix, with the `<version>:` prefix stripped back off the ids. */
function fieldsOf(rows: readonly UsageRow[], version: string): TriageMixRow[] {
  const counts = new Map<string, number>()
  for (const [dim, n] of dimsOf(rows, USAGE_METRICS.health)) {
    const split = splitHealthDim(dim)
    if (split?.version !== version) continue
    counts.set(split.field, (counts.get(split.field) ?? 0) + n)
  }
  return mixRows(counts)
}

/**
 * The day-by-day vertices for one build.
 *
 * DENSE OVER THE WINDOW, like every other series here (`seriesOf`'s rule): a day this build had
 * nobody on it is a zero, not a gap, so the adoption curves of two builds can be read against
 * each other and against the release markers without anything sliding.
 *
 * `rate` is null on a day this build filed no report — including days it was plainly running,
 * because a build with users but no health reports is precisely the not-reporting case and a 0
 * there would be a fabricated clean bill of health for that day.
 */
function daysOf(
  version: string,
  rows: readonly UsageRow[],
  days: readonly string[],
  activeByDay: Map<string, number>
): TriageReleaseHealthDay[] {
  const reports = byDay(rows, USAGE_METRICS.healthReports, version)
  const errors = errorsByDay(rows, version)
  const actives = byDay(rows, USAGE_METRICS.version, version)
  return days.map((day) => {
    const n = reports.get(day) ?? 0
    const active = actives.get(day) ?? 0
    return {
      day,
      reports: n,
      errors: errors.get(day) ?? 0,
      rate: ratio(errors.get(day) ?? 0, n),
      active,
      share: ratio(active, activeByDay.get(day) ?? 0) ?? 0
    }
  })
}

function versionRow(
  version: string,
  rows: readonly UsageRow[],
  bugs: Map<string, number>,
  ctx: { days: readonly string[]; activeByDay: Map<string, number>; reports: Map<string, number> }
): TriageReleaseHealthVersion {
  const reports = ctx.reports.get(version) ?? 0
  const byField = fieldsOf(rows, version)
  const errors = byField.reduce((sum, f) => sum + f.n, 0)
  const perDay = daysOf(version, rows, ctx.days, ctx.activeByDay)
  return {
    version,
    releaseDate: RELEASE_DATES.get(version) ?? null,
    // THE DENOMINATOR DECIDES, not the errors. A build that reported and found nothing wrong is
    // `reporting: true, errors: 0` — a true zero — and a build that predates the emitting client
    // is `reporting: false, rate: null`. Deriving this from `errors > 0` would merge them.
    reporting: reports > 0,
    reports,
    errors,
    rate: ratio(errors, reports),
    byField,
    bugReports: bugs.get(version) ?? 0,
    peakShare: perDay.reduce((max, d) => (d.share > max ? d.share : max), 0),
    days: perDay
  }
}

/**
 * HOW MUCH OF THE FLEET COULD HAVE TOLD US, day by day.
 *
 * `covered` counts active installs on builds that reported health SOMEWHERE IN THE WINDOW, not
 * on that particular day. The looser reading is the right one: a build is either capable of
 * reporting or it is not — that is a property of the code in it — and a capable build that
 * happened to file nothing on a Tuesday is a real (and interesting) zero rather than a hole in
 * the instrument. The stricter reading would make coverage dip every quiet day and would say the
 * measurement had degraded when only the traffic had.
 */
function coverageOf(
  rows: readonly UsageRow[],
  days: readonly string[],
  activeByDay: Map<string, number>,
  reportingVersions: ReadonlySet<string>
): TriageReleaseCoverageDay[] {
  const coveredByDay = new Map<string, number>()
  for (const r of rows) {
    if (r.metric !== USAGE_METRICS.version || !reportingVersions.has(r.dim)) continue
    coveredByDay.set(r.day, (coveredByDay.get(r.day) ?? 0) + r.n)
  }
  return days.map((day) => {
    const active = activeByDay.get(day) ?? 0
    const covered = coveredByDay.get(day) ?? 0
    return { day, covered, active, share: ratio(covered, active) }
  })
}

/**
 * The whole section. Pure over the rows it is handed, so `tests/usageAnalytics.test.mts` can
 * author a fleet by hand — including the awkward populations (a build that reported nothing, a
 * build that reported and was clean) that the panel's honesty depends on telling apart.
 */
export function buildReleaseHealth(
  usage: readonly UsageRow[],
  bugReports: readonly BugReportRow[],
  days: readonly string[]
): TriageAnalyticsReleaseHealth {
  // DIM_NONE IS NOT A VERSION, and dropping it is a deploy-skew guard rather than tidiness.
  // `healthReports` used to be written with no dimension at all, so an ingest Lambda that has not
  // yet been redeployed folds this client's reports under `-`. Left in, that row would render as
  // a BUILD LITERALLY NAMED `-` claiming to be reporting — the one thing this section must never
  // produce, since it would be an entirely fictional version sitting in the coverage numerator.
  // Skipped, the same skew degrades the honest way: those reports are invisible here until the
  // deploy lands, and the section says "not reporting", which is exactly true of what it can see.
  const reports = new Map(
    [...dimsOf(usage, USAGE_METRICS.healthReports)].filter(([dim]) => dim !== DIM_NONE)
  )
  const activeByDay = byDay(usage, USAGE_METRICS.activeInstalls)
  const bugs = new Map<string, number>()
  for (const b of bugReports) bugs.set(b.appVersion, (bugs.get(b.appVersion) ?? 0) + b.n)
  // THE UNION OF EVERY BUILD ANY SOURCE KNOWS ABOUT. A build can appear in adoption without ever
  // reporting health (the historical case, and the one this section exists to render honestly),
  // in health without adoption (a client whose first batch of the day was not its envelope one),
  // or in the feedback table alone (somebody filed a bug from a build nobody else ran that week).
  // Dropping any of those would quietly shorten the history the release markers are read against.
  const names = new Set<string>([
    ...dimsOf(usage, USAGE_METRICS.version).keys(),
    ...reports.keys(),
    ...bugs.keys()
  ])
  const reportingVersions = new Set([...reports].filter(([, n]) => n > 0).map(([v]) => v))
  const coverage = coverageOf(usage, days, activeByDay, reportingVersions)
  const totalActive = coverage.reduce((sum, c) => sum + c.active, 0)
  return {
    versions: [...names]
      .sort((a, b) => compareVersions(b, a))
      .slice(0, MAX_RELEASE_VERSIONS)
      .map((version) => versionRow(version, usage, bugs, { days, activeByDay, reports })),
    coverage,
    coverageShare: ratio(
      coverage.reduce((sum, c) => sum + c.covered, 0),
      totalActive
    ),
    anyReporting: reportingVersions.size > 0
  }
}

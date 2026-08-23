import type { CloudSyncState } from '../../../../src/shared/cloudSync'

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function age(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ago`
}

function CharacterCard({ character }: { character: CloudSyncState['character'] }): React.JSX.Element {
  const classes = character.classes.length === 0 ? 'Unknown class' : character.classes.join(' / ')
  return <section className="hero card" aria-labelledby="character-heading">
    <div><p className="eyebrow">Active character</p><h2 id="character-heading">{character.name}</h2>
      <p>{character.server} · Level {character.level ?? '—'} · {classes}</p></div>
    <span className="zone">{character.zone ?? 'Unknown zone'}</span>
  </section>
}

function CombatCard({ combat }: { combat: CloudSyncState['combat'] }): React.JSX.Element {
  return <section className="card combat" aria-labelledby="combat-heading">
    <div className="section-title"><div><p className="eyebrow">Encounter</p><h2 id="combat-heading">{combat.target ?? 'No active target'}</h2></div>
      <span className={`status ${combat.inCombat ? 'hot' : ''}`}>{combat.inCombat ? 'In combat' : 'Resting'}</span></div>
    <div className="metrics"><div><strong>{compact(combat.totalDamage)}</strong><span>Total damage</span></div><div><strong>{compact(combat.dps)}</strong><span>DPS</span></div></div>
    <ol className="dps-list" aria-label="Damage leaders">{combat.rows.slice(0, 20).map((row, index) => <li key={`${row.name}-${index}`}>
      <span className={`kind kind-${row.kind}`} aria-hidden="true" /><span className="rank">{index + 1}</span><span className="combatant">{row.name}</span><strong>{compact(row.dps)} DPS</strong>
    </li>)}</ol>
  </section>
}

function ProgressionCard({ character, progression }: Pick<CloudSyncState, 'character' | 'progression'>): React.JSX.Element {
  const percent = progression?.percent
  return <section className="card progression" aria-labelledby="progress-heading">
    <p className="eyebrow">Progression</p><h2 id="progress-heading">Level {progression?.level ?? character.level ?? '—'}</h2>
    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0}><span style={{ width: `${percent ?? 0}%` }} /></div>
    <div className="metrics"><div><strong>{percent === undefined ? '—' : `${percent.toFixed(1)}%`}</strong><span>XP</span></div><div><strong>{progression ? `${progression.xpPerHour.toFixed(1)}%` : '—'}</strong><span>per hour</span></div><div><strong>{duration(progression?.etaMs)}</strong><span>to level</span></div></div>
  </section>
}

interface RecentActivity {
  key: string
  kind: 'Kill' | 'Loot'
  label: string
  ts: number
}

function recentActivity(recent: CloudSyncState['recent']): RecentActivity[] {
  const kills = recent.kills.map((kill, index) => ({
    key: `kill-${kill.name}-${index}`, kind: 'Kill' as const, label: kill.name, ts: kill.ts
  }))
  const loot = recent.loot.map((item, index) => ({
    key: `loot-${item.item}-${index}`,
    kind: 'Loot' as const,
    label: `${item.quantity !== undefined && item.quantity > 1 ? `${item.quantity}× ` : ''}${item.item}`,
    ts: item.ts
  }))
  return [...kills, ...loot].sort((left, right) => right.ts - left.ts).slice(0, 10)
}

function RecentCard({ recent, now }: { recent: CloudSyncState['recent']; now: number }): React.JSX.Element {
  const activity = recentActivity(recent)
  return <section className="card recent" aria-labelledby="recent-heading">
    <p className="eyebrow">Latest activity</p><h2 id="recent-heading">Recent</h2>
    {activity.length === 0
      ? <p className="muted recent-empty">No recent kills or loot.</p>
      : <ul className="recent-feed" aria-label="Latest kills and loot">{activity.map((item) => <li key={item.key}>
        <span className={`activity-kind ${item.kind.toLowerCase()}`}>{item.kind}</span>
        <span className="activity-name" title={item.label}>{item.label}</span>
        <time>{age(item.ts, now)}</time>
      </li>)}</ul>}
  </section>
}

export function LiveDashboard({ state, now }: { state: CloudSyncState; now: number }): React.JSX.Element {
  return <div className="dashboard" data-layout="responsive"><CharacterCard character={state.character} />
    <CombatCard combat={state.combat} /><ProgressionCard character={state.character} progression={state.progression} />
    <RecentCard recent={state.recent} now={now} /></div>
}

import { useMemo, useState } from 'react'
import type {
  CloudRoomEncounter,
  CloudRoomParticipant,
  CloudRoomSnapshot
} from '../../../../src/shared/cloudRoom'
import { LiveDashboard } from './LiveDashboard'

export type RoomTab = 'encounters' | 'players' | 'setup'

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function encounterTime(encounter: CloudRoomEncounter): string {
  return encounter.active ? 'Active now' : new Date(encounter.startedAt).toLocaleTimeString([], {
    hour: 'numeric', minute: '2-digit'
  })
}

function EncounterDetail({ encounter }: { encounter: CloudRoomEncounter }): React.JSX.Element {
  return <section className="card room-encounter-detail" aria-labelledby="room-encounter-heading">
    <div className="section-title"><div><p className="eyebrow">{encounter.active ? 'Active encounter' : 'Completed encounter'}</p>
      <h2 id="room-encounter-heading">{encounter.target}</h2><p className="muted">{encounter.zone ?? 'Unknown zone'} · {clock(encounter.durationSec)}</p></div>
      <span className={`status ${encounter.active ? 'hot' : ''}`}>{encounter.active ? 'Live' : encounterTime(encounter)}</span></div>
    <div className="metrics room-metrics"><div><strong>{compact(encounter.totalDamage)}</strong><span>Group damage</span></div>
      <div><strong>{compact(encounter.dps)}</strong><span>Group DPS</span></div><div><strong>{encounter.participants.length}</strong><span>Contributors</span></div></div>
    <ol className="dps-list" aria-label="Room damage leaders">{encounter.participants.map((row, index) => <li key={row.participantId}>
      <span className="kind kind-party" aria-hidden="true" /><span className="rank">{index + 1}</span>
      <span className="combatant">{row.characterName}</span><strong>{compact(row.dps)} DPS · {compact(row.totalDamage)}</strong>
    </li>)}</ol>
  </section>
}

function EncounterList({ encounters, selected, choose }: {
  encounters: CloudRoomEncounter[]
  selected?: string
  choose: (id: string) => void
}): React.JSX.Element {
  return <aside className="card encounter-list" aria-label="Encounter history"><p className="eyebrow">Room history</p><h2>Encounters</h2>
    {encounters.length === 0 ? <p className="muted">No encounters have been published to this room yet.</p> : <ol>{encounters.map((encounter) => <li key={encounter.id}>
      <button className={selected === encounter.id ? 'selected' : ''} onClick={() => choose(encounter.id)}>
        <span><strong>{encounter.target}</strong><small>{encounterTime(encounter)} · {clock(encounter.durationSec)}</small></span>
        <b>{compact(encounter.dps)} DPS</b>
      </button></li>)}</ol>}
  </aside>
}

function EncountersTab({ room }: { room: CloudRoomSnapshot }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>()
  const selected = room.encounters.find((encounter) => encounter.id === selectedId) ?? room.encounters[0]
  return <div className="encounters-layout">
    <EncounterList encounters={room.encounters} selected={selected?.id} choose={setSelectedId} />
    {selected === undefined
      ? <section className="card room-empty"><h2>Waiting for the first encounter</h2><p>Connected desktops will contribute their character and owned-pet damage here.</p></section>
      : <EncounterDetail encounter={selected} />}
  </div>
}

function PlayerChooser({ participants, selected, choose }: {
  participants: CloudRoomParticipant[]
  selected?: string
  choose: (id: string) => void
}): React.JSX.Element {
  return <aside className="card player-list" aria-label="Connected players"><p className="eyebrow">Room roster</p><h2>Players</h2>
    <ul>{participants.map((participant) => <li key={participant.participantId}><button
      className={selected === participant.participantId ? 'selected' : ''}
      onClick={() => choose(participant.participantId)}>
      <span className={`presence-dot ${participant.online ? 'online' : ''}`} />
      <span><strong>{participant.state?.character.name ?? participant.displayName}</strong>
        <small>{participant.state !== undefined && participant.state.character.classes.length > 0
          ? participant.state.character.classes.join(' / ')
          : participant.online ? 'Connected' : 'Offline'}</small></span>
    </button></li>)}</ul>
  </aside>
}

function PlayerDetail({ participant, now }: { participant?: CloudRoomParticipant; now: number }): React.JSX.Element {
  if (participant?.state === undefined) {
    return <section className="card room-empty"><h2>{participant?.displayName ?? 'Select a player'}</h2>
      <p>{participant === undefined ? 'Choose someone in the roster to inspect their shared data.' : 'This player has not published desktop data yet.'}</p></section>
  }
  return <div className="player-detail"><div className="player-detail-heading"><p className="eyebrow">Shared by {participant.displayName}</p>
    <span className={`status ${participant.online ? 'hot' : ''}`}>{participant.online ? 'Publishing' : 'Offline'}</span></div>
    <LiveDashboard state={participant.state} now={now} /></div>
}

function PlayersTab({ room, now }: { room: CloudRoomSnapshot; now: number }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>()
  const selected = useMemo(
    () => room.participants.find((participant) => participant.participantId === selectedId) ?? room.participants[0],
    [room.participants, selectedId]
  )
  return <div className="players-layout"><PlayerChooser participants={room.participants} selected={selected?.participantId} choose={setSelectedId} />
    <PlayerDetail participant={selected} now={now} /></div>
}

export function RoomDashboard({ room, now, setup }: {
  room: CloudRoomSnapshot
  now: number
  setup: React.ReactNode
}): React.JSX.Element {
  const [tab, setTab] = useState<RoomTab>('encounters')
  return <><nav className="room-tabs" aria-label="Shared room views">
    {(['encounters', 'players', 'setup'] as const).map((value) => <button key={value} className={tab === value ? 'selected' : ''}
      aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}>{value[0]?.toUpperCase()}{value.slice(1)}</button>)}
  </nav>
  {tab === 'encounters' && <EncountersTab room={room} />}
  {tab === 'players' && <PlayersTab room={room} now={now} />}
  {tab === 'setup' && <div className="setup-layout">{setup}</div>}
  </>
}

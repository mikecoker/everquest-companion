import { useCallback, useEffect, useReducer, useState } from 'react'
import type { ActivityApi, ViewerAccount } from './api'
import { createActivityApi } from './api'
import { RoomDashboard } from './components/RoomDashboard'
import { createDiscordAdapter, type DiscordAdapter } from './discord'
import { activityReducer, initialState } from './model'
import type { ActivityAction, ActivityState } from './model'
import { browserDelay, runViewerTransport, type SocketLike } from './transport'

export interface AppDeps {
  clientId?: string
  discord?(clientId: string): DiscordAdapter
  api: ActivityApi
  socket(url: string): SocketLike
  now(): number
  delay(ms: number, signal: AbortSignal): Promise<void>
  random(): number
}

export const browserDeps: AppDeps = {
  clientId: import.meta.env.VITE_DISCORD_CLIENT_ID,
  discord: createDiscordAdapter,
  api: createActivityApi(),
  socket: (url) => new WebSocket(url),
  now: Date.now,
  delay: browserDelay,
  random: Math.random
}

function ErrorPanel({ title, message, retry }: { title: string; message: string; retry?: () => void }): React.JSX.Element {
  return <main className="center-shell"><section className="state-card" role="alert"><span className="state-icon">!</span><h1>{title}</h1><p>{message}</p>{retry && <button onClick={retry}>Try again</button>}</section></main>
}

async function awaitDiscord(discord: DiscordAdapter, deps: AppDeps, signal: AbortSignal): Promise<void> {
  await Promise.race([
    discord.ready(),
    deps.delay(8_000, signal).then(() => { throw new Error('Discord did not respond. Open this Activity from a Discord voice channel and try again.') })
  ])
}

function useAuthentication(deps: AppDeps, attempt: number, dispatch: React.Dispatch<ActivityAction>): void {
  useEffect(() => {
    const controller = new AbortController()
    const authenticate = async (): Promise<void> => {
      if (!deps.clientId || !deps.discord) throw new Error('Open this Activity inside Discord to connect.')
      const discord = deps.discord(deps.clientId)
      await awaitDiscord(discord, deps, controller.signal)
      const code = await discord.authorize(deps.clientId)
      const accessToken = await deps.api.exchangeOAuthCode(code)
      await discord.authenticate(accessToken)
      const account = await deps.api.loadMe()
      if (!controller.signal.aborted) dispatch({ type: 'account', account })
    }
    void authenticate().catch((error: unknown) => {
      if (!controller.signal.aborted) dispatch({ type: 'error', message: error instanceof Error ? error.message : 'Authentication failed.' })
    })
    return () => controller.abort()
  }, [attempt, deps, dispatch])
}

function useRoomTransport(deps: AppDeps, roomId: string | undefined, dispatch: React.Dispatch<ActivityAction>): void {
  useEffect(() => {
    if (roomId === undefined) return
    const controller = new AbortController()
    void runViewerTransport({ ...deps, dispatch }, controller.signal)
    return () => controller.abort()
  }, [deps, dispatch, roomId])
}

function useAccountRefreshOnPublish(state: ActivityState, deps: AppDeps, dispatch: React.Dispatch<ActivityAction>): void {
  const accountId = state.account?.user.id
  const ownPublisherOnline = state.room?.participants.some(
    (participant) => participant.participantId === accountId && participant.online
  ) ?? false
  useEffect(() => {
    if (!ownPublisherOnline || state.account?.paired !== false) return
    void deps.api.loadMe().then((account) => dispatch({ type: 'account', account })).catch(() => undefined)
  }, [deps.api, dispatch, ownPublisherOnline, state.account?.paired])
}

interface AsyncActions {
  busy: boolean
  error?: string
  run(action: () => Promise<void>): void
}

function useAsyncActions(): AsyncActions {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try { await action() } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change failed.')
    } finally { setBusy(false) }
  }, [])
  return { busy, ...(error === undefined ? {} : { error }), run: (action) => { void run(action) } }
}

function RoomLobby({ deps, dispatch }: { deps: AppDeps; dispatch: React.Dispatch<ActivityAction> }): React.JSX.Element {
  const [name, setName] = useState('EQ Legends Party')
  const [code, setCode] = useState('')
  const actions = useAsyncActions()
  const refresh = async (roomCode?: string): Promise<void> => {
    dispatch({ type: 'account', account: await deps.api.loadMe(), ...(roomCode === undefined ? {} : { roomCode }) })
  }
  const create = (): void => actions.run(async () => {
    const created = await deps.api.createRoom(name.trim())
    await refresh(created.code)
  })
  const join = (): void => actions.run(async () => {
    await deps.api.joinRoom(code.trim())
    await refresh()
  })
  return <main className="center-shell"><section className="state-card room-lobby"><p className="eyebrow">EQ Legends Live</p><h1>Join your group</h1>
    <p>Ask the person hosting for their room code. Joining lets you see the room immediately; pairing your desktop is optional.</p>
    <label>Room code<input autoFocus value={code} placeholder="XXXX-XXXX-XXXX" onChange={(event) => setCode(event.target.value.toUpperCase())} /></label>
    <button disabled={actions.busy || code.trim() === ''} onClick={join}>Join with code</button>
    <div className="lobby-divider"><span>Hosting the group?</span></div>
    <div className="host-option"><p>Create one room, then share its code with everyone else.</p>
      <label>Room name<input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} /></label>
      <button className="secondary" disabled={actions.busy || name.trim() === ''} onClick={create}>Create a new room</button>
    </div>
    {actions.error && <p role="alert" className="form-error">{actions.error}</p>}
  </section></main>
}

function PairingControls({ state, deps, dispatch }: { state: ActivityState; deps: AppDeps; dispatch: React.Dispatch<ActivityAction> }): React.JSX.Element {
  const actions = useAsyncActions()
  const create = (): void => actions.run(async () => {
    const pairing = await deps.api.createPairing()
    dispatch({ type: 'pairing', ...pairing })
  })
  return <section className="card setup-card"><p className="eyebrow">Step 2 · Optional</p><h2>{state.account?.paired ? 'Your desktop is connected' : 'Share your own stats'}</h2>
    <p>{state.account?.paired
      ? 'Done — your companion can publish your character and pet damage into this room.'
      : 'You can already view the room. Pair only if you want your own character and damage to appear for everyone.'}</p>
    {state.pairing
      ? <><output className="pair-code compact" aria-label="Pairing code">{state.pairing.code}</output><p className="fine">In the desktop app: Preferences → Discord Live → enter this code. It expires in 5 minutes.</p></>
      : <button disabled={actions.busy} onClick={create}>{state.account?.paired ? 'Pair another desktop' : 'Get desktop pairing code'}</button>}
    {actions.error && <p role="alert" className="form-error">{actions.error}</p>}
  </section>
}

function RoomExitControls({ owner, busy, exit }: { owner: boolean; busy: boolean; exit: () => void }): React.JSX.Element {
  const [confirmExit, setConfirmExit] = useState(false)
  if (!confirmExit) return <button className="danger subtle" disabled={busy} onClick={() => setConfirmExit(true)}>
    {owner ? 'Close room and return to start' : 'Leave room and return to start'}
  </button>
  return <div className="room-exit-confirm"><p>{owner
    ? 'This closes the room for everyone and returns you to the join screen.'
    : 'This removes you from the room and returns you to the join screen.'}</p>
    <button className="danger" disabled={busy} onClick={exit}>{owner ? 'Yes, close the room' : 'Yes, leave the room'}</button>
    <button className="secondary" disabled={busy} onClick={() => setConfirmExit(false)}>Cancel</button></div>
}

function RoomControls({ state, deps, dispatch }: { state: ActivityState; deps: AppDeps; dispatch: React.Dispatch<ActivityAction> }): React.JSX.Element {
  const actions = useAsyncActions()
  const room = state.account?.room
  const refresh = async (roomCode?: string): Promise<void> => dispatch({ type: 'account', account: await deps.api.loadMe(), ...(roomCode === undefined ? {} : { roomCode }) })
  if (room === null || room === undefined) return <></>
  const rotate = (): void => actions.run(async () => refresh(await deps.api.rotateRoomCode(room.id)))
  const leave = (): void => actions.run(async () => { await deps.api.leaveRoom(room.id); await refresh() })
  const close = (): void => actions.run(async () => { await deps.api.closeRoom(room.id); await refresh() })
  const exit = room.owner ? close : leave
  return <section className="card setup-card"><p className="eyebrow">Step 1 · Room joined</p><h2>{room.name}</h2>
    <p>{room.owner ? 'You are hosting. Share a code so your friends can join.' : 'You joined this room. You can view it without pairing a desktop.'}</p>
    {state.roomCode
      ? <><output className="room-code" aria-label="Room code">{state.roomCode}</output><p className="fine">Share this with people you want in the room.</p></>
      : room.owner && <button disabled={actions.busy} onClick={rotate}>Get a fresh room code</button>}
    <RoomExitControls owner={room.owner} busy={actions.busy} exit={exit} />
    {actions.error && <p role="alert" className="form-error">{actions.error}</p>}
  </section>
}

function AccountControls({ account, deps, dispatch }: { account: ViewerAccount; deps: AppDeps; dispatch: React.Dispatch<ActivityAction> }): React.JSX.Element {
  const actions = useAsyncActions()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const revoke = (deviceId: string): void => actions.run(async () => {
    await deps.api.revokeDevice(deviceId)
    dispatch({ type: 'account', account: await deps.api.loadMe() })
  })
  const erase = (): void => actions.run(async () => {
    await deps.api.deleteAccount()
    dispatch({ type: 'deleted' })
  })
  return <section className="card setup-card account-controls"><p className="eyebrow">Account controls</p><h2>Paired desktops</h2>
    {account.devices.length === 0 ? <p>No desktop is paired yet.</p> : <ul>{account.devices.map((device) => <li key={device.id}><span>{device.label}</span><button disabled={actions.busy} onClick={() => revoke(device.id)}>Revoke</button></li>)}</ul>}
    {confirmDelete
      ? <div className="delete-confirm"><p>This removes your devices, room membership, and shared state.</p><button disabled={actions.busy} onClick={erase}>Delete permanently</button><button disabled={actions.busy} onClick={() => setConfirmDelete(false)}>Cancel</button></div>
      : <button className="danger" disabled={actions.busy} onClick={() => setConfirmDelete(true)}>Delete cloud account</button>}
    {actions.error && <p role="alert" className="form-error">{actions.error}</p>}
  </section>
}

function SetupPanel({ state, deps, dispatch }: { state: ActivityState; deps: AppDeps; dispatch: React.Dispatch<ActivityAction> }): React.JSX.Element {
  if (state.account === undefined) return <></>
  return <><RoomControls state={state} deps={deps} dispatch={dispatch} /><PairingControls state={state} deps={deps} dispatch={dispatch} /><AccountControls account={state.account} deps={deps} dispatch={dispatch} /></>
}

function ConnectedActivity({ state, deps, dispatch }: { state: ActivityState; deps: AppDeps; dispatch: React.Dispatch<ActivityAction> }): React.JSX.Element {
  const stale = state.phase === 'stale'
  const onlineCount = state.room?.participants.filter((participant) => participant.online).length ?? 0
  return <main className="app-shell"><header><div><p className="brand">EQ Legends <span>Live</span></p><p className="viewer">{state.account?.room?.name} · viewing as {state.account?.user.displayName}</p></div>
    <div className={`connection ${stale ? 'offline' : ''}`}><span />{stale ? 'Reconnecting' : `${onlineCount} connected`}</div></header>
    {stale && <div className="stale-banner" role="status">Connection lost. Showing the latest room update.</div>}
    {state.room === undefined
      ? <section className="waiting" aria-live="polite"><span className="spinner" /><h1>Opening shared room</h1><p>The encounter board will appear as soon as the room connects.</p></section>
      : <RoomDashboard room={state.room} now={deps.now()} initialTab={state.account?.paired ? 'encounters' : 'setup'}
        setup={<SetupPanel state={state} deps={deps} dispatch={dispatch} />} />}
  </main>
}

function ActivityView({ state, retry, deps, dispatch }: { state: ActivityState; retry: () => void; deps: AppDeps; dispatch: React.Dispatch<ActivityAction> }): React.JSX.Element {
  if (state.phase === 'boot') return <main className="center-shell"><section className="state-card"><span className="spinner" /><p className="eyebrow">EQ Legends Live</p><h1>Connecting to Discord...</h1></section></main>
  if (state.phase === 'error') return <ErrorPanel title="You're offline" message={state.message ?? 'The live view could not connect.'} retry={retry} />
  if (state.phase === 'incompatible') return <ErrorPanel title="Update required" message={state.message ?? 'This Activity and desktop companion use incompatible versions.'} />
  if (state.phase === 'deleted') return <ErrorPanel title="Cloud sync deleted" message="Your cloud account was removed." />
  if (state.phase === 'lobby') return <RoomLobby deps={deps} dispatch={dispatch} />
  return <ConnectedActivity state={state} deps={deps} dispatch={dispatch} />
}

export function App({ deps = browserDeps }: { deps?: AppDeps }): React.JSX.Element {
  const [state, dispatch] = useReducer(activityReducer, initialState)
  const [attempt, setAttempt] = useState(0)
  useAuthentication(deps, attempt, dispatch)
  useRoomTransport(deps, state.account?.room?.id, dispatch)
  useAccountRefreshOnPublish(state, deps, dispatch)
  return <ActivityView state={state} retry={() => setAttempt((value) => value + 1)} deps={deps} dispatch={dispatch} />
}

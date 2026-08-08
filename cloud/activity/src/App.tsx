import { useCallback, useEffect, useReducer, useState } from 'react'
import type { ActivityApi } from './api'
import { createActivityApi } from './api'
import { LiveDashboard } from './components/LiveDashboard'
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

function lastSeen(at: number | undefined, now: number): string {
  if (at === undefined) return 'recently'
  const seconds = Math.max(0, Math.floor((now - at) / 1_000))
  const age = seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`
  return `${age} (${new Date(at).toLocaleTimeString()})`
}

async function awaitDiscord(discord: DiscordAdapter, deps: AppDeps, signal: AbortSignal): Promise<void> {
  await Promise.race([
    discord.ready(),
    deps.delay(8_000, signal).then(() => { throw new Error('Discord did not respond. Open this Activity from a Discord voice channel and try again.') })
  ])
}

function useAuthenticatedActivity(deps: AppDeps, attempt: number, dispatch: React.Dispatch<ActivityAction>): void {
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
      if (controller.signal.aborted) return
      dispatch({ type: 'account', account })
      void runViewerTransport({ ...deps, dispatch }, controller.signal)
    }
    void authenticate().catch((error: unknown) => {
      if (!controller.signal.aborted) dispatch({ type: 'error', message: error instanceof Error ? error.message : 'Authentication failed.' })
    })
    return () => controller.abort()
  }, [attempt, deps, dispatch])
}

function useCreatePairing(deps: AppDeps, dispatch: React.Dispatch<ActivityAction>): [boolean, () => void] {
  const [busy, setBusy] = useState(false)
  const createPairing = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const pairing = await deps.api.createPairing()
      dispatch({ type: 'pairing', ...pairing })
    } catch (error) {
      dispatch({ type: 'error', message: error instanceof Error ? error.message : 'Could not create a pairing code.' })
    } finally { setBusy(false) }
  }, [deps, dispatch])
  return [busy, () => { void createPairing() }]
}

function BootPanel(): React.JSX.Element {
  return <main className="center-shell" aria-live="polite"><section className="state-card"><span className="spinner" /><p className="eyebrow">EQ Legends Live</p><h1>Connecting to Discord…</h1><p>Authenticating your private live view.</p></section></main>
}

function PairingPanel({ state, busy, create }: { state: ActivityState; busy: boolean; create: () => void }): React.JSX.Element {
  const action = state.pairing
    ? <><output className="pair-code" aria-label="Pairing code">{state.pairing.code}</output><p className="fine">Expires in 5 minutes. Keep this code private.</p></>
    : <button disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create pairing code'}</button>
  return <main className="center-shell"><section className="state-card pairing"><p className="eyebrow">Welcome, {state.account?.user.displayName}</p><h1>Pair your desktop companion</h1><p>In EQ Legends Companion, open Preferences → Discord Live, enter this one-time code, then enable publishing.</p>{action}</section></main>
}

function ConnectedActivity({ state, now }: { state: ActivityState; now: number }): React.JSX.Element {
  const stale = state.phase === 'stale'
  const connection = stale ? 'Desktop offline' : state.phase === 'waiting' ? 'Waiting for desktop' : 'Live'
  const banner = stale ? `Showing the latest update · last seen ${lastSeen(state.lastSeenAt, now)}` : 'Live from your desktop'
  return <main className="app-shell"><header><div><p className="brand">EQ Legends <span>Live</span></p><p className="viewer">Viewing as {state.account?.user.displayName}</p></div><div className={`connection ${stale ? 'offline' : ''}`}><span />{connection}</div></header>
    {state.phase === 'waiting' && <section className="waiting" aria-live="polite"><span className="spinner" /><h1>Waiting for your desktop</h1><p>Start EQ Legends Companion and enable Discord Live. This view will update automatically.</p></section>}
    {state.state && <><div className={stale ? 'stale-banner' : 'live-banner'} role="status">{banner}</div><LiveDashboard state={state.state} now={now} /></>}
  </main>
}

function ActivityView({ state, retry, pairingBusy, createPairing, now }: { state: ActivityState; retry: () => void; pairingBusy: boolean; createPairing: () => void; now: number }): React.JSX.Element {
  if (state.phase === 'boot') return <BootPanel />
  if (state.phase === 'error') return <ErrorPanel title="You’re offline" message={state.message ?? 'The live view could not connect.'} retry={retry} />
  if (state.phase === 'incompatible') return <ErrorPanel title="Update required" message={state.message ?? 'This Activity and desktop companion use incompatible versions.'} />
  if (state.phase === 'unpaired') return <PairingPanel state={state} busy={pairingBusy} create={createPairing} />
  return <ConnectedActivity state={state} now={now} />
}

export function App({ deps = browserDeps }: { deps?: AppDeps }): React.JSX.Element {
  const [state, dispatch] = useReducer(activityReducer, initialState)
  const [attempt, setAttempt] = useState(0)
  const [pairingBusy, createPairing] = useCreatePairing(deps, dispatch)
  useAuthenticatedActivity(deps, attempt, dispatch)

  return <ActivityView state={state} retry={() => setAttempt((value) => value + 1)} pairingBusy={pairingBusy} createPairing={createPairing} now={deps.now()} />
}

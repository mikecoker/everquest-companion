import { parseServerCloudSyncJson } from '../../../src/shared/cloudSync'
import { parseServerCloudRoomJson } from '../../../src/shared/cloudRoom'
import type { ActivityApi } from './api'
import { viewerSocketUrl } from './api'
import type { ActivityAction } from './model'

export interface SocketLike {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event | MessageEvent) => void): void
  close(): void
}

export interface TransportDeps {
  api: ActivityApi
  socket(url: string): SocketLike
  dispatch(action: ActivityAction): void
  now(): number
  delay(ms: number, signal: AbortSignal): Promise<void>
  random(): number
}

const MAX_BACKOFF_MS = 30_000

export function backoffDelay(attempt: number, random: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 6))
  return Math.round(base * (0.75 + random * 0.5))
}

function socketRun(deps: TransportDeps, url: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = deps.socket(url)
    let settled = false
    const finish = (terminal = false): void => { if (!settled) { settled = true; resolve(terminal) } }
    const abort = (): void => { ws.close(); finish() }
    signal.addEventListener('abort', abort, { once: true })
    ws.addEventListener('message', (event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return
      const sync = parseServerCloudSyncJson(event.data)
      const parsed = sync.ok ? sync : parseServerCloudRoomJson(event.data)
      if (parsed.ok) {
        deps.dispatch({ type: 'socket', message: parsed.value })
        if (parsed.value.type === 'error' && parsed.value.code === 'version_mismatch') {
          finish(true)
          ws.close()
        }
      }
      else if (parsed.error.code === 'unsupported_version') {
        deps.dispatch({ type: 'incompatible', message: 'This live view uses an incompatible protocol version.' })
        finish(true)
        ws.close()
      }
    })
    ws.addEventListener('close', () => finish())
    ws.addEventListener('error', () => finish())
  })
}

export async function runViewerTransport(deps: TransportDeps, signal: AbortSignal): Promise<void> {
  let attempt = 0
  while (!signal.aborted) {
    try {
      const ticket = await deps.api.createViewerSession()
      if (signal.aborted) return
      const terminal = await socketRun(deps, viewerSocketUrl(ticket), signal)
      if (terminal) return
      if (signal.aborted) return
      deps.dispatch({ type: 'disconnected', at: deps.now() })
    } catch {
      if (signal.aborted) return
      deps.dispatch({ type: 'disconnected', at: deps.now() })
    }
    await deps.delay(backoffDelay(attempt++, deps.random()), signal).catch(() => undefined)
  }
}

export function browserDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { window.clearTimeout(timer); reject(new Error('Cancelled')) }, { once: true })
  })
}

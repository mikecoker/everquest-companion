import {
  CLOUD_SYNC_LIMITS,
  CLOUD_SYNC_PROTOCOL_VERSION,
  parseCloudSyncState,
  parseServerCloudSyncJson
} from '../../shared/cloudSync'
import type { DesktopCloudSyncMessage, ServerCloudSyncMessage } from '../../shared/cloudSync'
import { CloudSyncClient, CloudSyncHttpError } from './client'
import type { CloudSyncConfig } from './config'

const PUBLISH_INTERVAL_MS = 500
const HEARTBEAT_INTERVAL_MS = 20_000
const MAX_RECONNECT_MS = 30_000
const MAX_SERVER_RETRY_MS = 5 * 60_000

export interface CloudSyncSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
}

export interface CloudSyncClock {
  now(): number
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

export type CloudSyncPublisherStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'connecting' }
  | { state: 'online'; lastPublishedAt?: number }
  | { state: 'retrying'; retryAt: number; message: string }
  | { state: 'error'; message: string }
  | { state: 'revoked' }
  | { state: 'superseded' }

export interface CloudSyncPublisherOptions {
  config: CloudSyncConfig
  state: () => unknown
  socket: (url: string) => CloudSyncSocket
  status?: (status: CloudSyncPublisherStatus) => void
  fetcher?: typeof fetch
  clock?: CloudSyncClock
  random?: () => number
}

const systemClock: CloudSyncClock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

function safeMessage(value: string): string {
  return value.slice(0, CLOUD_SYNC_LIMITS.maxErrorChars)
}

export class CloudSyncPublisher {
  private readonly clock: CloudSyncClock
  private readonly random: () => number
  private readonly report: (status: CloudSyncPublisherStatus) => void
  private client: CloudSyncClient | null = null
  private socket: CloudSyncSocket | null = null
  private reconnectTimer: unknown = null
  private publishTimer: unknown = null
  private heartbeatTimer: unknown = null
  private running = false
  private ready = false
  private dirty = false
  private attempt = 0
  private generation = 0
  private lastPublishedAt = Number.NEGATIVE_INFINITY

  constructor(private readonly options: CloudSyncPublisherOptions) {
    this.clock = options.clock ?? systemClock
    this.random = options.random ?? Math.random
    this.report = options.status ?? (() => undefined)
    if (options.config.enabled) this.client = new CloudSyncClient(options.config.endpoint, options.fetcher)
  }

  start(): void {
    if (this.running) return
    const config = this.options.config
    if (!config.enabled) {
      this.report({ state: 'disabled', reason: config.reason })
      return
    }
    if (this.client === null) {
      this.report({ state: 'disabled', reason: 'invalid_endpoint' })
      return
    }
    this.running = true
    this.generation += 1
    void this.connect(this.generation)
  }

  stop(): void {
    this.running = false
    this.generation += 1
    this.ready = false
    this.dirty = false
    this.clearTimers()
    this.socket?.close(1000, 'Cloud sync stopped')
    this.socket = null
  }

  notifyDirty(): void {
    if (!this.running) return
    this.dirty = true
    this.schedulePublish()
  }

  private clearTimer(name: 'reconnectTimer' | 'publishTimer' | 'heartbeatTimer'): void {
    const handle = this[name]
    if (handle !== null) this.clock.clearTimeout(handle)
    this[name] = null
  }

  private clearTimers(): void {
    this.clearTimer('reconnectTimer')
    this.clearTimer('publishTimer')
    this.clearTimer('heartbeatTimer')
  }

  private async connect(generation: number): Promise<void> {
    const config = this.options.config
    if (!this.running || !config.enabled || this.client === null) return
    this.report({ state: 'connecting' })
    try {
      const session = await this.client.createSession(config.credentials)
      if (!this.running || generation !== this.generation) return
      this.attach(this.options.socket(this.client.socketUrl(session.ticket)), generation)
    } catch (error) {
      if (!this.running || generation !== this.generation) return
      if (error instanceof CloudSyncHttpError && error.status === 401) {
        this.terminate('revoked')
        return
      }
      this.retry(error instanceof Error ? error.message : 'Cloud sync connection failed')
    }
  }

  private attach(socket: CloudSyncSocket, generation: number): void {
    this.socket = socket
    socket.addEventListener('message', (event) => this.onMessage(event.data, generation))
    socket.addEventListener('close', (event) => this.onClose(event.code, event.reason, generation))
    socket.addEventListener('error', () => this.report({ state: 'error', message: 'Cloud sync socket error' }))
  }

  private onMessage(data: unknown, generation: number): void {
    if (!this.running || generation !== this.generation || typeof data !== 'string') return
    const parsed = parseServerCloudSyncJson(data)
    if (!parsed.ok) {
      this.report({ state: 'error', message: safeMessage(parsed.error.message) })
      return
    }
    this.handleServerMessage(parsed.value)
  }

  private handleServerMessage(message: ServerCloudSyncMessage): void {
    if (message.type === 'ready') {
      this.ready = true
      this.attempt = 0
      this.dirty = true
      this.clearTimer('reconnectTimer')
      this.report({ state: 'online' })
      this.publish(true)
      this.scheduleHeartbeat()
      return
    }
    if (message.type !== 'error') return
    if (message.code === 'unauthorized') {
      this.terminate('revoked')
      return
    }
    this.report({ state: 'error', message: safeMessage(message.message) })
    if (message.code === 'rate_limited' && message.retryAfterMs !== undefined) {
      this.dirty = true
      this.clearTimer('publishTimer')
      const delay = Math.min(MAX_SERVER_RETRY_MS, Math.max(PUBLISH_INTERVAL_MS, message.retryAfterMs))
      this.publishTimer = this.clock.setTimeout(() => this.publish(false), delay)
    }
  }

  private onClose(code: number, reason: string, generation: number): void {
    if (!this.running || generation !== this.generation) return
    this.socket = null
    this.ready = false
    this.clearTimer('heartbeatTimer')
    this.clearTimer('publishTimer')
    if (code === 4001) {
      this.terminate('superseded')
      return
    }
    if (code === 4003) {
      this.terminate('revoked')
      return
    }
    this.retry(reason.length > 0 ? reason : 'Cloud sync disconnected')
  }

  private terminate(state: 'revoked' | 'superseded'): void {
    this.running = false
    this.generation += 1
    this.ready = false
    this.clearTimers()
    this.socket?.close(1000, state)
    this.socket = null
    this.report({ state })
  }

  private retry(message: string): void {
    if (!this.running) return
    const base = Math.min(MAX_RECONNECT_MS, 1_000 * 2 ** this.attempt)
    this.attempt += 1
    const delay = Math.min(MAX_RECONNECT_MS, Math.round(base * (0.5 + this.random())))
    const retryAt = this.clock.now() + delay
    this.report({ state: 'retrying', retryAt, message: safeMessage(message) })
    this.clearTimer('reconnectTimer')
    const generation = this.generation
    this.reconnectTimer = this.clock.setTimeout(() => void this.connect(generation), delay)
  }

  private schedulePublish(): void {
    if (!this.ready || this.publishTimer !== null) return
    const delay = Math.max(0, this.lastPublishedAt + PUBLISH_INTERVAL_MS - this.clock.now())
    this.publishTimer = this.clock.setTimeout(() => this.publish(false), delay)
  }

  private publish(immediate: boolean): void {
    this.clearTimer('publishTimer')
    if (!this.running || !this.ready || (!immediate && !this.dirty) || this.socket === null) return
    const parsed = parseCloudSyncState(this.options.state())
    if (!parsed.ok) {
      this.report({ state: 'error', message: 'Cloud sync state was invalid' })
      return
    }
    const message: DesktopCloudSyncMessage = {
      version: CLOUD_SYNC_PROTOCOL_VERSION,
      type: 'publish',
      state: parsed.value
    }
    if (!this.send(message)) return
    this.dirty = false
    this.lastPublishedAt = this.clock.now()
    this.report({ state: 'online', lastPublishedAt: this.lastPublishedAt })
  }

  private scheduleHeartbeat(): void {
    this.clearTimer('heartbeatTimer')
    this.heartbeatTimer = this.clock.setTimeout(() => {
      if (!this.running || !this.ready || this.socket === null) return
      const message: DesktopCloudSyncMessage = {
        version: CLOUD_SYNC_PROTOCOL_VERSION,
        type: 'ping',
        sentAt: this.clock.now()
      }
      if (!this.send(message)) return
      this.notifyDirty()
      this.scheduleHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private send(message: DesktopCloudSyncMessage): boolean {
    const socket = this.socket
    if (socket?.readyState !== 1) {
      this.sendFailed('Cloud sync socket is not open')
      return false
    }
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      this.sendFailed('Cloud sync socket send failed')
      return false
    }
  }

  private sendFailed(message: string): void {
    const failedSocket = this.socket
    this.socket = null
    this.ready = false
    this.clearTimer('publishTimer')
    this.clearTimer('heartbeatTimer')
    this.generation += 1
    failedSocket?.close(1011, 'Cloud sync send failed')
    this.retry(message)
  }
}

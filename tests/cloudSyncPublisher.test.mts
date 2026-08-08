import assert from 'node:assert/strict'
import test from 'node:test'
import { CLOUD_SYNC_PROTOCOL_VERSION } from '../src/shared/cloudSync'
import type { CloudSyncState } from '../src/shared/cloudSync'
import type { CloudSyncClock, CloudSyncSocket } from '../src/main/cloudSync/publisher'
import { CloudSyncPublisher } from '../src/main/cloudSync/publisher'
import type { CloudSyncPublisherStatus } from '../src/main/cloudSync/publisher'

class FakeClock implements CloudSyncClock {
  time = 1_000
  private nextId = 1
  private readonly jobs = new Map<number, { at: number; callback: () => void }>()

  now = (): number => this.time

  setTimeout = (callback: () => void, delay: number): number => {
    const id = this.nextId++
    this.jobs.set(id, { at: this.time + delay, callback })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number') this.jobs.delete(handle)
  }

  advance(ms: number): void {
    const end = this.time + ms
    for (;;) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (next === undefined) break
      const [id, job] = next
      this.jobs.delete(id)
      this.time = job.at
      job.callback()
    }
    this.time = end
  }

  get pending(): number {
    return this.jobs.size
  }
}

interface SocketEvents {
  open: () => void
  message: (event: { data: unknown }) => void
  close: (event: { code: number; reason: string }) => void
  error: () => void
}

class FakeSocket implements CloudSyncSocket {
  readyState = 1
  readonly sent: string[] = []
  readonly closes: { code?: number; reason?: string }[] = []
  private readonly listeners = new Map<keyof SocketEvents, ((event?: never) => void)[]>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
  }

  addEventListener<K extends keyof SocketEvents>(type: K, listener: SocketEvents[K]): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener as (event?: never) => void)
    this.listeners.set(type, listeners)
  }

  emitMessage(value: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data: value } as never)
  }

  emitClose(code: number, reason = ''): void {
    for (const listener of this.listeners.get('close') ?? []) listener({ code, reason } as never)
  }
}

class ThrowingSocket extends FakeSocket {
  override send(_data: string): void {
    throw new Error('secret-bearing transport exception')
  }
}

const state: CloudSyncState = {
  publishedAt: 1_000,
  character: { id: 'character', name: 'Primitive', server: 'freeport', classes: ['Monk'] },
  combat: { inCombat: false, totalDamage: 0, dps: 0, rows: [] },
  recent: { kills: [], loot: [] }
}

function ready(socket: FakeSocket): void {
  socket.emitMessage(
    JSON.stringify({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'ready', sessionId: 'session', serverTime: 1_000 })
  )
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

interface Harness {
  publisher: CloudSyncPublisher
  clock: FakeClock
  sockets: FakeSocket[]
  urls: string[]
  statuses: CloudSyncPublisherStatus[]
  sessionBodies: Record<string, unknown>[]
}

function harness(options: { response?: () => Response; state?: () => unknown; random?: () => number } = {}): Harness {
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const statuses: CloudSyncPublisherStatus[] = []
  const sessionBodies: Record<string, unknown>[] = []
  let ticket = 0
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    sessionBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return (
      options.response?.() ??
      new Response(JSON.stringify({ ticket: `ticket-${++ticket}`, expiresAt: clock.now() + 60_000 }), { status: 200 })
    )
  }) as typeof fetch
  const publisher = new CloudSyncPublisher({
    config: {
      enabled: true,
      endpoint: 'https://sync.test',
      credentials: { deviceId: 'device-id', deviceSecret: 'private-secret' }
    },
    state: options.state ?? (() => ({ ...state, publishedAt: clock.now() })),
    socket: (url) => {
      urls.push(url)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    status: (status) => statuses.push(status),
    fetcher,
    clock,
    random: options.random ?? (() => 0.5)
  })
  return { publisher, clock, sockets, urls, statuses, sessionBodies }
}

test('disabled gates make no network or socket attempt', async () => {
  let fetched = false
  let socketOpened = false
  const statuses: CloudSyncPublisherStatus[] = []
  const publisher = new CloudSyncPublisher({
    config: { enabled: false, reason: 'e2e' },
    state: () => state,
    socket: () => {
      socketOpened = true
      return new FakeSocket()
    },
    fetcher: (async () => {
      fetched = true
      return new Response()
    }) as typeof fetch,
    status: (status) => statuses.push(status)
  })
  publisher.start()
  await settle()
  assert.equal(fetched, false)
  assert.equal(socketOpened, false)
  assert.deepEqual(statuses, [{ state: 'disabled', reason: 'e2e' }])
})

test('ready publishes a validated full state and dirty changes coalesce at 1s', async () => {
  const run = harness()
  run.publisher.start()
  await settle()
  assert.equal(run.sockets.length, 1)
  ready(run.sockets[0]!)
  assert.equal(run.sockets[0]!.sent.length, 1)
  const first = JSON.parse(run.sockets[0]!.sent[0]!) as { type: string; state: CloudSyncState }
  assert.equal(first.type, 'publish')
  assert.equal(first.state.character.name, 'Primitive')

  run.publisher.notifyDirty()
  run.publisher.notifyDirty()
  run.clock.advance(999)
  assert.equal(run.sockets[0]!.sent.length, 1)
  run.clock.advance(1)
  assert.equal(run.sockets[0]!.sent.length, 2)
  run.publisher.notifyDirty()
  run.clock.advance(1_000)
  assert.equal(run.sockets[0]!.sent.length, 3)
})

test('heartbeat pings and refreshes the full state after an idle interval', async () => {
  const run = harness()
  run.publisher.start()
  await settle()
  ready(run.sockets[0]!)
  run.clock.advance(20_000)
  const messages = run.sockets[0]!.sent.map((entry) => JSON.parse(entry) as { type: string; sentAt?: number; state?: CloudSyncState })
  assert.deepEqual(messages.map((message) => message.type), ['publish', 'ping', 'publish'])
  assert.equal(messages[1]?.sentAt, 21_000)
  assert.equal(messages[2]?.state?.publishedAt, 21_000)
  run.clock.advance(20_000)
  assert.equal(run.sockets[0]!.sent.length, 5)
})

test('heartbeat refresh waits out the 1s ceiling after a recent event publish', async () => {
  const run = harness()
  run.publisher.start()
  await settle()
  ready(run.sockets[0]!)
  run.clock.advance(19_900)
  run.publisher.notifyDirty()
  run.clock.advance(0)
  assert.equal(run.sockets[0]!.sent.length, 2)

  run.clock.advance(100)
  assert.equal(run.sockets[0]!.sent.length, 3)
  assert.equal((JSON.parse(run.sockets[0]!.sent[2]!) as { type: string }).type, 'ping')
  run.clock.advance(899)
  assert.equal(run.sockets[0]!.sent.length, 3)
  run.clock.advance(1)
  assert.equal(run.sockets[0]!.sent.length, 4)
  assert.equal((JSON.parse(run.sockets[0]!.sent[3]!) as { type: string }).type, 'publish')
})

test('stop cancels idle heartbeat refreshes', async () => {
  const run = harness()
  run.publisher.start()
  await settle()
  ready(run.sockets[0]!)
  run.publisher.stop()
  run.clock.advance(60_000)
  assert.equal(run.sockets[0]!.sent.length, 1)
})

test('disconnect reconnects with jitter, a fresh ticket, and no device secret in the URL', async () => {
  const run = harness({ random: () => 0 })
  run.publisher.start()
  await settle()
  assert.equal(run.urls[0], 'wss://sync.test/api/sync?ticket=ticket-1')
  ready(run.sockets[0]!)
  run.sockets[0]!.emitClose(1006, 'network down')
  const retry = run.statuses.at(-1)
  assert.deepEqual(retry, { state: 'retrying', retryAt: 1_500, message: 'network down' })
  run.clock.advance(499)
  assert.equal(run.sessionBodies.length, 1)
  run.clock.advance(1)
  await settle()
  assert.equal(run.sessionBodies.length, 2)
  assert.equal(run.urls[1], 'wss://sync.test/api/sync?ticket=ticket-2')
  assert.equal(run.urls.join(' ').includes('private-secret'), false)
  assert.deepEqual(run.sessionBodies[1], { deviceId: 'device-id', deviceSecret: 'private-secret' })
})

test('stop cancels a pending reconnect', async () => {
  const run = harness()
  run.publisher.start()
  await settle()
  run.sockets[0]!.emitClose(1006)
  assert.ok(run.clock.pending > 0)
  run.publisher.stop()
  run.clock.advance(30_000)
  await settle()
  assert.equal(run.sessionBodies.length, 1)
})

test('HTTP 401 and socket close 4003 terminate as revoked', async (context) => {
  await context.test('HTTP 401', async () => {
    const run = harness({
      response: () =>
        new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Credentials revoked' } }), { status: 401 })
    })
    run.publisher.start()
    await settle()
    assert.deepEqual(run.statuses.at(-1), { state: 'revoked' })
    run.clock.advance(60_000)
    assert.equal(run.sessionBodies.length, 1)
  })
  await context.test('socket 4003', async () => {
    const run = harness()
    run.publisher.start()
    await settle()
    run.sockets[0]!.emitClose(4003, 'Device revoked')
    assert.deepEqual(run.statuses.at(-1), { state: 'revoked' })
    run.clock.advance(60_000)
    assert.equal(run.sessionBodies.length, 1)
  })
})

test('replacement close 4001 terminates as superseded', async () => {
  const run = harness()
  run.publisher.start()
  await settle()
  run.sockets[0]!.emitClose(4001, 'Replaced by a newer connection')
  assert.deepEqual(run.statuses.at(-1), { state: 'superseded' })
  run.clock.advance(60_000)
  assert.equal(run.sessionBodies.length, 1)
})

test('invalid state is never sent', async () => {
  const run = harness({ state: () => ({ ...state, rawLog: 'private', publishedAt: -1 }) })
  run.publisher.start()
  await settle()
  ready(run.sockets[0]!)
  assert.deepEqual(run.sockets[0]!.sent, [])
  assert.deepEqual(run.statuses.at(-1), { state: 'error', message: 'Cloud sync state was invalid' })
  run.clock.advance(20_000)
  const types = run.sockets[0]!.sent.map((entry) => (JSON.parse(entry) as { type: string }).type)
  assert.deepEqual(types, ['ping'])
})

test('server rate limit delays the next full publish by at least its retry interval', async () => {
  const run = harness()
  run.publisher.start()
  await settle()
  ready(run.sockets[0]!)
  run.sockets[0]!.emitMessage(
    JSON.stringify({
      version: CLOUD_SYNC_PROTOCOL_VERSION,
      type: 'error',
      code: 'rate_limited',
      message: 'Slow down',
      retryAfterMs: 2_000
    })
  )
  run.clock.advance(1_999)
  assert.equal(run.sockets[0]!.sent.length, 1)
  run.clock.advance(1)
  assert.equal(run.sockets[0]!.sent.length, 2)
})

test('a racing socket send failure is contained and reconnects', async () => {
  const clock = new FakeClock()
  const first = new ThrowingSocket()
  const second = new FakeSocket()
  const sockets = [first, second]
  let fetches = 0
  const statuses: CloudSyncPublisherStatus[] = []
  const publisher = new CloudSyncPublisher({
    config: {
      enabled: true,
      endpoint: 'https://sync.test',
      credentials: { deviceId: 'device', deviceSecret: 'secret' }
    },
    state: () => state,
    socket: () => sockets.shift()!,
    fetcher: (async () =>
      new Response(JSON.stringify({ ticket: `ticket-${++fetches}`, expiresAt: 99_999 }), { status: 200 })) as typeof fetch,
    clock,
    random: () => 0.5,
    status: (status) => statuses.push(status)
  })
  publisher.start()
  await settle()
  ready(first)
  assert.equal(fetches, 1)
  assert.equal(statuses.at(-1)?.state, 'retrying')
  assert.deepEqual(first.closes, [{ code: 1011, reason: 'Cloud sync send failed' }])
  clock.advance(1_000)
  await settle()
  assert.equal(fetches, 2)
  ready(second)
  assert.equal(second.sent.length, 1)
})

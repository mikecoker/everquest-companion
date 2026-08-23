import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { CLOUD_SYNC_PROTOCOL_VERSION } from '../../../src/shared/cloudSync'

const CLOUD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(CLOUD_ROOT, '..')
const BROWSER_ROOT = join(CLOUD_ROOT, 'tests/browser')
const WRANGLER = join(CLOUD_ROOT, 'node_modules/wrangler/bin/wrangler.js')
const CONFIG = join(CLOUD_ROOT, 'wrangler.jsonc')
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
]

interface PairResponse {
  deviceId: string
  deviceSecret: string
}

interface TicketResponse {
  ticket: string
}

let mockDiscord: Server
let vite: ViteDevServer
let worker: ChildProcess
let browser: Browser
let page: Page
let persistDir: string
let workerOutput = ''
let workerPort = 0
let activityPort = 0

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not allocate a port'))
        return
      }
      server.close(() => { resolvePort(address.port) })
    })
  })
}

async function waitForHttp(url: string, accepted: ReadonlySet<number>): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (accepted.has(response.status)) return
    } catch {
      // The process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timed out waiting for ${url}\n${workerOutput.slice(-4_000)}`)
}

function startDiscordServer(port: number): Promise<Server> {
  return new Promise((resolveServer) => {
    const server = createHttpServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/oauth2/token' && request.method === 'POST') {
        response.end(JSON.stringify({ access_token: 'browser-e2e-access-token' }))
        return
      }
      if (request.url === '/users/@me' && request.headers.authorization === 'Bearer browser-e2e-access-token') {
        response.end(JSON.stringify({
          id: '123456789012345678',
          username: 'primitive',
          global_name: 'Primitive'
        }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })
    server.listen(port, '127.0.0.1', () => resolveServer(server))
  })
}

function applyMigrations(): void {
  const result = spawnSync(process.execPath, [WRANGLER,
    'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir, '--config', CONFIG
  ], { cwd: CLOUD_ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' } })
  if (result.status !== 0) throw new Error(`D1 migration failed\n${result.stdout}\n${result.stderr}`)
}

function startWorker(discordPort: number): ChildProcess {
  const child = spawn(process.execPath, [WRANGLER,
    'dev', '--local', '--ip', '127.0.0.1', '--port', String(workerPort),
    '--persist-to', persistDir, '--config', CONFIG, '--show-interactive-dev-session=false',
    '--var', 'DISCORD_CLIENT_ID:test-client',
    '--var', 'DISCORD_CLIENT_SECRET:test-client-secret',
    '--var', 'COOKIE_SIGNING_KEY:test-cookie-signing-key-with-enough-entropy',
    '--var', 'TICKET_SIGNING_KEY:test-ticket-signing-key-with-enough-entropy',
    '--var', 'DEVICE_PEPPER:test-device-pepper-with-enough-entropy',
    '--var', `DISCORD_API_ORIGIN:http://127.0.0.1:${discordPort}`,
    '--var', `ACTIVITY_ALLOWED_ORIGIN:http://localhost:${activityPort}`
  ], { cwd: CLOUD_ROOT, env: { ...process.env, CI: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const capture = (chunk: Buffer): void => { workerOutput = `${workerOutput}${chunk.toString()}`.slice(-20_000) }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  return child
}

async function startVite(): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: false,
    root: BROWSER_ROOT,
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: activityPort,
      strictPort: true,
      fs: { allow: [REPO_ROOT] },
      proxy: { '/api': { target: `http://127.0.0.1:${workerPort}`, ws: true } }
    }
  })
  await server.listen()
  return server
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
}

async function responseJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url} failed (${response.status}): ${await response.text()}`)
  return response.json()
}

function waitForMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for WebSocket ${type}`)), 10_000)
    socket.addEventListener('message', (event) => {
      const value = JSON.parse(String(event.data)) as Record<string, unknown>
      if (value.type !== type) return
      clearTimeout(timeout)
      resolveMessage(value)
    })
  })
}

async function openPublisher(device: PairResponse): Promise<WebSocket> {
  const session = await responseJson<TicketResponse>(`http://127.0.0.1:${workerPort}/api/devices/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(device)
  })
  const socket = new WebSocket(`ws://127.0.0.1:${workerPort}/api/sync?ticket=${encodeURIComponent(session.ticket)}`)
  await waitForMessage(socket, 'ready')
  return socket
}

function publish(socket: WebSocket, target: string): void {
  const now = Date.now()
  socket.send(JSON.stringify({
    version: CLOUD_SYNC_PROTOCOL_VERSION,
    type: 'publish',
    state: {
      publishedAt: now,
      character: {
        id: 'Primitive@freeport', name: 'Primitive', server: 'freeport', level: 50,
        classes: ['Monk'], zone: "Nagafen's Lair"
      },
      combat: {
        inCombat: true, target, startedAt: now - 4_000, totalDamage: 442, dps: 110.5,
        rows: [{ name: 'Primitive', total: 442, dps: 110.5, kind: 'self' }]
      },
      progression: { level: 50, percent: 42.5, xpPerHour: 3.2, etaMs: 64_000 },
      recent: {
        kills: [{ name: 'a lava beetle', ts: now - 1_000 }],
        loot: [{ item: 'Mote of Major Potential', ts: now - 500, quantity: 2 }]
      },
      rawLog: 'RAW-LOG-MUST-NEVER-RENDER'
    }
  }))
}

async function waitForVisibleText(text: string): Promise<void> {
  try {
    await page.getByText(text).first().waitFor({ timeout: 10_000 })
  } catch {
    throw new Error(`Activity did not render ${text}\n${await page.locator('body').innerText()}\n${workerOutput.slice(-6_000)}`)
  }
}

async function expectNoHorizontalOverflow(): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
}

beforeAll(async () => {
  workerPort = await freePort()
  activityPort = await freePort()
  const discordPort = await freePort()
  persistDir = await mkdtemp(join(tmpdir(), 'eq-cloud-browser-e2e-'))
  mockDiscord = await startDiscordServer(discordPort)
  applyMigrations()
  worker = startWorker(discordPort)
  await waitForHttp(`http://127.0.0.1:${workerPort}/api/me`, new Set([401, 403]))
  vite = await startVite()
  const executablePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
  if (executablePath === undefined) throw new Error('Chrome or Edge is required for the cloud browser E2E')
  browser = await chromium.launch({ executablePath, headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
})

afterAll(async () => {
  await page?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  await vite?.close().catch(() => undefined)
  if (worker?.exitCode === null) {
    worker.kill()
    await once(worker, 'exit').catch(() => undefined)
  }
  await closeServer(mockDiscord)
  if (persistDir !== undefined) {
    await rm(persistDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

describe('real Activity browser and local Worker', () => {
  it('creates a room, pairs, publishes a bounded encounter, and reconnects', async () => {
    await page.goto(`http://localhost:${activityPort}`, { waitUntil: 'domcontentloaded' })
    await page.getByText('Join your group').waitFor()
    await page.getByRole('button', { name: 'Create a new room' }).click()
    await page.getByRole('navigation', { name: 'Shared room views' }).waitFor()
    await page.getByRole('button', { name: 'Setup' }).click()
    await page.getByRole('button', { name: 'Get desktop pairing code' }).click()
    const code = (await page.getByLabel('Pairing code').textContent())?.trim()
    expect(code).toMatch(/^[A-Z2-9]{8}$/u)

    const device = await responseJson<PairResponse>(`http://127.0.0.1:${workerPort}/api/devices/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: 'Browser E2E desktop' })
    })
    let publisher = await openPublisher(device)
    publish(publisher, 'a fire giant captain')

    await page.getByRole('button', { name: 'Encounters' }).click()
    await waitForVisibleText('a fire giant captain')
    await page.getByRole('button', { name: 'Players' }).click()
    expect(await page.locator('body').innerText()).toContain('Mote of Major Potential')
    expect(await page.locator('body').innerText()).not.toContain('RAW-LOG-MUST-NEVER-RENDER')
    await expectNoHorizontalOverflow()

    await page.setViewportSize({ width: 390, height: 844 })
    await expectNoHorizontalOverflow()
    expect(await page.getByText('Primitive', { exact: true }).count()).toBeGreaterThan(0)

    publisher.close()
    await page.getByText('Offline', { exact: true }).waitFor()
    publisher = await openPublisher(device)
    publish(publisher, 'Lord Nagafen')
    await page.getByRole('button', { name: 'Encounters' }).click()
    await waitForVisibleText('Lord Nagafen')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForVisibleText('Lord Nagafen')
    await page.getByRole('button', { name: 'Setup' }).click()
    await page.getByRole('button', { name: 'Revoke' }).click()
    await page.getByText('Share your own stats').waitFor()
  })
})

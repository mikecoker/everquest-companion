/**
 * Cloud sync's closed-default and E2E network gate through the real Electron app.
 * A loopback trap is deliberately configured twice: pairing from the real Preferences UI and
 * an enabled persisted device at launch. EQ_E2E must keep both at exactly zero requests.
 */

import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  failures,
  reportRun,
  settle,
  settleStable
} from './appHarness.mjs'
import { mainWindow, makeUserData, removeUserData } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'

async function openCloudSettings(page: Page): Promise<void> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="prefs-rail-cloud-sync"]', { timeout: 20_000 })
  await page.click('[data-testid="prefs-rail-cloud-sync"]')
  await page.waitForSelector('[data-testid="cloud-sync-settings"]', { timeout: 20_000 })
}

async function freshUi(endpoint: string, requests: () => number): Promise<void> {
  const launched = await launchOnFixture('e2e-overview.log')
  try {
    const page = await mainWindow(launched.app)
    await openCloudSettings(page)
    const initial = await page.evaluate(() => ({
      enabled: (document.querySelector('[data-testid="cloud-sync-enabled"] input') as HTMLInputElement | null)?.checked,
      disabled: (document.querySelector('[data-testid="cloud-sync-enabled"] input') as HTMLInputElement | null)?.disabled,
      paired: document.querySelector('[data-testid="cloud-sync-paired-name"]')?.textContent,
      privacy: document.querySelector('[data-testid="cloud-sync-privacy"]')?.textContent
    }))
    check('cloud sync is off and unpaired on a fresh install', initial.enabled === false && initial.disabled === true, String(initial.paired))
    check('the Preferences card states both the allowlist and exclusions',
      initial.privacy?.includes('current encounter') === true && initial.privacy.includes('Never shared: raw log lines') === true)

    await page.fill('[data-testid="cloud-sync-endpoint"]', endpoint)
    await page.click('[data-testid="cloud-sync-save-endpoint"]')
    await page.fill('[data-testid="cloud-sync-pair-code"]', 'ABCDEFGH')
    await page.click('[data-testid="cloud-sync-pair"]')
    const refused = await settle(
      () => page.textContent('body').then((text) => text ?? ''),
      (text) => text.includes('pairing is unavailable during app tests')
    )
    check('the real pairing UI is refused by the E2E gate', refused.includes('pairing is unavailable during app tests'))
    const stableRequests = await settleStable(async () => requests(), { stable: 8, pollMs: 100 })
    check('pairing made zero requests to the configured trap server', stableRequests === 0, String(stableRequests))
  } finally {
    await launched.close()
  }
}

async function enabledProfile(endpoint: string, requests: () => number): Promise<void> {
  const userData = makeUserData()
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'everquest-companion-progress.json'), JSON.stringify({
    schemaVersion: 10,
    byCharacter: {},
    cloudSync: {
      enabled: true,
      endpoint,
      deviceId: 'e2e-device',
      deviceSecret: { kind: 'plaintext', value: 'e2e-secret' },
      pairedDiscordName: 'E2E Discord'
    }
  }))
  const launched = await launchOnFixture('e2e-overview.log', { userData })
  try {
    const page = await mainWindow(launched.app)
    const status = await settle(
      () => page.evaluate(() => (window as unknown as { eq: { getCloudSyncStatus: () => Promise<{ state: string }> } }).eq.getCloudSyncStatus()),
      (value) => value.state === 'disabled',
      { timeoutMs: 60_000 }
    )
    check('even an enabled persisted profile resolves disabled under EQ_E2E', status.state === 'disabled')
    const stableRequests = await settleStable(async () => requests(), { stable: 8, pollMs: 100 })
    check('the enabled profile made zero session or socket requests', stableRequests === 0, String(stableRequests))
  } finally {
    await launched.close()
    await removeUserData(userData)
  }
}

async function main(): Promise<void> {
  buildIfStale()
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(500).end('trap')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const endpoint = `http://127.0.0.1:${String(address.port)}`
  try {
    await freshUi(endpoint, () => requests)
    await enabledProfile(endpoint, () => requests)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  check('no cloud request escaped either E2E launch', requests === 0, String(requests))
  reportRun()
}

main().catch((error: unknown) => {
  console.error('e2e: harness error —', error)
  failures.push(String(error))
  process.exitCode = 1
})

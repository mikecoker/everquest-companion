// Main-process composition for the opt-in publisher. Settings own policy and persistence;
// CloudSyncPublisher owns transport mechanics; this file only keeps the two in step.

import type { CloudSyncPublisherStatus, CloudSyncSocket } from './publisher'
import { CloudSyncPublisher } from './publisher'
import { resolveCloudSyncConfig } from './config'
import {
  readMainCloudSyncSettings,
  setCloudSyncPublisherStatus,
  subscribeCloudSyncSettings
} from './settings'

let publisher: CloudSyncPublisher | null = null
let unsubscribeSettings: (() => void) | null = null
let stateProvider: (() => unknown) | null = null

function openSocket(url: string): CloudSyncSocket {
  return new WebSocket(url)
}

function report(status: CloudSyncPublisherStatus): void {
  setCloudSyncPublisherStatus(status)
}

function applySettings(): void {
  publisher?.stop()
  publisher = null
  const provider = stateProvider
  if (provider === null) return
  const config = resolveCloudSyncConfig(readMainCloudSyncSettings())
  if (!config.enabled) {
    report({ state: 'disabled', reason: config.reason })
    return
  }
  publisher = new CloudSyncPublisher({ config, state: provider, socket: openSocket, status: report })
  publisher.start()
}

/** Start once, after the historical replay has settled. Idempotent for app activation. */
export function startCloudSyncRuntime(state: () => unknown): void {
  if (unsubscribeSettings !== null) return
  stateProvider = state
  unsubscribeSettings = subscribeCloudSyncSettings(() => applySettings())
  applySettings()
}

/** A public slice changed; the publisher performs validation, coalescing and throttling. */
export function notifyCloudSyncDirty(): void {
  publisher?.notifyDirty()
}

/** Disable presence immediately and release every timer/socket. Safe on both quit paths. */
export function stopCloudSyncRuntime(): void {
  unsubscribeSettings?.()
  unsubscribeSettings = null
  stateProvider = null
  publisher?.stop()
  publisher = null
  report({ state: 'disabled', reason: 'disabled' })
}

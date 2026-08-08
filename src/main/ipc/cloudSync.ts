import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { parseCloudSyncEndpointInput, type CloudSyncActionResult } from '../../shared/cloudSyncPrefs'
import { CloudSyncClient } from '../cloudSync/client'
import { cloudSyncSettings } from '../cloudSync/settings'
import { E2E } from '../e2e'
import { pairCloudSyncDevice, type CloudSyncPairDeps } from './cloudSyncActions'

type CloudSyncIpcDeps = CloudSyncPairDeps

const defaultDeps: CloudSyncIpcDeps = {
  e2e: E2E,
  pair: (endpoint, code, label) => new CloudSyncClient(endpoint).pair(code, label)
}

function failed(error: string): CloudSyncActionResult {
  return { ok: false, prefs: cloudSyncSettings.view(), error }
}

export function registerCloudSyncIpc(deps: CloudSyncIpcDeps = defaultDeps): void {
  ipcMain.handle(IPC.cloudSyncGet, () => cloudSyncSettings.view())
  ipcMain.handle(IPC.cloudSyncStatus, () => cloudSyncSettings.getStatus())

  ipcMain.handle(IPC.cloudSyncSetEndpoint, (_event, input: unknown) => {
    const endpoint = parseCloudSyncEndpointInput(input)
    return endpoint === null ? failed('Enter a valid endpoint.') : cloudSyncSettings.setEndpoint(endpoint)
  })

  ipcMain.handle(IPC.cloudSyncPair, async (_event, code: unknown, label: unknown) => {
    return pairCloudSyncDevice(cloudSyncSettings, deps, code, label)
  })

  ipcMain.handle(IPC.cloudSyncSetEnabled, (_event, enabled: unknown) =>
    typeof enabled === 'boolean' ? cloudSyncSettings.setEnabled(enabled) : failed('Invalid cloud sync setting.')
  )
  ipcMain.handle(IPC.cloudSyncForget, () => cloudSyncSettings.forget())
}

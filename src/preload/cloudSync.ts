import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  CloudSyncActionResult,
  CloudSyncPrefsView,
  CloudSyncStatus
} from '../shared/cloudSyncPrefs'

export const cloudSyncBridge = {
  getCloudSyncPrefs: (): Promise<CloudSyncPrefsView> => ipcRenderer.invoke(IPC.cloudSyncGet),
  getCloudSyncStatus: (): Promise<CloudSyncStatus> => ipcRenderer.invoke(IPC.cloudSyncStatus),
  setCloudSyncEndpoint: (endpoint: string): Promise<CloudSyncActionResult> =>
    ipcRenderer.invoke(IPC.cloudSyncSetEndpoint, endpoint),
  pairCloudSync: (code: string, label: string): Promise<CloudSyncActionResult> =>
    ipcRenderer.invoke(IPC.cloudSyncPair, code, label),
  setCloudSyncEnabled: (enabled: boolean): Promise<CloudSyncActionResult> =>
    ipcRenderer.invoke(IPC.cloudSyncSetEnabled, enabled),
  forgetCloudSyncDevice: (): Promise<CloudSyncActionResult> => ipcRenderer.invoke(IPC.cloudSyncForget),
  onCloudSyncStatus: (callback: (status: CloudSyncStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: CloudSyncStatus): void => callback(status)
    ipcRenderer.on(IPC.onCloudSyncStatus, listener)
    return () => ipcRenderer.removeListener(IPC.onCloudSyncStatus, listener)
  }
}

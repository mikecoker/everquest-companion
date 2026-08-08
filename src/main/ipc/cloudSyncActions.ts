import { parseCloudSyncPairRequest, type CloudSyncActionResult } from '../../shared/cloudSyncPrefs'
import type { PairDeviceResult } from '../cloudSync/client'
import { cloudSyncEndpoint } from '../cloudSync/config'
import type { CloudSyncSettingsControl } from '../cloudSync/settingsControl'

export interface CloudSyncPairDeps {
  e2e: boolean
  pair(endpoint: string, code: string, label: string): Promise<PairDeviceResult>
}

function failed(control: CloudSyncSettingsControl, error: string): CloudSyncActionResult {
  return { ok: false, prefs: control.view(), error }
}

export async function pairCloudSyncDevice(
  control: CloudSyncSettingsControl,
  deps: CloudSyncPairDeps,
  code: unknown,
  label: unknown
): Promise<CloudSyncActionResult> {
  if (deps.e2e) return failed(control, 'Cloud sync pairing is unavailable during app tests.')
  const request = parseCloudSyncPairRequest(code, label)
  if (request === null) return failed(control, 'Enter the pairing code shown in Discord.')
  const endpoint = cloudSyncEndpoint(control.read().endpoint)
  if (endpoint === null) return failed(control, 'Save a valid endpoint before pairing.')
  try {
    return control.savePair(await deps.pair(endpoint, request.code, request.label))
  } catch {
    // Do not ferry arbitrary transport prose into the renderer. In particular, an injected
    // fetch implementation must not be able to echo credentials through an Error message.
    return failed(control, 'Pairing failed. Check the code in the Discord Activity and try again.')
  }
}

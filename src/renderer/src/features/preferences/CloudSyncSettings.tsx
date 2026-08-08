import { type JSX, useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import CloudQueueIcon from '@mui/icons-material/CloudQueue'
import type {
  CloudSyncActionResult,
  CloudSyncPrefsView,
  CloudSyncStatus
} from '@shared/cloudSyncPrefs'
import type { PrefSection } from './PreferencesView'

const EMPTY_PREFS: CloudSyncPrefsView = {
  enabled: false,
  endpoint: '',
  paired: false,
  secretProtected: true
}

function statusText(status: CloudSyncStatus): string {
  switch (status.state) {
    case 'disabled': return 'Not publishing'
    case 'connecting': return 'Connecting…'
    case 'online': return status.lastPublishedAt === undefined
      ? 'Connected; waiting for the first publish'
      : `Connected · last published ${new Date(status.lastPublishedAt).toLocaleString()}`
    case 'retrying': return `Retrying: ${status.message}`
    case 'error': return `Error: ${status.message}`
    case 'revoked': return 'This device was revoked in Discord'
    case 'superseded': return 'Another connection replaced this one'
  }
}

function PrivacyContract(): JSX.Element {
  return (
    <Stack spacing={0.5} data-testid="cloud-sync-privacy">
      <Typography variant="caption" color="text.secondary">
        Shared: character, server, confidently detected classes and zone; current encounter and
        compact DPS rows; leveling pace and ETA when knowable; recent kills and loot.
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Never shared: raw log lines, chat, tells, local paths, or arbitrary app data.
      </Typography>
    </Stack>
  )
}

export function CloudSyncSettings(): JSX.Element {
  const [prefs, setPrefs] = useState(EMPTY_PREFS)
  const [status, setStatus] = useState<CloudSyncStatus>({ state: 'disabled' })
  const [endpoint, setEndpoint] = useState('')
  const [code, setCode] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([window.eq.getCloudSyncPrefs(), window.eq.getCloudSyncStatus()]).then(([next, nextStatus]) => {
      if (!alive) return
      setPrefs(next)
      setEndpoint(next.endpoint)
      setStatus(nextStatus)
    })
    const unsubscribe = window.eq.onCloudSyncStatus(setStatus)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const accept = useCallback((result: CloudSyncActionResult, success: string): void => {
    setPrefs(result.prefs)
    setEndpoint(result.prefs.endpoint)
    setNotice(result.ok ? success : (result.error ?? 'Cloud sync setting was not changed.'))
  }, [])

  const saveEndpoint = useCallback(() => {
    void window.eq.setCloudSyncEndpoint(endpoint).then((result) => {
      const suffix = result.credentialsCleared
        ? ' The endpoint changed, so this device was forgotten; pair it again for the new service.'
        : ''
      accept(result, `Endpoint saved. Cloud sync stays off until you enable it.${suffix}`)
    })
  }, [accept, endpoint])

  const pair = useCallback(() => {
    void window.eq.pairCloudSync(code, 'EQ Legends Companion desktop').then((result) => {
      accept(result, 'Device paired. Review the sharing list, then enable cloud sync when ready.')
      if (result.ok) setCode('')
    })
  }, [accept, code])

  return (
    <Stack spacing={1.5} data-testid="cloud-sync-settings">
      <TextField
        size="small"
        label="Cloud service endpoint"
        value={endpoint}
        slotProps={{ htmlInput: { 'data-testid': 'cloud-sync-endpoint' } }}
        onChange={(event) => setEndpoint(event.target.value)}
      />
      <Button size="small" variant="outlined" data-testid="cloud-sync-save-endpoint" onClick={saveEndpoint}>
        Save endpoint
      </Button>
      <Stack direction="row" spacing={1}>
        <TextField
          fullWidth
          size="small"
          label="Pairing code from Discord"
          value={code}
          slotProps={{ htmlInput: { 'data-testid': 'cloud-sync-pair-code' } }}
          onChange={(event) => setCode(event.target.value)}
        />
        <Button variant="contained" data-testid="cloud-sync-pair" disabled={code.trim() === ''} onClick={pair}>
          Pair
        </Button>
      </Stack>
      <Typography variant="body2" data-testid="cloud-sync-paired-name">
        {prefs.paired
          ? `Paired${prefs.pairedDiscordName === undefined ? '' : ` with ${prefs.pairedDiscordName}`}`
          : 'This desktop is not paired.'}
      </Typography>
      <FormControlLabel
        control={<Switch
          checked={prefs.enabled}
          disabled={!prefs.paired}
          data-testid="cloud-sync-enabled"
          onChange={(event) => void window.eq.setCloudSyncEnabled(event.target.checked)
            .then((result) => accept(result, result.prefs.enabled ? 'Cloud sync enabled.' : 'Cloud sync disabled.'))}
        />}
        label="Publish live companion data to Discord"
      />
      <Typography variant="body2" data-testid="cloud-sync-status">{statusText(status)}</Typography>
      {!prefs.secretProtected && prefs.paired && (
        <Alert severity="warning" data-testid="cloud-sync-at-rest-warning">
          This system cannot protect the device secret with the OS keychain, so it is stored locally in plaintext.
        </Alert>
      )}
      {notice !== null && <Alert severity={notice.includes('not ') ? 'error' : 'info'}>{notice}</Alert>}
      <PrivacyContract />
      <Button
        color="error"
        size="small"
        disabled={!prefs.paired}
        data-testid="cloud-sync-forget"
        onClick={() => void window.eq.forgetCloudSyncDevice().then((result) => accept(result,
          'This desktop forgot its local device credentials. Revoke server access from the Discord Activity if needed.'))}
      >
        Forget this device
      </Button>
    </Stack>
  )
}

export const cloudSyncSection: PrefSection = {
  id: 'cloud-sync',
  label: 'Cloud sync',
  icon: <CloudQueueIcon fontSize="small" />,
  items: [{
    id: 'discord-cloud-sync',
    label: 'Discord Activity live sync',
    keywords: 'cloud discord activity pair pairing endpoint publish privacy dps live remote device',
    content: <CloudSyncSettings />
  }]
}

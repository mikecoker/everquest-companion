export type StoredCloudSyncSecret =
  | { kind: 'safeStorage'; value: string }
  | { kind: 'plaintext'; value: string }

export interface CloudSyncSecretCodec {
  available(): boolean
  encrypt(value: string): Uint8Array
  decrypt(value: Uint8Array): string
}

function codecAvailable(codec: CloudSyncSecretCodec): boolean {
  try {
    return codec.available()
  } catch {
    return false
  }
}

export function encodeCloudSyncSecret(secret: string, codec: CloudSyncSecretCodec): StoredCloudSyncSecret {
  if (codecAvailable(codec)) {
    try {
      return { kind: 'safeStorage', value: Buffer.from(codec.encrypt(secret)).toString('base64') }
    } catch {
      // An unavailable OS keychain must not make pairing impossible. The Preferences warning
      // makes this fallback explicit, and the value still never crosses IPC or profile export.
    }
  }
  return { kind: 'plaintext', value: secret }
}

export function decodeCloudSyncSecret(
  stored: StoredCloudSyncSecret | undefined,
  codec: CloudSyncSecretCodec
): { value: string; protected: boolean } | null {
  if (stored?.kind === 'plaintext') return stored.value.length > 0 ? { value: stored.value, protected: false } : null
  if (stored?.kind !== 'safeStorage' || !codecAvailable(codec)) return null
  try {
    const value = codec.decrypt(Buffer.from(stored.value, 'base64'))
    return value.length > 0 ? { value, protected: true } : null
  } catch {
    return null
  }
}

const encoder = new TextEncoder()

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((value.length + 3) % 4)
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

export function randomToken(byteLength = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function sha256(value: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

async function hmac(value: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value))))
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = base64UrlToBytes(left)
  const rightBytes = base64UrlToBytes(right)
  if (leftBytes === null || rightBytes === null || leftBytes.length !== rightBytes.length) return false
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!
  }
  return difference === 0
}

export async function signValue(value: string, key: string): Promise<string> {
  return `${value}.${await hmac(value, key)}`
}

export async function verifySignedValue(signed: string, key: string): Promise<string | null> {
  const separator = signed.lastIndexOf('.')
  if (separator < 1) return null
  const value = signed.slice(0, separator)
  const expected = await hmac(value, key)
  return constantTimeEqual(signed.slice(separator + 1), expected) ? value : null
}

export async function hashDeviceSecret(secret: string, salt: string, pepper: string): Promise<string> {
  return `${salt}.${await sha256(`${salt}:${secret}:${pepper}`)}`
}

export async function verifyDeviceSecret(secret: string, stored: string, pepper: string): Promise<boolean> {
  const separator = stored.indexOf('.')
  if (separator < 1) return false
  const candidate = await hashDeviceSecret(secret, stored.slice(0, separator), pepper)
  return constantTimeEqual(candidate.slice(separator + 1), stored.slice(separator + 1))
}

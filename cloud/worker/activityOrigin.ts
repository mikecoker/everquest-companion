import type { Env } from './types'
import { HttpError } from './validation'

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    const localHttp = url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    if (url.protocol !== 'https:' && !localHttp) return null
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

export function requiresActivityOrigin(method: string, path: string): boolean {
  if (method === 'POST') {
    return path === '/api/oauth/token' || path === '/api/pairing' || path === '/api/viewer/session' ||
      path === '/api/rooms' || path.startsWith('/api/rooms/')
  }
  return method === 'DELETE' &&
    (path === '/api/me' || path.startsWith('/api/devices/') || path.startsWith('/api/rooms/'))
}

export function requireActivityOrigin(request: Request, env: Env): void {
  const configured = env.ACTIVITY_ALLOWED_ORIGIN
  if (configured === undefined || configured.length === 0) return
  const expected = normalizedOrigin(configured)
  if (expected === null) {
    throw new HttpError(500, 'configuration_error', 'Activity origin is invalid')
  }
  if (request.headers.get('origin') !== expected) {
    throw new HttpError(403, 'invalid_origin', 'Request origin is not allowed')
  }
}

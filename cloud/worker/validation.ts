const MAX_BODY_BYTES = 8 * 1024

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message.slice(0, 256))
  }
}

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('content-type', 'application/json; charset=utf-8')
  responseHeaders.set('cache-control', 'no-store')
  return new Response(JSON.stringify(value), { status, headers: responseHeaders })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message } }, error.status)
  }
  return json({ error: { code: 'internal', message: 'The request could not be completed' } }, 500)
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'invalid_content_type', 'Content-Type must be application/json')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'request_too_large', 'Request body is too large')
  }
  try {
    const value = JSON.parse(text) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object')
  }
}

export function requiredString(source: Record<string, unknown>, key: string, max = 256): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new HttpError(400, 'invalid_request', `${key} is required`)
  }
  return value
}

export function clientIp(request: Request): string {
  return (request.headers.get('cf-connecting-ip') ?? 'local').slice(0, 64)
}

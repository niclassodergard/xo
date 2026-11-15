import type { ApiErrorBody, SessionResponse } from '../../shared/api.ts';
import { session } from './store.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  /** Seconds from a Retry-After header (429), else null. */
  retryAfter: number | null;
  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Only same-origin /api paths: the CSRF token must never be sent anywhere else. */
function assertApiPath(path: string): void {
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error(`Invalid API path: ${path}`);
}

function parseErrorBody(text: string): { code: string; message: string } | null {
  try {
    const body = JSON.parse(text) as Partial<ApiErrorBody> | null;
    const e = body?.error;
    if (e && typeof e.code === 'string' && typeof e.message === 'string') return { code: e.code, message: e.message };
  } catch { /* not JSON */ }
  return null;
}

async function request<T>(method: Method, path: string, body?: unknown, audio?: Blob, canRetry = true, signal?: AbortSignal): Promise<T> {
  assertApiPath(path);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    const token = session.value?.csrfToken;
    if (token) headers['X-XO-CSRF'] = token;
  }
  let payload: BodyInit | undefined;
  if (audio) {
    headers['Content-Type'] = audio.type.split(';')[0] || 'application/octet-stream';
    payload = audio;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server.');
  }

  // A 403 on a write may mean our CSRF token is stale (new session elsewhere). Re-fetch it once and
  // retry once, but only if the token actually changed; a genuine 403 is reported as is.
  if (res.status === 403 && method !== 'GET' && canRetry && path !== '/api/auth/login') {
    const before = session.value?.csrfToken;
    try {
      const fresh = await request<SessionResponse>('GET', '/api/auth/session', undefined, undefined, false);
      if (session.value && fresh.csrfToken && fresh.csrfToken !== before) {
        session.value = { csrfToken: fresh.csrfToken };
        return request<T>(method, path, body, audio, false, signal);
      }
    } catch { /* fall through to the original 403 */ }
  }

  const text = res.status === 204 ? '' : await res.text().catch(() => '');
  // A timeout/cancel during the body read must not look like an empty (successful) response.
  if (signal?.aborted) throw new ApiError(0, 'network', 'Request aborted.');
  if (!res.ok) {
    if (res.status === 401) session.value = null;
    const parsed = parseErrorBody(text);
    const ra = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
    throw new ApiError(
      res.status,
      parsed?.code ?? 'http_error',
      parsed?.message ?? `Request failed (${res.status}).`,
      Number.isFinite(ra) && ra >= 0 ? ra : null,
    );
  }
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'bad_response', 'Unexpected response from the server.');
  }
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown): Promise<T> => request<T>('PATCH', path, body),
  /** PUT without a body unless given (the pin and project-person link routes reject a body). */
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body),
  del: async (path: string): Promise<void> => { await request<void>('DELETE', path); },
  postAudio: (path: string, blob: Blob, signal?: AbortSignal): Promise<{ text: string }> =>
    request<{ text: string }>('POST', path, undefined, blob, true, signal),
};

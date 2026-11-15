import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api.ts';
import { session } from './store.ts';

function mockFetch(res: Response | Error) {
  const fn = vi.fn(async (..._args: unknown[]) => { if (res instanceof Error) throw res; return res; });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const init = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };

beforeEach(() => { session.value = { csrfToken: 'tok123' }; });
afterEach(() => { vi.unstubAllGlobals(); session.value = null; });

describe('api client', () => {
  it('sends no CSRF header on GET and parses JSON', async () => {
    const f = mockFetch(json({ people: [] }));
    expect(await api.get('/api/people')).toEqual({ people: [] });
    expect(init(f).headers['X-XO-CSRF']).toBeUndefined();
    expect(init(f).credentials).toBe('same-origin');
  });

  it('adds the CSRF header and JSON body on POST, PATCH and DELETE', async () => {
    const f = mockFetch(json({ id: 1 }, 201));
    await api.post('/api/people', { name: 'Anna' });
    expect(init(f).headers['X-XO-CSRF']).toBe('tok123');
    expect(init(f).headers['Content-Type']).toBe('application/json');
    expect(init(f).body).toBe('{"name":"Anna"}');

    const f2 = mockFetch(json({ id: 1 }));
    await api.patch('/api/people/1', { name: 'B' });
    expect(init(f2).method).toBe('PATCH');
    expect(init(f2).headers['X-XO-CSRF']).toBe('tok123');

    const f3 = mockFetch(new Response(null, { status: 204 }));
    await expect(api.del('/api/notes/1')).resolves.toBeUndefined();
    expect(init(f3).method).toBe('DELETE');
    expect(init(f3).headers['X-XO-CSRF']).toBe('tok123');
  });

  it('sends no Content-Type and no body for bodiless POSTs, and accepts any 2xx', async () => {
    const f = mockFetch(json({ meeting: { id: 5 } }, 200));
    const r = await api.post<{ meeting: { id: number } }>('/api/people/1/meetings');
    expect(r.meeting.id).toBe(5);
    expect(init(f).body).toBeUndefined();
    expect(init(f).headers['Content-Type']).toBeUndefined();
    mockFetch(json({ id: 2 }, 201));
    expect(await api.post('/api/people', { name: 'x' })).toEqual({ id: 2 });
  });

  it('posts audio with its media type (codecs stripped) and the CSRF header', async () => {
    const f = mockFetch(json({ text: 'open Anna' }));
    const r = await api.postAudio('/api/voice/transcribe', new Blob(['x'], { type: 'audio/webm;codecs=opus' }));
    expect(r.text).toBe('open Anna');
    expect(init(f).headers['Content-Type']).toBe('audio/webm');
    expect(init(f).headers['X-XO-CSRF']).toBe('tok123');
  });

  it('parses the error shape into ApiError', async () => {
    mockFetch(json({ error: { code: 'not_found', message: 'No such note' } }, 404));
    const e = await api.get('/api/notes/9').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 404, code: 'not_found', message: 'No such note', retryAfter: null });
    expect(session.value).not.toBeNull();
  });

  it('clears the session on 401', async () => {
    mockFetch(json({ error: { code: 'unauthenticated', message: 'Login required' } }, 401));
    await expect(api.get('/api/people')).rejects.toMatchObject({ status: 401 });
    expect(session.value).toBeNull();
  });

  it('exposes Retry-After on 429', async () => {
    mockFetch(json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429, { 'Retry-After': '42' }));
    await expect(api.post('/api/auth/login', { password: 'x', totp: '123456' })).rejects.toMatchObject({ status: 429, retryAfter: 42 });
  });

  it('survives non-JSON error bodies and network failures', async () => {
    mockFetch(new Response('<html>boom</html>', { status: 502 }));
    await expect(api.get('/api/people')).rejects.toMatchObject({ status: 502, code: 'http_error', message: 'Request failed (502).' });
    mockFetch(new TypeError('failed'));
    await expect(api.get('/api/people')).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('rejects a malformed success body', async () => {
    mockFetch(new Response('not json', { status: 200 }));
    await expect(api.get('/api/people')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('refuses paths outside /api (the CSRF token must not leak)', async () => {
    const f = mockFetch(json({}));
    await expect(api.post('https://evil.example/api/x', {})).rejects.toThrow();
    await expect(api.post('//evil.example/api/x', {})).rejects.toThrow();
    await expect(api.get('/other')).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('stale CSRF token', () => {
  it('re-fetches the session on a 403 write and retries once with the new token', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'csrf', message: 'bad csrf' } }, 403))
      .mockResolvedValueOnce(json({ csrfToken: 'fresh' }))
      .mockResolvedValueOnce(json({ id: 1 }, 201));
    vi.stubGlobal('fetch', fn);
    expect(await api.post('/api/people', { name: 'A' })).toEqual({ id: 1 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls[1]![0]).toBe('/api/auth/session');
    expect((fn.mock.calls[2]![1] as { headers: Record<string, string> }).headers['X-XO-CSRF']).toBe('fresh');
    expect(session.value?.csrfToken).toBe('fresh');
  });

  it('does not retry when the token is unchanged, and never retries twice', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'forbidden', message: 'no' } }, 403))
      .mockResolvedValueOnce(json({ csrfToken: 'tok123' }));
    vi.stubGlobal('fetch', fn);
    await expect(api.post('/api/people', {})).rejects.toMatchObject({ status: 403 });
    expect(fn).toHaveBeenCalledTimes(2);

    const fn2 = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'csrf', message: 'x' } }, 403))
      .mockResolvedValueOnce(json({ csrfToken: 'new' }))
      .mockResolvedValueOnce(json({ error: { code: 'csrf', message: 'x' } }, 403));
    vi.stubGlobal('fetch', fn2);
    await expect(api.post('/api/people', {})).rejects.toMatchObject({ status: 403 });
    expect(fn2).toHaveBeenCalledTimes(3);
  });

  it('keeps GET 403s and login 403s as they are', async () => {
    const f = mockFetch(json({ error: { code: 'forbidden', message: 'no' } }, 403));
    await expect(api.get('/api/people')).rejects.toMatchObject({ status: 403 });
    expect(f).toHaveBeenCalledTimes(1);
    const f2 = mockFetch(json({ error: { code: 'forbidden', message: 'no' } }, 403));
    await expect(api.post('/api/auth/login', {})).rejects.toMatchObject({ status: 403 });
    expect(f2).toHaveBeenCalledTimes(1);
  });
});

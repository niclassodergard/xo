import { request } from 'node:http';
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { makeDeps, makeRouteApp } from '../../../test/helpers.ts';
import { FakeTranscriber } from '../llm/fake.ts';
import type { AudioFormat, Transcriber } from '../llm/types.ts';
import { LlmError } from '../llm/types.ts';
import voiceRoutes from './voice.ts';

const post = (app: Awaited<ReturnType<typeof makeRouteApp>>, type: string | undefined, payload: Buffer | string) =>
  app.inject({
    method: 'POST',
    url: '/api/voice/transcribe',
    headers: type ? { 'content-type': type } : {},
    payload,
  });

describe('POST /api/voice/transcribe', () => {
  it('200 with the transcriber text; maps content types to formats (params ignored)', async () => {
    const seen: { size: number; format: AudioFormat }[] = [];
    const transcriber: Transcriber = {
      async transcribe(audio, format) {
        seen.push({ size: audio.length, format });
        return { text: 'hello' };
      },
    };
    const app = await makeRouteApp(voiceRoutes, makeDeps({ transcriber }));
    const audio = Buffer.alloc(100, 1);
    for (const [type, format] of [
      ['audio/webm', 'webm'],
      ['audio/webm;codecs=opus', 'webm'],
      ['Audio/MP4', 'm4a'],
      ['audio/ogg', 'ogg'],
      ['audio/wav', 'wav'],
    ] as const) {
      const res = await post(app, type, audio);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ text: 'hello' });
      expect(seen.at(-1)).toEqual({ size: 100, format });
    }
  });

  it('200 with FakeTranscriber', async () => {
    const app = await makeRouteApp(voiceRoutes, makeDeps({ transcriber: new FakeTranscriber('go to actions') }));
    const res = await post(app, 'audio/webm', Buffer.from('abc'));
    expect(res.json()).toEqual({ text: 'go to actions' });
  });

  it('415 on unsupported content types, including JSON and none', async () => {
    const app = await makeRouteApp(voiceRoutes, makeDeps());
    for (const type of ['audio/mpeg', 'application/json', 'text/plain', 'application/octet-stream']) {
      const res = await post(app, type, Buffer.from('{}'));
      expect(res.statusCode).toBe(415);
    }
    expect((await post(app, undefined, Buffer.from('abc'))).statusCode).toBe(415);
  });

  it('413 above 10 MB', async () => {
    const app = await makeRouteApp(voiceRoutes, makeDeps());
    const res = await post(app, 'audio/webm', Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(res.statusCode).toBe(413);
    expect((await post(app, 'audio/webm', Buffer.alloc(10 * 1024 * 1024))).statusCode).toBe(200);
  });

  it('400 on empty audio', async () => {
    const app = await makeRouteApp(voiceRoutes, makeDeps());
    expect((await post(app, 'audio/webm', Buffer.alloc(0))).statusCode).toBe(400);
  });

  it('503 without a transcriber', async () => {
    const app = await makeRouteApp(voiceRoutes, makeDeps({ transcriber: null }));
    const res = await post(app, 'audio/webm', Buffer.from('abc'));
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('voice_unavailable');
  });

  it('502 on upstream error without leaking its message', async () => {
    const transcriber: Transcriber = {
      async transcribe() {
        throw new LlmError('secret upstream detail');
      },
    };
    const app = await makeRouteApp(voiceRoutes, makeDeps({ transcriber }));
    const res = await post(app, 'audio/webm', Buffer.from('abc'));
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('secret upstream detail');
  });

  it('429 after 30 requests per minute, recovers after the window', async () => {
    let now = new Date('2026-01-15T12:00:00.000Z');
    const app = await makeRouteApp(voiceRoutes, makeDeps({ now: () => now }));
    for (let i = 0; i < 30; i++) expect((await post(app, 'audio/webm', Buffer.from('a'))).statusCode).toBe(200);
    const res = await post(app, 'audio/webm', Buffer.from('a'));
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    now = new Date(now.getTime() + 61_000);
    expect((await post(app, 'audio/webm', Buffer.from('a'))).statusCode).toBe(200);
  });

  it('the audio parser is scoped to the voice route', async () => {
    const app = await makeRouteApp(async (a, o) => {
      a.post('/other', async () => ({ ok: true }));
      await a.register(voiceRoutes, o);
    }, makeDeps());
    const res = await app.inject({ method: 'POST', url: '/api/other', headers: { 'content-type': 'audio/webm' }, payload: 'abc' });
    expect(res.statusCode).toBe(415);
  });

  it('429 when more than 2 transcriptions are in flight; slot is freed afterwards', async () => {
    const gates: (() => void)[] = [];
    const transcriber: Transcriber = {
      transcribe: () => new Promise((res) => gates.push(() => res({ text: 'ok' }))),
    };
    const app = await makeRouteApp(voiceRoutes, makeDeps({ transcriber }));
    const a = post(app, 'audio/webm', Buffer.from('a'));
    const b = post(app, 'audio/webm', Buffer.from('a'));
    await new Promise((r) => setTimeout(r, 30));
    expect(gates).toHaveLength(2);
    const c = await post(app, 'audio/webm', Buffer.from('a'));
    expect(c.statusCode).toBe(429);
    expect(c.json().error.code).toBe('busy');
    gates.forEach((g) => g());
    expect((await a).statusCode).toBe(200);
    expect((await b).statusCode).toBe(200);
    const d = post(app, 'audio/webm', Buffer.from('a'));
    await new Promise((r) => setTimeout(r, 30));
    gates[2]!();
    expect((await d).statusCode).toBe(200);
  });

  it('aborts the upstream call when the client disconnects, and frees the slot', async () => {
    const signals: AbortSignal[] = [];
    const transcriber: Transcriber = {
      transcribe: (_a, _f, signal) =>
        signals.length >= 2
          ? Promise.resolve({ text: 'ok' })
          : new Promise((_res, rej) => {
              signals.push(signal!);
              signal!.addEventListener('abort', () => rej(new LlmError('aborted')));
            }),
    };
    const app = await makeRouteApp(voiceRoutes, makeDeps({ transcriber }));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as { port: number };
    const open = () => {
      const req = request({ host: '127.0.0.1', port, path: '/api/voice/transcribe', method: 'POST', headers: { 'content-type': 'audio/webm' } });
      req.on('error', () => undefined);
      req.end(Buffer.from('abc'));
      return req;
    };
    const reqs = [open(), open()];
    await new Promise((r) => setTimeout(r, 80));
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    reqs.forEach((r) => r.destroy());
    await new Promise((r) => setTimeout(r, 80));
    expect(signals.every((s) => s.aborted)).toBe(true);
    // Both slots were released: a follow-up request is served, not answered with 429 busy.
    const res = await app.inject({ method: 'POST', url: '/api/voice/transcribe', headers: { 'content-type': 'audio/webm' }, payload: Buffer.from('a') });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('destroys stalled uploads after the deadline and frees their slots', async () => {
    const app = await makeRouteApp(
      async (a, o) => voiceRoutes(a, { ...o, uploadDeadlineMs: 60 }),
      makeDeps(),
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as { port: number };
    const stall = () =>
      new Promise<boolean>((resolve) => {
        const sock = connect(port, '127.0.0.1', () => {
          // Announce 1000 bytes, send 3, then go silent.
          sock.write('POST /api/voice/transcribe HTTP/1.1\r\nHost: x\r\nContent-Type: audio/webm\r\nContent-Length: 1000\r\n\r\nabc');
        });
        sock.on('error', () => undefined);
        sock.on('close', () => resolve(true));
      });
    const stalled = [stall(), stall()];
    await new Promise((r) => setTimeout(r, 20));
    // Both slots are taken while the uploads stall.
    const busy = await app.inject({ method: 'POST', url: '/api/voice/transcribe', headers: { 'content-type': 'audio/webm' }, payload: Buffer.from('a') });
    expect(busy.statusCode).toBe(429);
    expect(busy.json().error.code).toBe('busy');
    expect(busy.headers['retry-after']).toBeDefined();
    expect(await Promise.all(stalled)).toEqual([true, true]); // sockets were closed by the server
    const ok = await app.inject({ method: 'POST', url: '/api/voice/transcribe', headers: { 'content-type': 'audio/webm' }, payload: Buffer.from('a') });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it('passes a non-aborted signal on normal completion', async () => {
    let sig: AbortSignal | undefined;
    const transcriber: Transcriber = { transcribe: async (_a, _f, s) => ((sig = s), { text: 'x' }) };
    const app = await makeRouteApp(voiceRoutes, makeDeps({ transcriber }));
    expect((await post(app, 'audio/webm', Buffer.from('a'))).statusCode).toBe(200);
    expect(sig?.aborted).toBe(false);
  });
});

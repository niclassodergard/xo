import { describe, expect, it } from 'vitest';
import { createOpenRouter } from './openrouter.ts';
import { createOpenRouterTranscriber } from './transcriber.ts';
import { LlmError } from './types.ts';

function setup(reply: unknown, status = 200, zdr = true) {
  const calls: { url: string; body: Record<string, any> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, any> });
    return new Response(JSON.stringify(reply), { status });
  }) as unknown as typeof fetch;
  return { t: createOpenRouterTranscriber(createOpenRouter({ apiKey: 'k', zdr, fetch: f }), 'openai/whisper-1'), calls };
}

describe('OpenRouter transcriber', () => {
  it('sends base64 audio + format + model + zdr, no language, and returns the text', async () => {
    const { t, calls } = setup({ text: '  open Anna ', usage: { seconds: 1 } });
    const audio = Buffer.from([1, 2, 3, 250, 251]);
    expect(await t.transcribe(audio, 'm4a')).toEqual({ text: 'open Anna' });
    const call = calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(call.body['model']).toBe('openai/whisper-1');
    expect(call.body['input_audio']).toEqual({ data: audio.toString('base64'), format: 'm4a' });
    expect(call.body['provider']['zdr']).toBe(true);
    expect(call.body).not.toHaveProperty('language');
  });

  it('zdr off: provider.zdr not sent', async () => {
    const { t, calls } = setup({ text: 'x' }, 200, false);
    await t.transcribe(Buffer.from('a'), 'wav');
    expect(calls[0]!.body['provider']).toEqual({});
  });

  it('uses a 90 s timeout', async () => {
    const seen: unknown[] = [];
    const spy = { chat: async () => ({}), transcribe: async (_b: unknown, o: unknown) => { seen.push(o); return { text: 'x' }; } };
    await createOpenRouterTranscriber(spy, 'm').transcribe(Buffer.from('a'), 'wav', new AbortController().signal);
    expect(seen[0]).toMatchObject({ timeoutMs: 90_000 });
    expect((seen[0] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it('upstream error with zdr off: one call only', async () => {
    const { t, calls } = setup({}, 500, false);
    await expect(t.transcribe(Buffer.from('a'), 'wav')).rejects.toBeInstanceOf(LlmError);
    expect(calls).toHaveLength(1);
  });

  it('rejects an unexpected reply shape', async () => {
    for (const reply of [{}, { text: 5 }, null, 'x']) {
      await expect(setup(reply).t.transcribe(Buffer.from('a'), 'wav')).rejects.toBeInstanceOf(LlmError);
    }
  });

  it('upstream error is an LlmError', async () => {
    await expect(setup({ error: 'x' }, 500).t.transcribe(Buffer.from('a'), 'webm')).rejects.toBeInstanceOf(LlmError);
  });
});

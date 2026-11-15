import { LlmError } from './types.ts';

// Hard-coded on purpose: the base URL is not configurable, so a bad env value cannot redirect the key.
const BASE_URL = 'https://openrouter.ai/api/v1';
/** Responses are small JSON documents; anything bigger is treated as a failure. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** Every call states its own timeout: classification and transcription need different ones. */
export interface CallOptions { timeoutMs: number; signal?: AbortSignal }

export interface OpenRouterClient {
  /** POST /chat/completions. Resolves with the parsed JSON response (untrusted: validate it). */
  chat(body: Record<string, unknown>, opts: CallOptions): Promise<unknown>;
  /** POST /audio/transcriptions (JSON body form). Resolves with the parsed JSON response (untrusted). */
  transcribe(body: Record<string, unknown>, opts: CallOptions): Promise<unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * zdr on: `provider.zdr = true` is forced (whatever the caller passed is overwritten).
 * zdr off: `provider.zdr` is not sent at all; other provider options are kept.
 */
function withProvider(body: Record<string, unknown>, zdr: boolean): Record<string, unknown> {
  const { zdr: _ignored, ...provider } = isPlainObject(body['provider']) ? body['provider'] : {};
  return { ...body, provider: zdr ? { ...provider, zdr: true } : provider };
}

async function readBounded(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new LlmError('openrouter response too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new LlmError('openrouter response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createOpenRouter(opts: { apiKey: string; zdr: boolean; fetch?: typeof fetch }): OpenRouterClient {
  const { apiKey, zdr } = opts;
  if (!apiKey) throw new Error('OpenRouter API key is required');
  const doFetch = opts.fetch ?? fetch;

  async function post(path: string, body: Record<string, unknown>, call: CallOptions): Promise<unknown> {
    // Plugins (web search etc.) and tools would send data elsewhere or cost money; XO never uses them.
    if ('plugins' in body || 'tools' in body) throw new LlmError('request body not allowed');
    const { signal, timeoutMs } = call;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(`${BASE_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: combined,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(withProvider(body, zdr)),
      });
    } catch {
      // The underlying error is dropped on purpose: it must not carry the URL, key or request text.
      if (timeout.aborted) throw new LlmError('openrouter request timed out');
      if (signal?.aborted) throw new LlmError('openrouter request aborted');
      throw new LlmError('openrouter request failed');
    }
    try {
      if (!res.ok) {
        // Drain without keeping the body: upstream bodies never reach errors or logs.
        await res.body?.cancel().catch(() => undefined);
        throw new LlmError(`openrouter request failed with status ${res.status}`);
      }
      const text = await readBounded(res);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new LlmError('openrouter returned invalid JSON');
      }
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (timeout.aborted) throw new LlmError('openrouter request timed out');
      if (signal?.aborted) throw new LlmError('openrouter request aborted');
      throw new LlmError('openrouter request failed');
    }
  }

  return {
    chat: (body, call) => post('/chat/completions', body, call),
    transcribe: (body, call) => post('/audio/transcriptions', body, call),
  };
}

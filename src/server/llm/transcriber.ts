import type { OpenRouterClient } from './openrouter.ts';
import type { AudioFormat, Transcriber } from './types.ts';
import { LlmError } from './types.ts';

// OpenRouter's STT upstream times out at 60 s; allow a little more.
const TIMEOUT_MS = 90_000;
const MAX_TEXT_CHARS = 100_000;

/**
 * JSON body form of the OpenRouter transcription API. No `language` parameter: the language is
 * auto-detected (the user mixes languages).
 */
export function createOpenRouterTranscriber(client: OpenRouterClient, model: string): Transcriber {
  return {
    async transcribe(audio: Buffer, format: AudioFormat, signal?: AbortSignal): Promise<{ text: string }> {
      const reply = await client.transcribe(
        { model, input_audio: { data: audio.toString('base64'), format } },
        { signal, timeoutMs: TIMEOUT_MS },
      );
      const text = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>)['text'] : undefined;
      if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS) {
        throw new LlmError('transcription reply had an unexpected shape');
      }
      return { text: text.trim() };
    },
  };
}

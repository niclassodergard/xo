import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps.ts';
import { sendError } from '../errors.ts';
import type { AudioFormat } from '../llm/types.ts';
import { LlmError } from '../llm/types.ts';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_IN_FLIGHT = 2;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const FORMATS: Record<string, AudioFormat> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
};

/** Media type without parameters (`audio/webm;codecs=opus` -> `audio/webm`), lower-cased. */
function mediaType(header: string | undefined): string {
  return (header ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

const UPLOAD_DEADLINE_MS = 60_000;

// Contract for the client (step 10): every 429 from this route carries a Retry-After header and an
// error code of either `rate_limited` (per-minute limit) or `busy` (too many in flight).
export default async function routes(
  app: FastifyInstance,
  opts: { deps: AppDeps; uploadDeadlineMs?: number },
): Promise<void> {
  const { deps } = opts;
  const deadlineMs = opts.uploadDeadlineMs ?? UPLOAD_DEADLINE_MS;

  // Registered inside this plugin's own (encapsulated) context, so raw audio is parsed here only.
  // Every other route keeps Fastify's JSON-only behaviour. Fastify matches on the media type and
  // ignores parameters such as `;codecs=opus`.
  app.addContentTypeParser(Object.keys(FORMATS), { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES }, (_req, body, done) => {
    done(null, body);
  });

  // Simple in-memory limiter: single user, single process. Timestamps of recent requests.
  let recent: number[] = [];
  const rateLimit = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = deps.now().getTime();
    recent = recent.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      const wait = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - recent[0]!)) / 1000));
      reply.header('Retry-After', String(wait));
      req.log.warn('voice transcription rate limit hit');
      return sendError(reply, 429, 'rate_limited', 'Too many requests') as unknown as void;
    }
    recent.push(now);
  };
  // At most MAX_IN_FLIGHT uploads/transcriptions at once: up to 10 MB bodies are held in memory.
  // Taken before the body is read, released when the response is done or the connection closes.
  let inFlight = 0;
  // A stalled (slow-loris) upload must not hold a slot forever: if the handler has not started within
  // the deadline, the socket is destroyed, which also frees the slot through the close listener.
  const deadlines = new WeakMap<FastifyRequest, NodeJS.Timeout>();
  const limitConcurrency = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (inFlight >= MAX_IN_FLIGHT) {
      reply.header('Retry-After', '5');
      return sendError(reply, 429, 'busy', 'Too many transcriptions in progress') as unknown as void;
    }
    inFlight++;
    let released = false;
    const release = (): void => {
      clearTimeout(timer);
      if (!released) {
        released = true;
        inFlight--;
      }
    };
    const timer = setTimeout(() => {
      release();
      req.raw.socket.destroy();
    }, deadlineMs);
    timer.unref();
    deadlines.set(req, timer);
    reply.raw.once('close', release);
  };
  const requireTranscriber = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.transcriber) {
      return sendError(reply, 503, 'voice_unavailable', 'Transcription is not configured') as unknown as void;
    }
  };

  app.post(
    '/voice/transcribe',
    {
      schema: { querystring: { type: 'object', additionalProperties: false } },
      bodyLimit: MAX_AUDIO_BYTES,
      // Run before the body is read, so rejected requests cost no upload handling.
      onRequest: [requireTranscriber, rateLimit, limitConcurrency],
    },
    async (req, reply) => {
      clearTimeout(deadlines.get(req)); // the body has arrived in time
      const transcriber = deps.transcriber;
      if (!transcriber) return sendError(reply, 503, 'voice_unavailable', 'Transcription is not configured');
      const format = FORMATS[mediaType(req.headers['content-type'])];
      const audio = req.body;
      if (!format || !Buffer.isBuffer(audio)) {
        return sendError(reply, 415, 'unsupported_media_type', 'Unsupported audio type');
      }
      if (audio.length === 0) return sendError(reply, 400, 'bad_request', 'Empty audio');
      // Stop the upstream call (and its cost) if the client goes away before we have answered.
      const ac = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableEnded) ac.abort();
      };
      reply.raw.once('close', onClose);
      try {
        const { text } = await transcriber.transcribe(audio, format, ac.signal);
        return { text };
      } catch (err) {
        // Log only the error class; never the message, audio or transcript.
        req.log.warn({ err: { type: err instanceof LlmError ? 'LlmError' : 'unknown' } }, 'transcription failed');
        return sendError(reply, 502, 'upstream_error', 'Transcription failed');
      } finally {
        reply.raw.removeListener('close', onClose);
      }
    },
  );
}

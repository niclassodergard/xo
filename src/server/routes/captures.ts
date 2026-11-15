import type { FastifyInstance, FastifyReply } from 'fastify';
import { LIMITS } from '../../shared/api.ts';
import type { AnswerCaptureRequest, CreateCaptureRequest } from '../../shared/api.ts';
import { createCaptureService } from '../capture/service.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError, sendError } from '../errors.ts';
import { createQaService } from '../qa/service.ts';

const ID = { type: 'string', pattern: '^[0-9]{1,15}$' } as const;
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID } } as const;
const noQuery = { type: 'object', additionalProperties: false } as const;
const LIMIT_PARAM = { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9]{2}|200)$' } as const;

function requireNoBody(body: unknown): void {
  const empty = body === undefined || body === null || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
  if (!empty) throw new HttpError(400, 'validation_error', 'body must be empty');
}

const ASK_RATE_LIMIT = 20;
const ASK_RATE_WINDOW_MS = 60_000;
const ASK_MAX_IN_FLIGHT = 2;
const ASK_DEADLINE_MS = 45_000;

// Contract for the client: POST /captures/:id/ask answers 200 `Capture` (status `answered`), 404, 409 `not_asked`,
// 429 `rate_limited` or `busy` (both with Retry-After), 502 `llm_failed` (the capture stays `asked`), 503 `no_llm`.
export default async function routes(app: FastifyInstance, opts: { deps: AppDeps; askDeadlineMs?: number }): Promise<void> {
  const { deps } = opts;
  // Diagnostics carry fixed messages and error class names only, never capture text.
  const service = createCaptureService(deps, { warn: (m) => app.log.warn(m) });
  // Diagnostics: error class names only, never the question, the excerpts or the answer.
  const qa = createQaService(deps, { timeoutMs: opts.askDeadlineMs ?? ASK_DEADLINE_MS, warn: (m) => app.log.warn(m) });
  const notFound = (): HttpError => new HttpError(404, 'not_found', 'Capture not found');

  // Simple in-memory limits (single user, single process): requests per minute, and answers in progress.
  let recentAsks: number[] = [];
  let asksInFlight = 0;
  const refuse = (reply: FastifyReply, code: 'rate_limited' | 'busy', message: string, retryAfter: number): FastifyReply => {
    reply.header('Retry-After', String(retryAfter));
    return sendError(reply, 429, code, message);
  };

  app.get<{ Querystring: { limit?: string; before?: string } }>(
    '/captures',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { limit: LIMIT_PARAM, before: ID } },
      },
    },
    async (req) => ({
      captures: service.list({
        limit: req.query.limit !== undefined ? Number(req.query.limit) : 50,
        ...(req.query.before !== undefined ? { before: Number(req.query.before) } : {}),
      }),
    }),
  );

  app.post<{ Body: CreateCaptureRequest }>(
    '/captures',
    {
      // Text is capped at 10 000 characters (up to 6 bytes each when JSON-escaped).
      bodyLimit: 128 * 1024,
      schema: {
        querystring: noQuery,
        body: {
          type: 'object', required: ['text', 'source'], additionalProperties: false,
          properties: {
            text: { type: 'string', minLength: 1, maxLength: LIMITS.captureText },
            source: { type: 'string', enum: ['text', 'voice'] },
          },
        },
      },
    },
    async (req, reply) => reply.code(201).send(await service.submit(req.body.text, req.body.source)),
  );

  app.post<{ Params: { id: string }; Body: AnswerCaptureRequest }>(
    '/captures/:id/answer',
    {
      schema: {
        params: idParams,
        querystring: noQuery,
        body: {
          type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1,
          properties: {
            key: { type: 'string', minLength: 1, maxLength: 1 },
            personId: { type: 'integer', minimum: 1 },
            projectId: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req) => {
      const res = await service.answer(Number(req.params.id), req.body);
      if (res === 'not_found') throw notFound();
      if (res === 'not_pending') throw new HttpError(409, 'conflict', 'Capture is not waiting for an answer');
      if (res === 'bad_answer') throw new HttpError(400, 'bad_answer', 'Not a valid answer to this question');
      return res;
    },
  );

  app.post<{ Params: { id: string } }>('/captures/:id/ask', { schema: { params: idParams, querystring: noQuery } }, async (req, reply) => {
    requireNoBody(req.body);
    if (!deps.answerer) return sendError(reply, 503, 'no_llm', 'Answering questions is not configured');
    const now = deps.now().getTime();
    recentAsks = recentAsks.filter((t) => now - t < ASK_RATE_WINDOW_MS);
    if (recentAsks.length >= ASK_RATE_LIMIT) {
      req.log.warn('question answering rate limit hit');
      return refuse(reply, 'rate_limited', 'Too many requests', Math.max(1, Math.ceil((ASK_RATE_WINDOW_MS - (now - recentAsks[0]!)) / 1000)));
    }
    if (asksInFlight >= ASK_MAX_IN_FLIGHT) return refuse(reply, 'busy', 'Too many questions in progress', 5);
    recentAsks.push(now);
    // The slot is freed here, in `finally`: after the answer, the failure, the abort or the service deadline.
    asksInFlight++;
    const ac = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableEnded) ac.abort(); // the client went away: stop the upstream call (and its cost)
    };
    reply.raw.once('close', onClose);
    try {
      const res = await qa.ask(Number(req.params.id), ac.signal);
      if (res === 'not_found') throw notFound();
      if (res === 'not_asked') throw new HttpError(409, 'not_asked', 'Capture is not waiting for an answer');
      if (res === 'busy') return refuse(reply, 'busy', 'This question is already being answered', 5);
      if (res === 'no_llm') return sendError(reply, 503, 'no_llm', 'Answering questions is not configured');
      if (res === 'failed') return sendError(reply, 502, 'llm_failed', 'Could not get an answer');
      return res;
    } finally {
      asksInFlight--;
      reply.raw.removeListener('close', onClose);
    }
  });

  app.post<{ Params: { id: string } }>('/captures/:id/undo', { schema: { params: idParams, querystring: noQuery } }, async (req) => {
    requireNoBody(req.body);
    const res = service.undo(Number(req.params.id));
    if (res === 'not_found') throw notFound();
    if (res === 'not_filed') throw new HttpError(409, 'conflict', 'Capture is not filed');
    if (res === 'gone') throw new HttpError(409, 'gone', 'The filed item no longer exists');
    return res;
  });

  app.post<{ Params: { id: string } }>('/captures/:id/reclassify', { schema: { params: idParams, querystring: noQuery } }, async (req) => {
    requireNoBody(req.body);
    const res = service.reclassify(Number(req.params.id));
    if (res === 'not_found') throw notFound();
    if (res === 'not_filed') throw new HttpError(409, 'conflict', 'Capture is not filed');
    if (res === 'gone') throw new HttpError(409, 'gone', 'The filed item no longer exists');
    return res;
  });
}

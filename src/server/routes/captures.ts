import type { FastifyInstance } from 'fastify';
import { LIMITS } from '../../shared/api.ts';
import type { AnswerCaptureRequest, CreateCaptureRequest } from '../../shared/api.ts';
import { createCaptureService } from '../capture/service.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';

const ID = { type: 'string', pattern: '^[0-9]{1,15}$' } as const;
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID } } as const;
const noQuery = { type: 'object', additionalProperties: false } as const;
const LIMIT_PARAM = { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9]{2}|200)$' } as const;

function requireNoBody(body: unknown): void {
  const empty = body === undefined || body === null || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
  if (!empty) throw new HttpError(400, 'validation_error', 'body must be empty');
}

export default async function routes(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;
  // Diagnostics carry fixed messages and error class names only, never capture text.
  const service = createCaptureService(deps, { warn: (m) => app.log.warn(m) });
  const notFound = (): HttpError => new HttpError(404, 'not_found', 'Capture not found');

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

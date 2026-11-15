import type { FastifyInstance } from 'fastify';
import type { TouchRecentRequest } from '../../shared/api.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import { getNav, pin, touchRecent, unpin } from '../repos/nav.ts';
import type { PinKind } from '../repos/nav.ts';

const ID = { type: 'string', pattern: '^[0-9]{1,15}$' } as const;
const pinParams = {
  type: 'object', required: ['kind', 'id'], additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['person', 'project'] }, id: ID },
} as const;
const noQuery = { type: 'object', additionalProperties: false } as const;
const notFound = (): HttpError => new HttpError(404, 'not_found', 'Item not found');
// Bodyless requests: an absent body (or `{}`) is fine, anything else is rejected.
function requireNoBody(body: unknown): void {
  const empty = body === undefined || body === null || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
  if (!empty) throw new HttpError(400, 'validation_error', 'body must be empty');
}

export default async function routes(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;

  app.get('/nav', { schema: { querystring: noQuery } }, async () => getNav(deps.db));

  app.put<{ Params: { kind: PinKind; id: string } }>(
    '/nav/pins/:kind/:id',
    { schema: { params: pinParams, querystring: noQuery } },
    async (req, reply) => {
      requireNoBody(req.body);
      const r = pin(deps.db, req.params.kind, Number(req.params.id), deps.now());
      if (r === 'missing') throw notFound();
      if (r === 'too_many') throw new HttpError(409, 'too_many', 'Too many pinned items');
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { kind: PinKind; id: string } }>(
    '/nav/pins/:kind/:id',
    { schema: { params: pinParams, querystring: noQuery } },
    async (req, reply) => {
      requireNoBody(req.body);
      unpin(deps.db, req.params.kind, Number(req.params.id));
      return reply.code(204).send();
    },
  );

  app.post<{ Body: TouchRecentRequest }>(
    '/nav/recents',
    {
      schema: {
        querystring: noQuery,
        body: {
          type: 'object', required: ['kind', 'id'], additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['person', 'project', 'meeting', 'note'] },
            id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
      },
    },
    async (req, reply) => {
      if (!touchRecent(deps.db, req.body.kind, req.body.id, deps.now())) throw notFound();
      return reply.code(204).send();
    },
  );
}

import type { FastifyInstance } from 'fastify';
import type { SearchRequest } from '../../shared/api.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import { search } from '../repos/search.ts';

// POST on purpose: search text must not appear in URLs or proxy logs.
export default async function routes(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;

  app.post<{ Body: SearchRequest }>(
    '/search',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false },
        body: {
          type: 'object', required: ['q'], additionalProperties: false,
          properties: {
            q: { type: 'string', minLength: 2, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (req) => {
      const q = req.body.q.trim();
      if (Array.from(q).length < 2) throw new HttpError(400, 'validation_error', 'q must be at least 2 characters');
      return { results: search(deps.db, q, req.body.limit ?? 50) };
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { LIMITS } from '../../shared/api.ts';
import type { UpdateMeetingRequest } from '../../shared/api.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import { getPerson, listMeetingHeaders } from '../repos/people.ts';
import { endMeeting, getMeetingDetail, hasActiveMeeting, startMeeting, updateMeetingNotes } from '../repos/meetings.ts';

const ID = { type: 'string', pattern: '^[0-9]{1,15}$' } as const;
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID } } as const;

const noQuery = { type: 'object', additionalProperties: false } as const;
// Bodyless POSTs: an absent body (or `{}`) is fine, anything else is rejected. An ajv body schema
// cannot express "optional", because an absent body fails `type: object`, so the handler checks.
function requireNoBody(body: unknown): void {
  const empty = body === undefined || body === null || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
  if (!empty) throw new HttpError(400, 'validation_error', 'body must be empty');
}
const LIMIT_PARAM = { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9]{2}|200)$' } as const;
const notFound = (what: string): HttpError => new HttpError(404, 'not_found', `${what} not found`);

export default async function routes(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;

  // Meeting headers (notes previews only) for paging back through history.
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    '/people/:id/meetings',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { limit: LIMIT_PARAM, before: { type: 'string', pattern: '^[0-9]{1,15}$' } },
        },
      },
    },
    async (req) => {
      const personId = Number(req.params.id);
      if (!getPerson(deps.db, personId)) throw notFound('Person');
      const { limit, before } = req.query;
      return {
        meetings: listMeetingHeaders(deps.db, personId, {
          limit: limit !== undefined ? Number(limit) : 50,
          ...(before !== undefined ? { before: Number(before) } : {}),
        }),
      };
    },
  );

  // 201 when a meeting is created, 200 when the one already in progress is returned.
  app.post<{ Params: { id: string } }>('/people/:id/meetings', { schema: { params: idParams, querystring: noQuery } }, async (req, reply) => {
    requireNoBody(req.body);
    const personId = Number(req.params.id);
    const resumed = hasActiveMeeting(deps.db, personId);
    const detail = startMeeting(deps.db, personId, deps.now());
    if (!detail) throw notFound('Person');
    return reply.code(resumed ? 200 : 201).send(detail);
  });

  app.get<{ Params: { id: string } }>('/meetings/:id', { schema: { params: idParams, querystring: noQuery } }, async (req) => {
    const d = getMeetingDetail(deps.db, Number(req.params.id));
    if (!d) throw notFound('Meeting');
    return d;
  });

  app.patch<{ Params: { id: string }; Body: UpdateMeetingRequest }>(
    '/meetings/:id',
    {
      schema: {
        params: idParams,
        querystring: noQuery,
        body: {
          type: 'object', required: ['notesMd'], additionalProperties: false,
          properties: { notesMd: { type: 'string', maxLength: LIMITS.markdown } },
        },
      },
    },
    async (req) => {
      const m = updateMeetingNotes(deps.db, Number(req.params.id), req.body.notesMd);
      if (!m) throw notFound('Meeting');
      return m;
    },
  );

  app.post<{ Params: { id: string } }>('/meetings/:id/end', { schema: { params: idParams, querystring: noQuery } }, async (req) => {
    requireNoBody(req.body);
    const m = endMeeting(deps.db, Number(req.params.id), deps.now());
    if (!m) throw notFound('Meeting');
    return m;
  });
}

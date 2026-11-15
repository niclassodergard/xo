import type { FastifyInstance } from 'fastify';
import { LIMITS } from '../../shared/api.ts';
import type { CreatePersonRequest, UpdatePersonRequest } from '../../shared/api.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import { createPerson, getPersonDetailSummary, listPeople, updatePerson } from '../repos/people.ts';

const ID = { type: 'string', pattern: '^[0-9]{1,15}$' } as const;
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID } } as const;
const name = { type: 'string', minLength: 1, maxLength: LIMITS.name } as const;
const aliases = { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: LIMITS.name } } as const;

const noQuery = { type: 'object', additionalProperties: false } as const;
const notFound = (): HttpError => new HttpError(404, 'not_found', 'Person not found');
const blankName = (): HttpError => new HttpError(400, 'validation_error', 'name must not be blank');

export default async function routes(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;

  app.get<{ Querystring: { includeArchived?: string } }>(
    '/people',
    {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { includeArchived: { type: 'string', enum: ['0', '1', 'true', 'false'] } },
        },
      },
    },
    async (req) => {
      const inc = req.query.includeArchived;
      return { people: listPeople(deps.db, { includeArchived: inc === '1' || inc === 'true' }) };
    },
  );

  app.post<{ Body: CreatePersonRequest }>(
    '/people',
    {
      schema: {
        querystring: noQuery,
        body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name, aliases } },
      },
    },
    async (req, reply) => {
      if (req.body.name.trim() === '') throw blankName();
      return reply.code(201).send(createPerson(deps.db, req.body, deps.now()));
    },
  );

  app.get<{ Params: { id: string } }>('/people/:id', { schema: { params: idParams, querystring: noQuery } }, async (req) => {
    const detail = getPersonDetailSummary(deps.db, Number(req.params.id));
    if (!detail) throw notFound();
    return detail;
  });

  app.patch<{ Params: { id: string }; Body: UpdatePersonRequest }>(
    '/people/:id',
    {
      schema: {
        params: idParams,
        querystring: noQuery,
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: { name, aliases, notesMd: { type: 'string', maxLength: LIMITS.markdown }, archived: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      if (req.body.name !== undefined && req.body.name.trim() === '') throw blankName();
      const p = updatePerson(deps.db, Number(req.params.id), req.body, deps.now());
      if (!p) throw notFound();
      return p;
    },
  );
}

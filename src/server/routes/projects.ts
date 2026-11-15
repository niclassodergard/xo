import type { FastifyInstance } from 'fastify';
import { LIMITS } from '../../shared/api.ts';
import type { CreateProjectRequest, UpdateProjectRequest } from '../../shared/api.ts';
import type { ProjectStatus } from '../../shared/types.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import {
  createProject, getProjectDetail, linkPerson, listProjects, softDeleteProject, unlinkPerson, updateProject,
} from '../repos/projects.ts';

const ID = { type: 'string', pattern: '^[0-9]{1,15}$' } as const;
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID } } as const;
const linkParams = {
  type: 'object', required: ['id', 'personId'], additionalProperties: false, properties: { id: ID, personId: ID },
} as const;
const title = { type: 'string', minLength: 1, maxLength: LIMITS.name } as const;
const aliases = { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: LIMITS.name } } as const;
const status = { type: 'string', enum: ['active', 'on_hold', 'done'] } as const;
const descriptionMd = { type: 'string', maxLength: LIMITS.markdown } as const;

const noQuery = { type: 'object', additionalProperties: false } as const;
const notFound = (): HttpError => new HttpError(404, 'not_found', 'Project not found');
// Bodyless requests: an absent body (or `{}`) is fine, anything else is rejected.
function requireNoBody(body: unknown): void {
  const empty = body === undefined || body === null || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
  if (!empty) throw new HttpError(400, 'validation_error', 'body must be empty');
}
const blankTitle = (): HttpError => new HttpError(400, 'validation_error', 'title must not be blank');

export default async function routes(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;

  app.get<{ Querystring: { status?: ProjectStatus | 'all' } }>(
    '/projects',
    {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { status: { type: 'string', enum: ['active', 'on_hold', 'done', 'all'] } },
        },
      },
    },
    async (req) => ({ projects: listProjects(deps.db, { status: req.query.status ?? 'all' }) }),
  );

  app.post<{ Body: CreateProjectRequest }>(
    '/projects',
    {
      schema: {
        querystring: noQuery,
        body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title, aliases, status, descriptionMd } },
      },
    },
    async (req, reply) => {
      if (req.body.title.trim() === '') throw blankTitle();
      return reply.code(201).send(createProject(deps.db, req.body, deps.now()));
    },
  );

  app.get<{ Params: { id: string } }>('/projects/:id', { schema: { params: idParams, querystring: noQuery } }, async (req) => {
    const d = getProjectDetail(deps.db, Number(req.params.id));
    if (!d) throw notFound();
    return d;
  });

  app.patch<{ Params: { id: string }; Body: UpdateProjectRequest }>(
    '/projects/:id',
    {
      schema: {
        params: idParams,
        querystring: noQuery,
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { title, aliases, status, descriptionMd } },
      },
    },
    async (req) => {
      if (req.body.title !== undefined && req.body.title.trim() === '') throw blankTitle();
      const p = updateProject(deps.db, Number(req.params.id), req.body, deps.now());
      if (!p) throw notFound();
      return p;
    },
  );

  app.delete<{ Params: { id: string } }>('/projects/:id', { schema: { params: idParams, querystring: noQuery } }, async (req, reply) => {
    if (!softDeleteProject(deps.db, Number(req.params.id), deps.now())) throw notFound();
    return reply.code(204).send();
  });

  app.put<{ Params: { id: string; personId: string } }>(
    '/projects/:id/people/:personId',
    { schema: { params: linkParams, querystring: noQuery } },
    async (req, reply) => {
      requireNoBody(req.body);
      if (!linkPerson(deps.db, Number(req.params.id), Number(req.params.personId), deps.now())) {
        throw new HttpError(404, 'not_found', 'Project or person not found');
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; personId: string } }>(
    '/projects/:id/people/:personId',
    { schema: { params: linkParams, querystring: noQuery } },
    async (req, reply) => {
      requireNoBody(req.body);
      if (!unlinkPerson(deps.db, Number(req.params.id), Number(req.params.personId))) {
        throw new HttpError(404, 'not_found', 'Project or person not found');
      }
      return reply.code(204).send();
    },
  );
}

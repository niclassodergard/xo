import type { FastifyInstance } from 'fastify';
import { LIMITS } from '../../shared/api.ts';
import type { CreateNoteRequest, UpdateNoteRequest } from '../../shared/api.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import { createNote, getNote, listNoteSummaries, softDeleteNote, updateNote } from '../repos/notes.ts';
import { getPerson } from '../repos/people.ts';
import { getProject } from '../repos/projects.ts';

const ID = { type: 'string', pattern: '^[0-9]{1,15}$' } as const;
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID } } as const;
const title = { type: 'string', maxLength: LIMITS.name } as const;
const personId = { type: ['integer', 'null'], minimum: 1 } as const;
const projectId = { type: ['integer', 'null'], minimum: 1 } as const;

const noQuery = { type: 'object', additionalProperties: false } as const;
const LIMIT_PARAM = { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9]{2}|200)$' } as const;
const notFound = (): HttpError => new HttpError(404, 'not_found', 'Note not found');

export default async function routes(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;

  function checkPerson(id: number | null | undefined): void {
    if (id !== null && id !== undefined && !getPerson(deps.db, id)) {
      throw new HttpError(400, 'invalid_person', 'Person does not exist');
    }
  }

  function checkProject(id: number | null | undefined): void {
    if (id !== null && id !== undefined && !getProject(deps.db, id)) {
      throw new HttpError(400, 'validation_error', 'Project does not exist');
    }
  }

  app.get<{ Querystring: { personId?: string; projectId?: string; limit?: string; before?: string } }>(
    '/notes',
    {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { personId: ID, projectId: { type: 'string', pattern: '^([0-9]{1,15}|none)$' }, limit: LIMIT_PARAM, before: ID },
        },
      },
    },
    async (req) => {
      const { personId: pid, projectId: prj, limit, before } = req.query;
      return {
        notes: listNoteSummaries(deps.db, {
          ...(pid !== undefined ? { personId: Number(pid) } : {}),
          ...(prj !== undefined ? { projectId: prj === 'none' ? ('none' as const) : Number(prj) } : {}),
          ...(limit !== undefined ? { limit: Number(limit) } : {}),
          ...(before !== undefined ? { before: Number(before) } : {}),
        }),
      };
    },
  );

  app.post<{ Body: CreateNoteRequest }>(
    '/notes',
    {
      schema: {
        querystring: noQuery,
        body: {
          type: 'object', required: ['bodyMd'], additionalProperties: false,
          properties: { title, bodyMd: { type: 'string', minLength: 1, maxLength: LIMITS.markdown }, personId, projectId },
        },
      },
    },
    async (req, reply) => {
      checkPerson(req.body.personId);
      checkProject(req.body.projectId);
      return reply.code(201).send(createNote(deps.db, req.body, deps.now()));
    },
  );

  app.get<{ Params: { id: string } }>('/notes/:id', { schema: { params: idParams, querystring: noQuery } }, async (req) => {
    const n = getNote(deps.db, Number(req.params.id));
    if (!n) throw notFound();
    return n;
  });

  app.patch<{ Params: { id: string }; Body: UpdateNoteRequest }>(
    '/notes/:id',
    {
      schema: {
        params: idParams,
        querystring: noQuery,
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: { title, bodyMd: { type: 'string', maxLength: LIMITS.markdown }, personId, projectId },
        },
      },
    },
    async (req) => {
      checkPerson(req.body.personId);
      const cur = getNote(deps.db, Number(req.params.id));
      if (!cur) throw notFound();
      if (req.body.projectId !== undefined && req.body.projectId !== cur.projectId) checkProject(req.body.projectId);
      const n = updateNote(deps.db, Number(req.params.id), req.body, deps.now());
      if (!n) throw notFound();
      return n;
    },
  );

  app.delete<{ Params: { id: string } }>('/notes/:id', { schema: { params: idParams, querystring: noQuery } }, async (req, reply) => {
    if (!softDeleteNote(deps.db, Number(req.params.id), deps.now())) throw notFound();
    return reply.code(204).send();
  });
}

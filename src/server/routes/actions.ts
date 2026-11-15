import type { FastifyInstance } from 'fastify';
import { LIMITS } from '../../shared/api.ts';
import type { CreateActionRequest, UpdateActionRequest } from '../../shared/api.ts';
import type { Owner } from '../../shared/types.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import { createAction, getAction, listActions, softDeleteAction, updateAction } from '../repos/actions.ts';
import { getMeeting } from '../repos/meetings.ts';
import { getPerson } from '../repos/people.ts';
import { getProject } from '../repos/projects.ts';

const ID = { type: 'string', pattern: '^[0-9]{1,15}$' } as const;
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID } } as const;
const text = { type: 'string', minLength: 1, maxLength: LIMITS.captureText } as const;
const owner = { type: 'string', enum: ['me', 'them'] } as const;
const nullableId = { type: ['integer', 'null'], minimum: 1 } as const;

const noQuery = { type: 'object', additionalProperties: false } as const;
const LIMIT_PARAM = { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9]{2}|200)$' } as const;
const notFound = (): HttpError => new HttpError(404, 'not_found', 'Action not found');

export default async function routes(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;

  function checkPerson(personId: number | null | undefined): void {
    if (personId !== null && personId !== undefined && !getPerson(deps.db, personId)) {
      throw new HttpError(400, 'invalid_person', 'Person does not exist');
    }
  }

  function checkProject(projectId: number | null | undefined): void {
    if (projectId !== null && projectId !== undefined && !getProject(deps.db, projectId)) {
      throw new HttpError(400, 'validation_error', 'Project does not exist');
    }
  }

  app.get<{ Querystring: { status?: 'open' | 'done' | 'all'; owner?: Owner; personId?: string; projectId?: string; limit?: string; before?: string } }>(
    '/actions',
    {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['open', 'done', 'all'] }, owner, personId: ID,
            projectId: { type: 'string', pattern: '^([0-9]{1,15}|none)$' }, limit: LIMIT_PARAM, before: ID },
        },
      },
    },
    async (req) => {
      const { status, owner: o, personId, projectId, limit, before } = req.query;
      return {
        actions: listActions(deps.db, {
          ...(status !== undefined ? { status } : {}),
          ...(o !== undefined ? { owner: o } : {}),
          ...(personId !== undefined ? { personId: Number(personId) } : {}),
          ...(projectId !== undefined ? { projectId: projectId === 'none' ? ('none' as const) : Number(projectId) } : {}),
          limit: limit !== undefined ? Number(limit) : 100,
          ...(before !== undefined ? { before: Number(before) } : {}),
        }),
      };
    },
  );

  app.post<{ Body: CreateActionRequest }>(
    '/actions',
    {
      schema: {
        querystring: noQuery,
        body: {
          type: 'object', required: ['text'], additionalProperties: false,
          properties: { text, owner, personId: nullableId, meetingId: nullableId, projectId: nullableId },
        },
      },
    },
    async (req, reply) => {
      if (req.body.text.trim() === '') throw new HttpError(400, 'validation_error', 'text must not be blank');
      checkPerson(req.body.personId);
      checkProject(req.body.projectId);
      let personId = req.body.personId ?? null;
      if (req.body.meetingId !== undefined && req.body.meetingId !== null) {
        // A follow-up belongs to the meeting's person: default to it, reject an explicit mismatch.
        const meeting = getMeeting(deps.db, req.body.meetingId);
        if (!meeting) throw new HttpError(400, 'invalid_meeting', 'Meeting does not exist');
        if (personId !== null && personId !== meeting.personId) {
          throw new HttpError(400, 'invalid_meeting', 'Meeting belongs to a different person');
        }
        personId = meeting.personId;
      }
      return reply.code(201).send(createAction(deps.db, { ...req.body, personId, text: req.body.text.trim() }, deps.now()));
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateActionRequest }>(
    '/actions/:id',
    {
      schema: {
        params: idParams,
        querystring: noQuery,
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: { text, owner, status: { type: 'string', enum: ['open', 'done'] }, personId: nullableId, projectId: nullableId },
        },
      },
    },
    async (req) => {
      if (req.body.text !== undefined && req.body.text.trim() === '') {
        throw new HttpError(400, 'validation_error', 'text must not be blank');
      }
      checkPerson(req.body.personId);
      const cur = getAction(deps.db, Number(req.params.id));
      if (!cur) throw notFound();
      if (req.body.projectId !== cur.projectId) checkProject(req.body.projectId);
      if (cur.meetingId !== null && req.body.personId !== undefined) {
        const meeting = getMeeting(deps.db, cur.meetingId);
        if (meeting && req.body.personId !== meeting.personId) {
          throw new HttpError(400, 'invalid_person', 'Action is linked to a meeting of a different person');
        }
      }
      const patch = req.body.text !== undefined ? { ...req.body, text: req.body.text.trim() } : req.body;
      const a = updateAction(deps.db, Number(req.params.id), patch, deps.now());
      if (!a) throw notFound();
      return a;
    },
  );

  app.delete<{ Params: { id: string } }>('/actions/:id', { schema: { params: idParams, querystring: noQuery } }, async (req, reply) => {
    if (!softDeleteAction(deps.db, Number(req.params.id), deps.now())) throw notFound();
    return reply.code(204).send();
  });
}

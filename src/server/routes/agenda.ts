import type { FastifyInstance } from 'fastify';
import { LIMITS } from '../../shared/api.ts';
import type { CreateAgendaItemRequest, UpdateAgendaItemRequest } from '../../shared/api.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import { createAgendaItem, getAgendaItem, softDeleteAgendaItem, updateAgendaItem } from '../repos/agenda.ts';
import { getMeeting } from '../repos/meetings.ts';
import { getPerson } from '../repos/people.ts';

const ID = { type: 'string', pattern: '^[0-9]{1,15}$' } as const;
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID } } as const;
const text = { type: 'string', minLength: 1, maxLength: LIMITS.captureText } as const;

const noQuery = { type: 'object', additionalProperties: false } as const;
const blank = (): HttpError => new HttpError(400, 'validation_error', 'text must not be blank');

export default async function routes(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;

  app.post<{ Params: { id: string }; Body: CreateAgendaItemRequest }>(
    '/people/:id/agenda',
    {
      schema: {
        params: idParams,
        querystring: noQuery,
        body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text } },
      },
    },
    async (req, reply) => {
      const personId = Number(req.params.id);
      if (!getPerson(deps.db, personId)) throw new HttpError(404, 'not_found', 'Person not found');
      if (req.body.text.trim() === '') throw blank();
      return reply.code(201).send(createAgendaItem(deps.db, { personId, text: req.body.text.trim() }, deps.now()));
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateAgendaItemRequest }>(
    '/agenda/:id',
    {
      schema: {
        params: idParams,
        querystring: noQuery,
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            text,
            status: { type: 'string', enum: ['open', 'done', 'dropped'] },
            meetingId: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req) => {
      if (req.body.text !== undefined && req.body.text.trim() === '') throw blank();
      const cur = getAgendaItem(deps.db, Number(req.params.id));
      if (!cur) throw new HttpError(404, 'not_found', 'Agenda item not found');
      if (req.body.meetingId !== undefined) {
        // An item can only be resolved in a meeting with its own person.
        const meeting = getMeeting(deps.db, req.body.meetingId);
        if (!meeting || meeting.personId !== cur.personId) {
          throw new HttpError(400, 'invalid_meeting', 'Meeting does not exist for this item');
        }
      }
      const patch = req.body.text !== undefined ? { ...req.body, text: req.body.text.trim() } : req.body;
      const item = updateAgendaItem(deps.db, Number(req.params.id), patch, deps.now());
      if (!item) throw new HttpError(404, 'not_found', 'Agenda item not found');
      return item;
    },
  );

  app.delete<{ Params: { id: string } }>('/agenda/:id', { schema: { params: idParams, querystring: noQuery } }, async (req, reply) => {
    if (!softDeleteAgendaItem(deps.db, Number(req.params.id), deps.now())) {
      throw new HttpError(404, 'not_found', 'Agenda item not found');
    }
    return reply.code(204).send();
  });
}

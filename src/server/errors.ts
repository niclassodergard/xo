import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorBody } from '../shared/api.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

/** Send the standard error shape. */
export function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send(errorBody(code, message));
}

const CODES: Record<number, string> = {
  400: 'bad_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found',
  409: 'conflict', 413: 'payload_too_large', 415: 'unsupported_media_type', 429: 'rate_limited',
};

/** Shared error handler: never leaks internal error messages for 5xx. */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return sendError(reply, err.status, err.code, err.message);
    }
    const e = err as FastifyError;
    const status = e.statusCode;
    // Relay the message only for errors we know are client-safe: Fastify validation errors and
    // Fastify's own FST_ERR_* client errors (none of them echo request content). Everything else is a
    // generic 500 so internal details never leak.
    const clientSafe = typeof e.code === 'string' && e.code.startsWith('FST_ERR_');
    if (typeof status === 'number' && status >= 400 && status < 500 && (e.validation || clientSafe)) {
      return sendError(reply, status, e.validation ? 'validation_error' : (CODES[status] ?? 'bad_request'), e.message);
    }
    req.log.error({ err: { type: err.name, code: (err as FastifyError).code } }, 'unhandled error');
    return sendError(reply, 500, 'internal_error', 'Internal server error');
  });
}

/** Default 404 in the standard error shape. */
export function notFoundHandler(_req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, 'not_found', 'Not found');
}

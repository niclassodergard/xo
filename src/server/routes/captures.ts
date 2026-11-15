import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps.ts';

// STUB: the owning step replaces this body. Routes are registered under prefix '/api',
// so declare paths relative to it (e.g. '/people/:id').
export default async function routes(_app: FastifyInstance, _opts: { deps: AppDeps }): Promise<void> {}

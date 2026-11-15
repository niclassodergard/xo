import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';

// STUB: step 11 replaces this. `args` are the CLI arguments after `export` (e.g. ['--out', 'dir']).
export async function run(_args: string[], _ctx: { config: Config; db: DatabaseSync }): Promise<void> {
  throw new Error('not implemented');
}

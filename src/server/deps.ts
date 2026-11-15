import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import type { Classifier, Transcriber } from './llm/types.ts';

export interface AppDeps {
  config: Config;
  db: DatabaseSync;
  classifier: Classifier | null;
  transcriber: Transcriber | null;
  now: () => Date;
}

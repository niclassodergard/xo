import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import type { Answerer, Classifier, Transcriber } from './llm/types.ts';

export interface AppDeps {
  config: Config;
  db: DatabaseSync;
  classifier: Classifier | null;
  transcriber: Transcriber | null;
  answerer: Answerer | null;
  now: () => Date;
}

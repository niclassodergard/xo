import type { AppDeps } from '../deps.ts';
import { FakeAnswerer, FakeClassifier, FakeTranscriber } from './fake.ts';
import { createOpenRouterAnswerer } from './answerer.ts';
import { createOpenRouterClassifier } from './classifier.ts';
import { createOpenRouter } from './openrouter.ts';
import { createOpenRouterTranscriber } from './transcriber.ts';

/** Chooses the classifier/transcriber/answerer. The key goes only to the OpenRouter client. `fetchImpl` is for tests. */
export function pickLlm(
  config: AppDeps['config'],
  apiKey: string | null,
  fetchImpl?: typeof fetch,
): Pick<AppDeps, 'classifier' | 'transcriber' | 'answerer'> {
  if (config.llm === 'fake') return { classifier: new FakeClassifier(), transcriber: new FakeTranscriber(), answerer: new FakeAnswerer() };
  if (!apiKey) return { classifier: null, transcriber: null, answerer: null };
  const client = createOpenRouter({ apiKey, zdr: config.openRouterZdr, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return {
    classifier: createOpenRouterClassifier(client, config.llmModel),
    transcriber: createOpenRouterTranscriber(client, config.sttModel),
    answerer: createOpenRouterAnswerer(client, config.qaModel),
  };
}

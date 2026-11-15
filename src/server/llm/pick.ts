import type { AppDeps } from '../deps.ts';
import { FakeClassifier, FakeTranscriber } from './fake.ts';
import { createOpenRouterClassifier } from './classifier.ts';
import { createOpenRouter } from './openrouter.ts';
import { createOpenRouterTranscriber } from './transcriber.ts';

/** Chooses the classifier/transcriber. The key goes only to the OpenRouter client. `fetchImpl` is for tests. */
export function pickLlm(
  config: AppDeps['config'],
  apiKey: string | null,
  fetchImpl?: typeof fetch,
): Pick<AppDeps, 'classifier' | 'transcriber'> {
  if (config.llm === 'fake') return { classifier: new FakeClassifier(), transcriber: new FakeTranscriber() };
  if (!apiKey) return { classifier: null, transcriber: null };
  const client = createOpenRouter({ apiKey, zdr: config.openRouterZdr, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return {
    classifier: createOpenRouterClassifier(client, config.llmModel),
    transcriber: createOpenRouterTranscriber(client, config.sttModel),
  };
}

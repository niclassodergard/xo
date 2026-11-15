import { describe, expect, it } from 'vitest';
import { makeTestConfig } from '../../../test/helpers.ts';
import { FakeClassifier } from './fake.ts';
import { pickLlm } from './pick.ts';

function spyFetch() {
  const bodies: Record<string, any>[] = [];
  const f = (async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, any>);
    return new Response(JSON.stringify({ text: 'hi' }), { status: 200 });
  }) as typeof fetch;
  return { f, bodies };
}
const cfg = (env: NodeJS.ProcessEnv) => makeTestConfig({ XO_LLM: 'openrouter', ...env });

describe('pickLlm wiring', () => {
  for (const [value, expected] of [['true', true], ['false', false], [undefined, false]] as const) {
    it(`XO_OPENROUTER_ZDR=${value}: chat and transcription bodies ${expected ? 'carry' : 'omit'} provider.zdr`, async () => {
      const { f, bodies } = spyFetch();
      const env = value === undefined ? {} : { XO_OPENROUTER_ZDR: value };
      const { transcriber } = pickLlm(cfg(env), 'k', f);
      await transcriber!.transcribe(Buffer.from('a'), 'wav');
      const { classifier } = pickLlm(cfg(env), 'k', f);
      await classifier!.classify({ text: 't', people: [], now: 'n' }).catch(() => undefined); // reply is not a chat reply
      expect(bodies).toHaveLength(2);
      for (const b of bodies) {
        if (expected) expect(b['provider']['zdr']).toBe(true);
        else expect(b['provider']).not.toHaveProperty('zdr');
      }
    });
  }

  it('no key: nothing; fake: fakes', () => {
    expect(pickLlm(cfg({}), null)).toEqual({ classifier: null, transcriber: null });
    expect(pickLlm(makeTestConfig({ XO_LLM: 'fake' }), null).classifier).toBeInstanceOf(FakeClassifier);
  });
});

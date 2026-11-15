import type { AudioFormat, Classifier, ClassifyInput, ClassifyOutput, Transcriber } from './types.ts';
import { LlmError } from './types.ts';

/** Deterministic classifier for tests, e2e and `XO_LLM=fake`. */
export class FakeClassifier implements Classifier {
  async classify(input: ClassifyInput): Promise<ClassifyOutput> {
    const text = input.text;
    if (text.includes('!!fail')) throw new LlmError('fake classifier failure');
    // Only an uppercase-initial word after "with " counts as a name (no `i` flag on purpose).
    const m = /\bwith\s+(\p{Lu}[\p{L}'-]*)/u.exec(text);
    const personName = m?.[1] ?? null;
    let kind: ClassifyOutput['kind'] = 'note';
    let confidence = 0.95;
    if (text.includes('??')) confidence = 0.1;
    else if (text.startsWith('todo:')) kind = 'action';
    else if (text.startsWith('agenda:')) kind = 'agenda';
    return { kind, confidence, personName, owner: 'me' };
  }
}

export class FakeTranscriber implements Transcriber {
  private readonly text: string;
  constructor(text = 'open Anna') {
    this.text = text;
  }
  async transcribe(_audio: Buffer, _format: AudioFormat): Promise<{ text: string }> {
    return { text: this.text };
  }
}

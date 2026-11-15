import type { Answerer, AnswerInput, AnswerOutput, AudioFormat, Classifier, ClassifyInput, ClassifyOutput, Transcriber } from './types.ts';
import { LlmError } from './types.ts';

/** Deterministic classifier for tests, e2e and `XO_LLM=fake`. */
export class FakeClassifier implements Classifier {
  async classify(input: ClassifyInput): Promise<ClassifyOutput> {
    const text = input.text;
    if (text.includes('!!fail')) throw new LlmError('fake classifier failure');
    // Only an uppercase-initial word after "with " counts as a name (no `i` flag on purpose).
    const m = /\bwith\s+(\p{Lu}[\p{L}'-]*)/u.exec(text);
    const personName = m?.[1] ?? null;
    // "project Apollo": the capitalised word after "project " (the service vets it against known projects).
    const pm = /\bproject\s+(\p{Lu}[\p{L}\p{N}'-]*)/u.exec(text);
    const projectName = pm?.[1] ?? null;
    let kind: ClassifyOutput['kind'] = 'note';
    let confidence = 0.95;
    if (text.includes('??')) confidence = 0.1;
    else if (text.startsWith('todo:')) kind = 'action';
    else if (text.startsWith('agenda:')) kind = 'agenda';
    // A single trailing '?' is a question (the '??' rule above wins and stays unsure).
    else if (text.trimEnd().endsWith('?')) kind = 'question';
    return { kind, confidence, personName, projectName, owner: 'me' };
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

/** Deterministic answerer for tests, e2e and `XO_LLM=fake`: lists the excerpt titles and cites the first two. */
export class FakeAnswerer implements Answerer {
  async answer(input: AnswerInput): Promise<AnswerOutput> {
    if (input.question.includes('!!fail')) throw new LlmError('fake answerer failure');
    const n = input.excerpts.length;
    return {
      answer: `Found ${n} item(s): ${input.excerpts.map((e) => e.title).join(', ')}`,
      cited: input.excerpts.slice(0, 2).map((e) => e.ref),
    };
  }
}

import type { Capture, Id } from '../../shared/types.ts';
import { presentRecords } from '../capture/service.ts';
import type { AppDeps } from '../deps.ts';
import { sanitizeAnswer } from '../llm/answerer.ts';
import type { StoredRef, StoredSources } from '../repos/captures.ts';
import { getCaptureRecord, updateCapture } from '../repos/captures.ts';
import { retrieve } from './retrieve.ts';

/** `busy`: this capture is already being answered by another request. */
export type AskResult = Capture | 'not_found' | 'not_asked' | 'no_llm' | 'failed' | 'busy';

export interface QaService {
  /** Answers an `asked` capture. `signal` aborts the LLM call (client went away). */
  ask(id: Id, signal?: AbortSignal): Promise<AskResult>;
}

export interface QaServiceOptions {
  /** Hard deadline for the whole LLM call (default 45 s), enforced even if the answerer ignores the abort signal. */
  timeoutMs?: number;
  /** Diagnostics: fixed messages and error class names only, never a question, excerpt or answer. */
  warn?: (message: string) => void;
}

/** What the user sees when retrieval finds nothing; no LLM call is made. */
export const NO_MATCH_ANSWER = 'Nothing in your data matches that.';
/** Cap on the question text that is searched and sent. */
const MAX_QUESTION_CHARS = 1000;

const WARN_NAMES = new Set(['LlmError', 'AbortError', 'TimeoutError']);
function errorClass(e: unknown): string {
  return e instanceof Error && WARN_NAMES.has(e.name) ? e.name : 'Error';
}

function parseRef(ref: string): StoredRef | null {
  const m = /^(note|action|agenda|person|project|meeting):([0-9]{1,15})$/.exec(ref);
  return m ? { kind: m[1] as StoredRef['kind'], id: Number(m[2]) } : null;
}

export function createQaService(deps: AppDeps, options: QaServiceOptions = {}): QaService {
  const { db } = deps;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const warn = options.warn ?? ((): void => {});
  /** Captures with an answer in progress: a second ask for one of them must not reach the LLM (and cost) again. */
  const inFlight = new Set<Id>();

  return {
    async ask(id, signal) {
      const rec = getCaptureRecord(db, id);
      if (!rec) return 'not_found';
      if (rec.status !== 'asked') return 'not_asked';
      const answerer = deps.answerer;
      if (!answerer) return 'no_llm';
      if (inFlight.has(id)) return 'busy';
      inFlight.add(id);
      try {
        return await answerOne(id, rec.draft.text, signal, answerer);
      } finally {
        inFlight.delete(id);
      }
    },
  };

  async function answerOne(id: Id, text: string, signal: AbortSignal | undefined, answerer: NonNullable<AppDeps['answerer']>): Promise<AskResult> {
    {
      const question = Array.from(text).slice(0, MAX_QUESTION_CHARS).join('');
      const excerpts = retrieve(db, question);

      const store = (answer: string, sources: StoredSources): AskResult => {
        // The capture may have been undone or reclassified while the LLM was working: then nothing is stored.
        const cur = getCaptureRecord(db, id);
        if (!cur || cur.status !== 'asked') return 'not_asked';
        const next = updateCapture(db, id, { status: 'answered', question: null, summary: '', answer, sources }, deps.now())!;
        return presentRecords(db, [next])[0]!;
      };

      // Nothing relevant locally: nothing leaves the machine.
      if (excerpts.length === 0) return store(NO_MATCH_ANSWER, { sent: [], cited: [] });

      const input = {
        question,
        now: deps.now().toISOString(),
        excerpts: excerpts.map((e) => ({ ref: `${e.kind}:${e.id}`, title: e.title, text: e.text })),
      };
      const sentRefs = new Set(input.excerpts.map((e) => e.ref));
      const ac = new AbortController();
      const onAbort = (): void => ac.abort();
      if (signal?.aborted) ac.abort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const deadline = new Promise<never>((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(new Error('answer deadline')), { once: true });
        });
        deadline.catch(() => undefined); // no unhandled rejection when the answer wins the race
        const raw = await Promise.race([answerer.answer(input, ac.signal), deadline]);
        // Re-validated here as well: the answerer is an interface, and its output is untrusted.
        const out = sanitizeAnswer(
          { answer: (raw as { answer?: unknown } | null)?.answer, cited: (raw as { cited?: unknown } | null)?.cited },
          sentRefs,
        );
        const sources: StoredSources = {
          sent: excerpts.map((e) => ({ kind: e.kind, id: e.id })),
          cited: out.cited.map(parseRef).filter((r): r is StoredRef => r !== null),
        };
        return store(out.answer, sources);
      } catch (e) {
        warn(`question answering failed: ${errorClass(e)}`);
        return 'failed';
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }
}

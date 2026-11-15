import { resolveMention } from './people-match.ts';
import type { PersonLike } from './people-match.ts';
import type { VoiceCommand } from './types.ts';

type View = 'chat' | 'actions' | 'notes' | 'people';

const MAX_PERSON_PHRASE = 80;
const MAX_TRANSCRIPT = 300; // commands are short; longer input is dictation

// Spoken forms of "1-1" as transcribers tend to produce them.
const ONE_ON_ONE =
  '(?:1\\s*[-:]\\s*1|1\\s*-?\\s*on\\s*-?\\s*1|one\\s*-?\\s*on\\s*-?\\s*one|(?:one|1)\\s*-?\\s*to\\s*-?\\s*(?:one|1)|one\\s*[-:]\\s*one|meeting)';

const GOTO_RE = /^(?:go\s+to|open|show)\s+(?:the\s+)?(chat|actions|notes|people)(?:\s+(?:view|page|list|screen))?$/iu;
const START_RE = new RegExp(
  `^start\\s+(?:(?:a|an|my|the)\\s+)?${ONE_ON_ONE}(?:\\s+meeting)?\\s+with\\s+(.+)$`,
  'iu',
);
const OPEN_RE = /^(?:open|show)\s+(.+)$/iu;

/** Strip surrounding punctuation and polite filler so "Please open Anna." matches "open anna". */
function clean(transcript: string): string {
  let s = transcript.normalize('NFC').trim();
  s = s.replace(/^[\s"\u201c\u201d\u201e'\u2018\u2019]+/u, '');
  s = s.replace(/[\s.!?,;:"\u201c\u201d\u201e'\u2018\u2019]+$/u, '');
  s = s.replace(/^(?:(?:could|can|would)\s+you\s+)?(?:please\s+)?/iu, '');
  s = s.replace(/[\s,]+please$/iu, '');
  return s.replace(/\s+/g, ' ').trim();
}

function singlePerson(phrase: string, people: PersonLike[]): PersonLike | null {
  const p = phrase.trim();
  if (p === '' || p.length > MAX_PERSON_PHRASE) return null;
  const hits = resolveMention(p, people);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * Recognise a small English command grammar. Returns null for anything else
 * (unknown or ambiguous person included), so the transcript becomes dictation.
 * Swedish variants are a later addition.
 */
export function parseVoiceCommand(transcript: string, people: PersonLike[]): VoiceCommand | null {
  if (transcript.length > MAX_TRANSCRIPT) return null;
  const s = clean(transcript);
  if (s === '') return null;

  const goto = GOTO_RE.exec(s);
  if (goto) return { type: 'goto', view: (goto[1] ?? '').toLowerCase() as View };

  const start = START_RE.exec(s);
  if (start) {
    const p = singlePerson(start[1] ?? '', people);
    return p ? { type: 'start_meeting', personId: p.id } : null;
  }

  const open = OPEN_RE.exec(s);
  if (open) {
    const p = singlePerson(open[1] ?? '', people);
    return p ? { type: 'open_person', personId: p.id } : null;
  }
  return null;
}

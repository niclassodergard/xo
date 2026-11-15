import type { ItemKind, Owner } from './types.ts';

export interface ParsedCapture { forcedKind: ItemKind | null; forcedOwner: Owner | null; mentions: string[]; text: string }

const PREFIXES: Record<string, { kind: ItemKind; owner: Owner | null }> = {
  note: { kind: 'note', owner: null },
  n: { kind: 'note', owner: null },
  todo: { kind: 'action', owner: 'me' },
  t: { kind: 'action', owner: 'me' },
  action: { kind: 'action', owner: 'me' },
  wait: { kind: 'action', owner: 'them' },
  w: { kind: 'action', owner: 'them' },
  agenda: { kind: 'agenda', owner: null },
  a: { kind: 'agenda', owner: null },
};

// A command is only recognised at the very start, as a whole word.
const PREFIX_RE = /^\/(\p{L}+)(?=\s|$)/u;

// `@name` or `@"Full Name"` (also curly and Swedish quotes); the `@` must not be glued to a
// preceding letter/digit (e-mail addresses). All repetitions are bounded to keep matching linear.
const MENTION_RE = /(^|[^\p{L}\p{N}])@(?:["\u201c\u201d\u201e]([^"\u201c\u201d\u201e\n]{0,200})["\u201c\u201d]|([\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]{0,199}(?:['\u2019][\p{L}\p{N}\p{M}_-]{1,100}){0,5}))/gu;

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/** Parse the prefix command and `@mentions` of a raw chat capture. Pure; never throws. */
export function parseCapture(raw: string): ParsedCapture {
  let text = raw.normalize('NFC').trim();
  let forcedKind: ItemKind | null = null;
  let forcedOwner: Owner | null = null;

  const m = PREFIX_RE.exec(text);
  if (m) {
    const def = PREFIXES[(m[1] ?? '').toLowerCase()];
    if (def) {
      forcedKind = def.kind;
      forcedOwner = def.owner;
      text = text.slice(m[0].length).trim();
    }
  }

  const mentions: string[] = [];
  text = text.replace(MENTION_RE, (whole, lead: string, quoted?: string, bare?: string) => {
    let name: string;
    let tail = '';
    if (bare !== undefined) {
      let end = bare.length;
      while (end > 0 && (bare[end - 1] === '-' || bare[end - 1] === '_')) end--;
      name = bare.slice(0, end);
      tail = bare.slice(end);
      // Possessive: "@Anna's" mentions Anna, the 's stays in the text.
      const poss = /['’]s$/i.exec(name);
      if (poss && poss.index > 0) {
        tail = name.slice(poss.index) + tail;
        name = name.slice(0, poss.index);
      }
    } else {
      name = cleanName(quoted ?? '');
    }
    if (name === '') return whole;
    mentions.push(name);
    return lead + name + tail;
  });

  return { forcedKind, forcedOwner, mentions, text: text.trim() };
}

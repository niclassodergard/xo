import type { Person } from './types.ts';

export type PersonLike = Pick<Person, 'id' | 'name' | 'aliases'>;

/** Case-insensitive, Unicode-normalised, single-spaced form used for all comparisons. */
function norm(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function firstWord(normalizedName: string): string {
  const i = normalizedName.indexOf(' ');
  return i === -1 ? normalizedName : normalizedName.slice(0, i);
}

const WORD = '[\\p{L}\\p{N}\\p{M}_]';
// A hyphen next to a letter is part of the word ("Anna-Karin"); an apostrophe is a boundary.
const WORD_BEFORE = new RegExp(`${WORD}-?$`, 'u');
const WORD_AFTER = new RegExp(`^-?${WORD}`, 'u');
const UPPER_START = /^\p{Lu}/u;

interface Span { start: number; end: number; genitive: boolean }

/**
 * Whole-word occurrences of `needle` using Unicode letter boundaries (no `\b`, which is ASCII-only).
 * With `original` (same text, case kept) a match must start with an uppercase letter.
 * With `genitive`, a single trailing "s" is also accepted ("Annas budget").
 */
function findSpans(haystack: string, needle: string, original?: string, genitive = false): Span[] {
  const spans: Span[] = [];
  if (needle === '') return spans;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return spans;
    from = i + 1;
    if (original !== undefined && !UPPER_START.test(original.slice(i, i + 2))) continue;
    if (WORD_BEFORE.test(haystack.slice(Math.max(0, i - 3), i))) continue;
    const e = i + needle.length;
    const after = haystack.slice(e, e + 4);
    if (!WORD_AFTER.test(after)) {
      spans.push({ start: i, end: e, genitive: false });
    } else if (genitive && after[0] === 's' && !WORD_AFTER.test(after.slice(1))) {
      spans.push({ start: i, end: e + 1, genitive: true });
    }
  }
}

function fullNames(p: PersonLike): string[] {
  return [p.name, ...p.aliases].map(norm).filter((s) => s !== '');
}

function resolveNorm(m: string, people: PersonLike[], allowGenitive: boolean): PersonLike[] {
  // Tier 1: full name or alias. Tier 2: first word of the name. Tier 3: Swedish genitive ("Annas").
  const exact = people.filter((p) => fullNames(p).includes(m));
  if (exact.length > 0) return exact;
  const first = people.filter((p) => {
    const name = norm(p.name);
    return name !== '' && firstWord(name) === m;
  });
  if (first.length > 0) return first;
  if (allowGenitive && m.length > 1 && m.endsWith('s')) return resolveNorm(m.slice(0, -1), people, false);
  return [];
}

/**
 * Candidates for an explicit @mention. An exact full name or alias beats a first-word match
 * ("Bo" with people "Bo" and "Bo Nilsson" gives only "Bo"); "Annas" resolves to Anna unless
 * someone is literally named "Annas".
 */
export function resolveMention(mention: string, people: PersonLike[]): PersonLike[] {
  const m = norm(mention);
  if (m === '') return [];
  return resolveNorm(m, people, true);
}

/** Lowercase without ever changing the string length, so indices line up with the original. */
function lowerSameLength(s: string): string {
  return Array.from(s, (c) => {
    const l = c.toLowerCase();
    return l.length === c.length ? l : c;
  }).join('');
}

/**
 * Distinct known people named in free text (full names, aliases, and unique first names).
 * Matching is case-insensitive except that the match must START with an uppercase letter as
 * typed: "Will" matches, "will" does not (so ordinary lowercase words are never names), "ANNA" does.
 * The longest span wins ("Anna Berg" beats a person called "Anna"), a Swedish genitive "Annas"
 * links Anna, and a hyphen joins words ("Anna-Karin" is not "Anna").
 * Known limits: a name at the start of a sentence matches even when it is an ordinary word
 * ("Per capita", "Will you"); an alias that starts in lowercase ("von Trier") never matches free
 * text and is only reachable through @mention or voice (resolveMention).
 */
export function findPeopleInText(text: string, people: PersonLike[]): PersonLike[] {
  const original = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  const hay = lowerSameLength(original);
  if (hay === '') return [];

  const firstCounts = new Map<string, number>();
  for (const p of people) {
    const fw = firstWord(norm(p.name));
    if (fw !== '') firstCounts.set(fw, (firstCounts.get(fw) ?? 0) + 1);
  }

  const matches: { person: PersonLike; span: Span }[] = [];
  for (const p of people) {
    const needles = new Set(fullNames(p));
    const fw = firstWord(norm(p.name));
    if (fw !== '' && firstCounts.get(fw) === 1) needles.add(fw);
    for (const n of needles) {
      for (const span of findSpans(hay, n, original, true)) matches.push({ person: p, span });
    }
  }

  const found: PersonLike[] = [];
  const seen = new Set<number>();
  for (const p of people) {
    if (seen.has(p.id)) continue;
    const mine = matches.filter((m) => m.person.id === p.id);
    const survives = mine.some((m) => !matches.some((o) => o.person.id !== p.id && outranks(o.span, m.span)));
    if (survives) {
      seen.add(p.id);
      found.push(p);
    }
  }
  return found;
}

/** True when `a` covers `b` and is longer, or equally long but `b` is only a genitive guess. */
function outranks(a: Span, b: Span): boolean {
  if (a.start > b.start || a.end < b.end) return false;
  const la = a.end - a.start;
  const lb = b.end - b.start;
  return la > lb || (la === lb && b.genitive && !a.genitive);
}

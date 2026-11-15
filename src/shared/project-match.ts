import type { Project } from './types.ts';

export type ProjectLike = Pick<Project, 'id' | 'title' | 'aliases'>;

/** Minimum length (code points) of a single-word title or alias that may be suggested from free text. */
const MIN_WEAK_CHARS = 3;

/**
 * The one comparison form: NFC, lower case, and a hyphen, underscore or run of whitespace are all one
 * single space ("#board-deck" equals "Board deck").
 */
function norm(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

const WORD = '[\\p{L}\\p{N}\\p{M}]';
const WORD_BEFORE = new RegExp(`${WORD}$`, 'u');
const WORD_AFTER = new RegExp(`^${WORD}`, 'u');

function names(p: ProjectLike): string[] {
  return [p.title, ...p.aliases].map(norm).filter((s) => s !== '');
}

/**
 * Candidates for an explicit `#mention`. An exact title or alias match wins outright; otherwise the
 * projects whose title starts with the mention as whole words ("#board" for "Board deck").
 * Several results mean "ambiguous". Unicode-aware, never throws.
 */
export function resolveProjectMention(mention: string, projects: ProjectLike[]): ProjectLike[] {
  const m = norm(mention);
  if (m === '') return [];
  const exact = projects.filter((p) => names(p).includes(m));
  if (exact.length > 0) return exact;
  return projects.filter((p) => {
    const t = norm(p.title);
    return t.startsWith(`${m} `);
  });
}

interface Span { start: number; end: number }

/** Whole-word occurrences of `needle` in `hay` (both normalised) using Unicode letter boundaries. */
function findSpans(hay: string, needle: string): Span[] {
  const spans: Span[] = [];
  for (let from = 0; ; ) {
    const i = hay.indexOf(needle, from);
    if (i === -1) return spans;
    from = i + 1;
    const e = i + needle.length;
    if (WORD_BEFORE.test(hay.slice(Math.max(0, i - 3), i))) continue;
    if (WORD_AFTER.test(hay.slice(e, e + 3))) continue;
    spans.push({ start: i, end: e });
  }
}

/**
 * Projects named in free text by a whole-phrase match of a title or alias. `strong`: the matched
 * title/alias has two or more words. `weak`: it is a single word of at least three characters; a weak
 * match inside a strong match of another project is dropped, and a project is never in both lists.
 * Callers pass only live, not-done projects.
 */
export function findProjectsInText(text: string, projects: ProjectLike[]): { strong: ProjectLike[]; weak: ProjectLike[] } {
  const hay = norm(text);
  const strong: { p: ProjectLike; spans: Span[] }[] = [];
  const weak: { p: ProjectLike; spans: Span[] }[] = [];
  if (hay === '') return { strong: [], weak: [] };
  for (const p of projects) {
    const s: Span[] = [];
    const w: Span[] = [];
    for (const n of new Set(names(p))) {
      const multi = n.includes(' ');
      if (!multi && Array.from(n).length < MIN_WEAK_CHARS) continue;
      (multi ? s : w).push(...findSpans(hay, n));
    }
    if (s.length > 0) strong.push({ p, spans: s });
    else if (w.length > 0) weak.push({ p, spans: w });
  }
  const strongSpans = strong.flatMap((x) => x.spans);
  const weakKept = weak.filter((x) => !x.spans.every((a) => strongSpans.some((b) => b.start <= a.start && a.end <= b.end)));
  return { strong: strong.map((x) => x.p), weak: weakKept.map((x) => x.p) };
}

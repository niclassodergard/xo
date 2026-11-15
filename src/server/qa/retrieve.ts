import type { DatabaseSync } from 'node:sqlite';
import { findPeopleInText } from '../../shared/people-match.ts';
import { findProjectsInText } from '../../shared/project-match.ts';
import type { Id, SourceRef } from '../../shared/types.ts';
import { listPeopleForMatching } from '../repos/people.ts';
import { listProjectsForMatching } from '../repos/projects.ts';
import { fold } from '../repos/search.ts';

export interface Excerpt { kind: SourceRef['kind']; id: Id; title: string; text: string }
export interface RetrieveCaps { maxExcerpts?: number; maxExcerptChars?: number; maxTotalChars?: number }

export const DEFAULT_CAPS = { maxExcerpts: 24, maxExcerptChars: 600, maxTotalChars: 12_000 } as const;
const MAX_TOKENS = 8;
const MIN_TOKEN_CHARS = 3;
const MAX_TITLE_CHARS = 100;
const EXTRA = { notes: 5, agenda: 10, actions: 10 } as const;
const MAX_NAMED = 3;
/** Long bodies are only read up to here (a match further in still counts, but is cut from the start). */
const BODY_READ_CHARS = 20_000;
const NAMED_BONUS = 3;

// Common English and Swedish function words. Short on purpose: it only has to keep the most frequent words
// from matching half the database (tokens under three characters are dropped anyway).
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'did', 'does', 'doing', 'done', 'have', 'has', 'had', 'having', 'can', 'could', 'should', 'would', 'will', 'shall',
  'may', 'might', 'must', 'not', 'but', 'with', 'without', 'about', 'from', 'into', 'onto', 'over', 'under', 'than',
  'then', 'that', 'this', 'these', 'those', 'there', 'here', 'their', 'them', 'they', 'you', 'your', 'yours', 'our',
  'ours', 'his', 'her', 'hers', 'its', 'any', 'all', 'some', 'more', 'most', 'much', 'many', 'tell', 'show', 'give',
  'list', 'find', 'say', 'said', 'ask', 'asked', 'promise', 'promised',
  'och', 'att', 'det', 'den', 'det', 'detta', 'denna', 'dessa', 'som', 'för', 'med', 'utan', 'från', 'till', 'över',
  'under', 'har', 'hade', 'ska', 'skulle', 'kan', 'kunde', 'måste', 'vill', 'inte', 'men', 'eller', 'om', 'när', 'var',
  'vad', 'vem', 'vilka', 'vilken', 'vilket', 'hur', 'varför', 'jag', 'mig', 'min', 'mitt', 'mina', 'vi', 'oss', 'du',
  'dig', 'din', 'ditt', 'dina', 'han', 'hon', 'hans', 'hennes', 'dem', 'deras', 'sig', 'sin', 'sitt', 'sina', 'alla',
  'någon', 'något', 'några', 'mer', 'mycket', 'visa', 'berätta', 'finns', 'vara', 'blev', 'blir', 'lovade', 'lovat',
]);

/** Folded, de-duplicated search words of a question: length >= 3, no stop words, at most 8. Pure. */
export function questionTokens(question: string): string[] {
  const out: string[] = [];
  for (const w of fold(question).split(/[^\p{L}\p{N}]+/u)) {
    if (Array.from(w).length < MIN_TOKEN_CHARS || STOP_WORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

const registered = new WeakSet<DatabaseSync>();
/** Same Unicode-aware fold as search.ts (SQLite's own LIKE only folds ASCII); registering it twice is harmless. */
function ensureFold(db: DatabaseSync): void {
  if (registered.has(db)) return;
  db.function('xo_fold', { deterministic: true }, (v) => (typeof v === 'string' ? fold(v) : v));
  registered.add(db);
}

const likePattern = (t: string): string => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number): string => {
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join('') : s;
};

interface Row { id: number; title: string; body: string; extra: string | null; at: string }
interface Kind {
  kind: SourceRef['kind'];
  /** SELECT ... WHERE <always-true live filter>; columns id, title, body, extra, at. Constants only. */
  select: string;
  likeCols: string[];
  order: string;
  header: (r: Row) => string;
}

const parseAliases = (json: string | null): string[] => {
  try {
    const v: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
  } catch { return []; }
};
const withPerson = (base: string, r: Row): string => (r.extra ? `${base}, person ${r.extra}` : base);

// Every statement below is a constant; user text only ever travels as a bound parameter.
const KINDS: Kind[] = [
  {
    kind: 'note', likeCols: ['n.title', 'n.body_md'], order: 'n.updated_at DESC, n.id DESC',
    select: `SELECT n.id AS id, n.title AS title, substr(n.body_md, 1, ${BODY_READ_CHARS}) AS body, p.name AS extra, n.updated_at AS at
             FROM notes n LEFT JOIN people p ON p.id = n.person_id WHERE n.deleted_at IS NULL`,
    header: (r) => withPerson('note', r),
  },
  {
    kind: 'action', likeCols: ['a.text'], order: 'a.created_at DESC, a.id DESC',
    select: `SELECT a.id AS id, 'Action' AS title, substr(a.text, 1, ${BODY_READ_CHARS}) AS body,
               a.status || ', owner ' || a.owner || COALESCE(', person ' || p.name, '') AS extra, a.created_at AS at
             FROM actions a LEFT JOIN people p ON p.id = a.person_id WHERE a.deleted_at IS NULL`,
    header: (r) => `action ${r.extra ?? ''}`,
  },
  {
    kind: 'agenda', likeCols: ['g.text'], order: 'g.created_at DESC, g.id DESC',
    select: `SELECT g.id AS id, 'Agenda item' AS title, substr(g.text, 1, ${BODY_READ_CHARS}) AS body,
               g.status || ', person ' || p.name AS extra, g.created_at AS at
             FROM agenda_items g JOIN people p ON p.id = g.person_id WHERE g.deleted_at IS NULL`,
    header: (r) => `agenda item for the next 1-1 (${r.extra ?? ''})`,
  },
  {
    kind: 'person', likeCols: ['p.name', 'p.aliases', 'p.notes_md'], order: 'p.updated_at DESC, p.id DESC',
    select: `SELECT p.id AS id, p.name AS title, substr(p.notes_md, 1, ${BODY_READ_CHARS}) AS body, p.aliases AS extra, p.updated_at AS at
             FROM people p WHERE 1 = 1`,
    header: (r) => {
      const a = parseAliases(r.extra);
      return a.length > 0 ? `person, also called ${a.join(', ')}` : 'person';
    },
  },
  {
    kind: 'project', likeCols: ['j.title', 'j.aliases', 'j.description_md'], order: 'j.updated_at DESC, j.id DESC',
    select: `SELECT j.id AS id, j.title AS title, substr(j.description_md, 1, ${BODY_READ_CHARS}) AS body,
               j.status || '|' || j.aliases AS extra, j.updated_at AS at
             FROM projects j WHERE j.deleted_at IS NULL`,
    header: (r) => {
      const [status = '', ...rest] = (r.extra ?? '').split('|');
      const a = parseAliases(rest.join('|'));
      return `project (${status})${a.length > 0 ? `, also called ${a.join(', ')}` : ''}`;
    },
  },
  {
    kind: 'meeting', likeCols: ['m.notes_md'], order: 'm.started_at DESC, m.id DESC',
    select: `SELECT m.id AS id, '1-1 ' || p.name || ' ' || substr(m.started_at, 1, 10) AS title,
               substr(m.notes_md, 1, ${BODY_READ_CHARS}) AS body, NULL AS extra, m.started_at AS at
             FROM meetings m JOIN people p ON p.id = m.person_id WHERE m.notes_md != ''`,
    header: () => 'meeting notes',
  },
];
const KIND_BY_NAME = new Map(KINDS.map((k) => [k.kind, k]));

interface Cand {
  kind: Kind; id: number; title: string; header: string; body: string; at: string;
  tokens: Set<string>; bonus: number;
}

/**
 * Local, deterministic retrieval for a question. No LLM, no network. Returns the best-scoring excerpts
 * within hard caps (count, characters per excerpt, characters in total). Soft-deleted rows never appear.
 * Score = distinct question words found, plus a bonus for items belonging to a person or project the
 * question names; ties go to the newer item, then kind, then higher id.
 */
export function retrieve(db: DatabaseSync, question: string, caps: RetrieveCaps = {}): Excerpt[] {
  const maxExcerpts = Math.max(0, caps.maxExcerpts ?? DEFAULT_CAPS.maxExcerpts);
  const maxChars = Math.max(0, caps.maxExcerptChars ?? DEFAULT_CAPS.maxExcerptChars);
  const maxTotal = Math.max(0, caps.maxTotalChars ?? DEFAULT_CAPS.maxTotalChars);
  const tokens = questionTokens(question);
  const people = findPeopleInText(question, listPeopleForMatching(db)).slice(0, MAX_NAMED);
  const projects = findProjectsInText(question, listProjectsForMatching(db));
  const named = [...projects.strong, ...projects.weak].slice(0, MAX_NAMED);
  /** Candidates per kind: enough to fill the excerpt cap from one kind, small enough to bound memory. */
  const perQuery = Math.max(1, maxExcerpts);
  if (tokens.length === 0 && people.length === 0 && named.length === 0) return [];
  ensureFold(db);

  const cands = new Map<string, Cand>();
  const add = (k: Kind, r: Row, token: string | null, bonus: number): void => {
    const key = `${k.kind}:${r.id}`;
    let c = cands.get(key);
    if (!c) {
      c = { kind: k, id: r.id, title: r.title, header: k.header(r), body: r.body, at: r.at, tokens: new Set(), bonus: 0 };
      cands.set(key, c);
    }
    if (token !== null) c.tokens.add(token);
    c.bonus = Math.max(c.bonus, bonus);
  };
  const run = (k: Kind, where: string, params: (string | number)[], limit: number): Row[] =>
    db.prepare(`${k.select}${where} ORDER BY ${k.order} LIMIT ${limit}`).all(...params) as unknown as Row[];
  const extras = (kind: SourceRef['kind'], cond: string, id: number, limit: number): void => {
    const k = KIND_BY_NAME.get(kind)!;
    for (const r of run(k, ` AND ${cond}`, [id], limit)) add(k, r, null, NAMED_BONUS);
  };

  // One query per kind, scored in SQL: the number of distinct question words found in the row's columns. Rows
  // are ordered by that score first (then recency) before the LIMIT, so the best multi-word match is never
  // pushed out by newer rows that match a single word.
  if (tokens.length > 0) {
    const pats = tokens.map(likePattern);
    for (const k of KINDS) {
      const score = tokens
        .map((_, i) => `(${k.likeCols.map((c) => `xo_fold(${c}) LIKE ?${i + 1} ESCAPE '\\'`).join(' OR ')})`)
        .join(' + ');
      const sql = `${k.select} AND (${score}) > 0 ORDER BY (${score}) DESC, ${k.order} LIMIT ${perQuery}`;
      for (const r of db.prepare(sql).all(...pats) as unknown as Row[]) add(k, r, null, 0);
    }
  }
  for (const p of people) {
    extras('person', 'p.id = ?1', p.id, 1);
    extras('note', 'n.person_id = ?1', p.id, EXTRA.notes);
    extras('agenda', "g.person_id = ?1 AND g.status = 'open'", p.id, EXTRA.agenda);
    extras('action', "a.person_id = ?1 AND a.status = 'open'", p.id, EXTRA.actions);
    extras('meeting', 'm.person_id = ?1', p.id, 1);
  }
  for (const j of named) {
    extras('project', 'j.id = ?1', j.id, 1);
    extras('action', "a.project_id = ?1 AND a.status = 'open'", j.id, EXTRA.actions);
    extras('note', 'n.project_id = ?1', j.id, EXTRA.notes);
  }

  const scored = [...cands.values()].map((c) => {
    const hay = fold(`${c.title}\n${c.header}\n${c.body}`);
    for (const t of tokens) if (hay.includes(t)) c.tokens.add(t);
    return { c, score: c.tokens.size + c.bonus };
  });
  scored.sort((a, b) =>
    b.score - a.score || (a.c.at < b.c.at ? 1 : a.c.at > b.c.at ? -1 : 0) ||
    (a.c.kind.kind < b.c.kind.kind ? -1 : a.c.kind.kind > b.c.kind.kind ? 1 : 0) || b.c.id - a.c.id);

  const out: Excerpt[] = [];
  let total = 0;
  for (const { c } of scored) {
    if (out.length >= maxExcerpts) break;
    const title = clip(flat(c.title), MAX_TITLE_CHARS);
    const header = c.header === '' ? '' : `[${flat(c.header)}] `;
    const room = Math.min(maxChars, maxTotal - total - title.length);
    if (room <= header.length) break;
    const text = `${header}${cutAround(flat(c.body), tokens, room - header.length)}`.trimEnd();
    out.push({ kind: c.kind.kind, id: c.id, title, text });
    total += title.length + text.length;
  }
  return out;
}

/** At most `n` characters of `body`, centred on the first question word found in it (else from the start). */
function cutAround(body: string, tokens: string[], n: number): string {
  if (n <= 0) return '';
  if (body.length <= n) return body;
  const hay = fold(body);
  let at = -1;
  for (const t of tokens) {
    const i = hay.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  // Folding can change the length ('İ'); scale the offset so the window stays roughly on the match.
  if (at > 0 && hay.length !== body.length) at = Math.floor((at * body.length) / hay.length);
  // Room for the two possible ellipses, so the result never exceeds `n` characters.
  const w = Math.max(1, n - 2);
  let start = at <= 0 ? 0 : Math.max(0, Math.min(at - Math.floor(w / 4), body.length - w));
  let end = start + w;
  // Never split a surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(body[start] ?? '')) start++;
  if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1] ?? '')) end--;
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

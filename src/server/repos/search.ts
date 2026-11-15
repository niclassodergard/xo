import type { DatabaseSync } from 'node:sqlite';
import type { SearchHit } from '../../shared/api.ts';
import type { ItemKind } from '../../shared/types.ts';

const SNIPPET_RADIUS = 40;
const KIND_COUNT = 5;

/**
 * NFC + lower-case; Unicode-aware, unlike SQLite's own LIKE which only folds ASCII. The only
 * context-sensitive case mapping is the final sigma ('Σ' -> 'ς' or 'σ'), which would differ from the
 * per-code-point mapping `snippet` uses to map offsets, so strings containing 'Σ' fold per code point.
 */
export function fold(s: string): string {
  const n = s.normalize('NFC');
  if (!n.includes('Σ')) return n.toLowerCase();
  let out = '';
  for (const ch of n) out += ch.toLowerCase();
  return out;
}

const registered = new WeakSet<DatabaseSync>();
function ensureFold(db: DatabaseSync): void {
  if (registered.has(db)) return;
  db.function('xo_fold', { deterministic: true }, (v) => (typeof v === 'string' ? fold(v) : v));
  registered.add(db);
}

/** Escape LIKE wildcards; pair with `ESCAPE '\'`. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Snippet around the first match. Folding can change string length ('İ' lower-cases to two code
 * units), so the folded text is built with an offset map back into the original text; the snippet is
 * always cut from the original and contains the matched text. `foldedQ` is already folded.
 * Returns null when the text has no match.
 */
function snippet(text: string, foldedQ: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim().normalize('NFC');
  let folded = '';
  const map: number[] = []; // folded UTF-16 offset -> original offset
  let pos = 0;
  for (const ch of flat) {
    const lo = ch.toLowerCase();
    for (let k = 0; k < lo.length; k++) map.push(pos);
    folded += lo;
    pos += ch.length;
  }
  const idx = folded.indexOf(foldedQ);
  if (idx < 0) return null;
  const matchStart = map[idx] ?? 0;
  const endIdx = idx + foldedQ.length;
  const matchEnd = endIdx < map.length ? (map[endIdx] ?? flat.length) : flat.length;
  const start = Math.max(0, matchStart - SNIPPET_RADIUS);
  const end = Math.min(flat.length, matchEnd + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

function prefix(text: string): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, SNIPPET_RADIUS * 2).join('');
}

function oneLine(text: string, max = 80): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

interface Row { id: number; a: string; b: string; person_id: number | null; c?: string | null; archived_at?: string | null }

/**
 * Substring search over people, meeting notes, notes, actions and agenda items (in that order).
 * Soft-deleted rows are excluded; archived people stay searchable and are marked `archived`.
 * Each kind gets a fair share of ceil(limit/5) slots first; unused slots go to the earlier kinds
 * that have more matches, so one kind cannot crowd out the others.
 */
export function search(db: DatabaseSync, q: string, limit = 50): SearchHit[] {
  const term = q.trim();
  if (term === '') return [];
  ensureFold(db);
  const foldedTerm = fold(term);
  const pat = likePattern(foldedTerm);

  const hit = (kind: ItemKind | 'person' | 'meeting', r: Row, title: string, snip: string, archived = false): SearchHit => ({
    kind, id: r.id, title, snippet: snip, personId: r.person_id, archived,
  });
  const text = (r: Row, ...candidates: string[]): string => {
    for (const c of candidates) {
      const s = snippet(c, foldedTerm);
      if (s !== null) return s;
    }
    return prefix(candidates[0] ?? r.a);
  };

  // Aliases are stored as JSON; confirm the hit is in a real alias, not JSON syntax.
  const people: SearchHit[] = [];
  const peopleRows = db
    .prepare(
      `SELECT id, name AS a, aliases AS b, id AS person_id, archived_at FROM people
       WHERE xo_fold(name) LIKE ?1 ESCAPE '\\' OR xo_fold(aliases) LIKE ?1 ESCAPE '\\'
       ORDER BY xo_fold(name), id LIMIT ?2`,
    )
    .all(pat, limit) as unknown as Row[];
  for (const r of peopleRows) {
    let aliases: string[] = [];
    try {
      const v: unknown = JSON.parse(r.b);
      if (Array.isArray(v)) aliases = v.filter((x): x is string => typeof x === 'string');
    } catch { /* ignore malformed */ }
    const archived = r.archived_at != null;
    if (fold(r.a).includes(foldedTerm)) people.push(hit('person', r, r.a, aliases.join(', '), archived));
    else {
      const alias = aliases.find((x) => fold(x).includes(foldedTerm));
      if (alias !== undefined) people.push(hit('person', r, r.a, alias, archived));
    }
  }

  const meetings = (
    db
      .prepare(
        `SELECT m.id AS id, p.name AS a, m.notes_md AS b, m.person_id AS person_id, m.started_at AS c, p.archived_at AS archived_at
         FROM meetings m JOIN people p ON p.id = m.person_id
         WHERE xo_fold(m.notes_md) LIKE ?1 ESCAPE '\\' ORDER BY m.id DESC LIMIT ?2`,
      )
      .all(pat, limit) as unknown as Row[]
  ).map((r) => hit('meeting', r, `1-1 ${r.a} ${String(r.c ?? '').slice(0, 10)}`.trim(), text(r, r.b), r.archived_at != null));

  const notes = (
    db
      .prepare(
        `SELECT id, title AS a, body_md AS b, person_id FROM notes
         WHERE deleted_at IS NULL AND (xo_fold(title) LIKE ?1 ESCAPE '\\' OR xo_fold(body_md) LIKE ?1 ESCAPE '\\')
         ORDER BY id DESC LIMIT ?2`,
      )
      .all(pat, limit) as unknown as Row[]
  ).map((r) => hit('note', r, r.a, text(r, r.b, r.a)));

  const actions = (
    db
      .prepare(
        `SELECT id, text AS a, '' AS b, person_id FROM actions
         WHERE deleted_at IS NULL AND xo_fold(text) LIKE ?1 ESCAPE '\\' ORDER BY id DESC LIMIT ?2`,
      )
      .all(pat, limit) as unknown as Row[]
  ).map((r) => hit('action', r, oneLine(r.a), text(r, r.a)));

  const agenda = (
    db
      .prepare(
        `SELECT id, text AS a, '' AS b, person_id FROM agenda_items
         WHERE deleted_at IS NULL AND xo_fold(text) LIKE ?1 ESCAPE '\\' ORDER BY id DESC LIMIT ?2`,
      )
      .all(pat, limit) as unknown as Row[]
  ).map((r) => hit('agenda', r, oneLine(r.a), text(r, r.a)));

  const groups = [people, meetings, notes, actions, agenda];
  const share = Math.ceil(limit / KIND_COUNT);
  const take = groups.map((g) => Math.min(g.length, share));
  let spare = limit - take.reduce((a, b) => a + b, 0);
  for (let i = 0; i < groups.length && spare > 0; i++) {
    const extra = Math.min((groups[i]?.length ?? 0) - (take[i] ?? 0), spare);
    take[i] = (take[i] ?? 0) + extra;
    spare -= extra;
  }
  return groups.flatMap((g, i) => g.slice(0, take[i])).slice(0, limit);
}

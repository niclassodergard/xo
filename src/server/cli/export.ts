import { randomBytes } from 'node:crypto';
import { fstatSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { Action, AgendaItem, Id, Meeting, Note, Person } from '../../shared/types.ts';
import { listActions } from '../repos/actions.ts';
import { mapAgendaItem } from '../repos/agenda.ts';
import { getMeetingDetail } from '../repos/meetings.ts';
import { listNotes } from '../repos/notes.ts';
import { getPersonDetail, listPeople } from '../repos/people.ts';

const USAGE = 'Usage: pnpm xo export [--out <dir>]';
// Filenames stay far below the 255-byte limit: date (10) + slug + id (<= 16) + extras.
const MAX_SLUG_BYTES = 80;

/** Lower-case, Unicode-aware slug: letters and digits only, so no separators or dots survive. Capped by UTF-8 bytes. */
export function slugify(input: string): string {
  const s = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > MAX_SLUG_BYTES) break;
    out += ch;
    bytes += n;
  }
  out = out.replace(/-+$/g, '');
  return out === '' ? 'untitled' : out;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Default directory name `xo-export-YYYYMMDD-HHmmss`, in UTC like every other time in the export. */
export function defaultExportDir(now: Date): string {
  return `xo-export-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parseArgs(args: string[]): { out: string | null } {
  let out: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--out') {
      const v = args[++i];
      if (v === undefined || v === '') throw new Error(`--out needs a directory. ${USAGE}`);
      out = v;
    } else if (a.startsWith('--out=') && a.length > 6) {
      out = a.slice(6);
    } else {
      throw new Error(`unknown argument. ${USAGE}`);
    }
  }
  return { out };
}

// ---- rendering (pure; all times are UTC) ----

/** Collapse a user string to one line (for headings and list items). */
function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

const day = (iso: string): string => iso.slice(0, 10);
const minute = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Embeds user Markdown as a blockquote so its headings, rules and fences cannot change the outline
 * of the exported file (every line is prefixed with "> ").
 */
export function quoteBody(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (t === '') return '';
  return t.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)).join('\n') + '\n\n';
}

function agendaLine(a: AgendaItem): string {
  const box = a.status === 'done' ? 'x' : a.status === 'dropped' ? '-' : ' ';
  return `- [${box}] ${oneLine(a.text)}${a.status === 'dropped' ? ' (dropped)' : ''}`;
}

function actionLine(a: Action, names: Map<Id, string>, withPerson: boolean): string {
  const person = withPerson && a.personId !== null && names.has(a.personId) ? ` (${oneLine(names.get(a.personId) as string)})` : '';
  const done = a.status === 'done' && a.doneAt ? ` (done ${day(a.doneAt)})` : '';
  return `- [${a.status === 'done' ? 'x' : ' '}] (${a.owner})${person} ${oneLine(a.text)}${done}`;
}

function noteFileName(n: Note): string {
  return `${day(n.createdAt)}-${slugify(n.title)}-${n.id}.md`;
}

/** Agenda items closed outside any meeting (done or dropped from the person view). */
function resolvedOutside(db: DatabaseSync, personId: Id): AgendaItem[] {
  const rows = db
    .prepare(
      "SELECT * FROM agenda_items WHERE person_id = ? AND status != 'open' AND resolved_meeting_id IS NULL AND deleted_at IS NULL ORDER BY resolved_at, id",
    )
    .all(personId) as unknown as Parameters<typeof mapAgendaItem>[0][];
  return rows.map(mapAgendaItem);
}

function meetingSection(db: DatabaseSync, m: Meeting): string {
  const detail = getMeetingDetail(db, m.id);
  let s = `### ${minute(m.startedAt)}${m.endedAt === null ? ' (in progress)' : ''}\n\n`;
  s += quoteBody(m.notesMd);
  const resolved = detail?.resolvedHere ?? [];
  if (resolved.length > 0) s += `Agenda resolved:\n\n${resolved.map(agendaLine).join('\n')}\n\n`;
  const follow = detail?.actionsHere ?? [];
  if (follow.length > 0) s += `Follow-ups:\n\n${follow.map((a) => actionLine(a, new Map(), false)).join('\n')}\n\n`;
  return s;
}

function personFile(db: DatabaseSync, p: Person): string {
  const d = getPersonDetail(db, p.id);
  if (!d) return `# ${oneLine(p.name)}\n`;
  let s = `# ${oneLine(p.name)}\n\n`;
  if (p.aliases.length > 0) s += `Aliases: ${p.aliases.map(oneLine).join(', ')}\n\n`;
  if (p.archivedAt) s += `Archived: ${day(p.archivedAt)}\n\n`;
  if (p.notesMd.trim() !== '') s += `## Notes about ${oneLine(p.name)}\n\n${quoteBody(p.notesMd)}`;
  s += `## Open agenda\n\n${d.openAgenda.length ? d.openAgenda.map(agendaLine).join('\n') : '(none)'}\n\n`;
  s += `## Open actions\n\n${d.openActions.length ? d.openActions.map((a) => actionLine(a, new Map(), false)).join('\n') : '(none)'}\n\n`;
  const outside = resolvedOutside(db, p.id);
  if (outside.length > 0) s += `## Resolved outside meetings\n\n${outside.map(agendaLine).join('\n')}\n\n`;
  if (d.notes.length > 0) {
    s += `## Linked notes\n\n${d.notes.map((n) => `- [${oneLine(n.title)}](../notes/${noteFileName(n)})`).join('\n')}\n\n`;
  }
  s += `## Meetings\n\n`;
  s += d.meetings.length ? d.meetings.map((m) => meetingSection(db, m)).join('') : '(none)\n';
  return s.trimEnd() + '\n';
}

function noteFile(n: Note, names: Map<Id, string>): string {
  let s = `# ${oneLine(n.title)}\n\n`;
  s += `Created: ${minute(n.createdAt)}`;
  if (n.updatedAt !== n.createdAt) s += ` · Updated: ${minute(n.updatedAt)}`;
  if (n.personId !== null && names.has(n.personId)) s += ` · Person: ${oneLine(names.get(n.personId) as string)}`;
  return `${s}\n\n${quoteBody(n.bodyMd)}`.trimEnd() + '\n';
}

/** First free name: `<slug>.md`, then `<slug>-<id>.md`, then `<slug>-<id>-2.md`, ... */
function uniqueName(slug: string, id: Id, used: Set<string>): string {
  let name = `${slug}.md`;
  for (let n = 1; used.has(name); n++) name = n === 1 ? `${slug}-${id}.md` : `${slug}-${id}-${n}.md`;
  used.add(name);
  return name;
}

interface ExportFile { rel: string; content: string }

/** Reads everything inside one read transaction (one snapshot) and renders the files in memory. */
function buildFiles(db: DatabaseSync): { files: ExportFile[]; summary: ExportSummary } {
  db.exec('BEGIN');
  try {
    const people = listPeople(db, { includeArchived: true });
    const names = new Map<Id, string>(people.map((p) => [p.id, p.name]));
    const files: ExportFile[] = [];

    const used = new Set<string>();
    // Lowest id keeps the plain slug, so file names are stable across exports.
    for (const p of [...people].sort((x, y) => x.id - y.id)) {
      files.push({ rel: `people/${uniqueName(slugify(p.name), p.id, used)}`, content: personFile(db, p) });
    }
    const notes = listNotes(db);
    for (const n of notes) {
      // The id is the last token of the name, so note file names are unique by construction.
      files.push({ rel: `notes/${noteFileName(n)}`, content: noteFile(n, names) });
    }
    const open = listActions(db, { status: 'open' });
    const done = listActions(db, { status: 'done' });
    const section = (title: string, list: Action[]): string =>
      `## ${title}\n\n${list.length ? list.map((a) => actionLine(a, names, true)).join('\n') : '(none)'}\n`;
    files.push({ rel: 'actions.md', content: `# Actions\n\n${section('Open', open)}\n${section('Done', done)}` });
    return { files, summary: { people: people.length, notes: notes.length, actions: open.length + done.length } };
  } finally {
    db.exec('ROLLBACK'); // read-only: just ends the snapshot
  }
}

// ---- filesystem ----

const uid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/** Fails closed unless `path` is a real directory owned by us with no group/other write (and, if `exact`, mode 0700). */
function requireOwnDir(path: string, what: string, exact: boolean): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${what} is not a real directory`);
  const me = uid();
  if (me !== null && st.uid !== me) throw new Error(`${what} is not owned by the current user`);
  if (exact && (st.mode & 0o777) !== 0o700) throw new Error(`${what} does not have mode 0700`);
  if (!exact && (st.mode & 0o022) !== 0) throw new Error(`${what} is writable by group or others`);
}

/** Checks the target: absent, or an existing empty real directory we own that others cannot write to. */
function checkTarget(dir: string): 'absent' | 'empty-dir' {
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
  if (st.isSymbolicLink()) throw new Error('output path is a symbolic link; refusing to write through it');
  if (!st.isDirectory()) throw new Error('output path exists and is not a directory');
  requireOwnDir(dir, 'output directory', false);
  if (readdirSync(dir).length > 0) throw new Error('output directory is not empty; choose a new or empty directory');
  return 'empty-dir';
}

/** Writes a new file, mode 0600. `wx` fails if anything (including a symlink) already exists there. */
function writeNew(path: string, content: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** Filesystem errors are reported by code only: paths and file names are user data. */
function sanitizeFsError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string') return new Error(`export failed (${code}); nothing was left behind`);
  return err instanceof Error ? err : new Error('export failed');
}

export interface ExportSummary { people: number; notes: number; actions: number }

/**
 * Exports into `outDir`, which must not exist or be an empty directory you own. Everything is read in
 * one snapshot, written into a temporary sibling directory (0700, files 0600) and then moved into
 * place, so a failure leaves neither a partial export nor a blocked target. Soft-deleted rows are skipped.
 */
export function exportAll(db: DatabaseSync, outDir: string): ExportSummary {
  const target = resolve(outDir);
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  let tmpMade = false;
  const moved: string[] = [];
  try {
    const state = checkTarget(target);
    let parent;
    try {
      // statSync follows a symlinked parent (e.g. /tmp -> /private/tmp) so the real directory is checked.
      parent = statSync(dirname(target));
    } catch {
      throw new Error('parent of the output directory does not exist');
    }
    // A parent others can write to (without the sticky bit) lets them swap or remove our directory.
    if ((parent.mode & 0o002) !== 0 && (parent.mode & 0o1000) === 0) {
      throw new Error('parent of the output directory is world-writable without the sticky bit');
    }
    if ((parent.mode & 0o020) !== 0 && (parent.mode & 0o1000) === 0) {
      throw new Error('parent of the output directory is group-writable without the sticky bit');
    }
    const { files, summary } = buildFiles(db);

    mkdirSync(tmp, { mode: 0o700 }); // non-recursive: fails if anything exists
    tmpMade = true;
    requireOwnDir(tmp, 'temporary directory', true);
    mkdirSync(join(tmp, 'people'), { mode: 0o700 });
    mkdirSync(join(tmp, 'notes'), { mode: 0o700 });
    requireOwnDir(join(tmp, 'people'), 'people directory', true);
    requireOwnDir(join(tmp, 'notes'), 'notes directory', true);
    for (const f of files) writeNew(join(tmp, f.rel), f.content);

    if (state === 'absent') {
      renameSync(tmp, target);
      tmpMade = false;
    } else {
      // Existing empty directory: keep it (and its mode) and move the three entries in.
      for (const name of ['people', 'notes', 'actions.md']) {
        renameSync(join(tmp, name), join(target, name));
        moved.push(name);
      }
      rmdirSync(tmp);
      tmpMade = false;
    }
    return summary;
  } catch (err) {
    // Cleanup is best effort: its failure must never replace the sanitised error or leak a path.
    for (const name of moved) {
      try { rmSync(join(target, name), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (tmpMade) {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    throw sanitizeFsError(err);
  }
}

export async function run(args: string[], ctx: { config: Config; db: DatabaseSync }): Promise<void> {
  const { out } = parseArgs(args);
  const target = out ?? defaultExportDir(new Date());
  const summary = exportAll(ctx.db, target);
  console.log(
    `Exported ${summary.people} people, ${summary.notes} notes and ${summary.actions} actions to ${resolve(target)} (times are UTC). ` +
      'Captures still waiting for classification are not exported. ' +
      'The export is plaintext: keep it private and delete it when no longer needed.',
  );
}

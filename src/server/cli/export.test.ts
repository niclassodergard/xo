import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestDb } from '../../../test/helpers.ts';
import { createAction, softDeleteAction, updateAction } from '../repos/actions.ts';
import { createAgendaItem, softDeleteAgendaItem, updateAgendaItem } from '../repos/agenda.ts';
import { endMeeting, startMeeting, updateMeetingNotes } from '../repos/meetings.ts';
import { createNote, softDeleteNote } from '../repos/notes.ts';
import { createPerson, updatePerson } from '../repos/people.ts';
import { defaultExportDir, exportAll, run, slugify } from './export.ts';

const T = (n: number) => new Date(Date.UTC(2026, 0, 10 + n, 9, 30));
const tmp: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'xo-export-test-'));
  tmp.push(d);
  return d;
}
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Every file below `dir`, relative, sorted. */
function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out.sort();
}
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

function seed() {
  const db = makeTestDb();
  const anna = createPerson(db, { name: 'Åsa Berg', aliases: ['Åsa'] }, T(0));
  const a1 = createAgendaItem(db, { personId: anna.id, text: 'hiring plan' }, T(0));
  createAgendaItem(db, { personId: anna.id, text: 'budget' }, T(0));
  createAgendaItem(db, { personId: anna.id, text: 'carry over' }, T(0));
  const m1 = startMeeting(db, anna.id, T(1))!;
  updateAgendaItem(db, a1.id, { status: 'done', meetingId: m1.meeting.id }, T(1));
  createAction(db, { text: 'send budget', owner: 'me', personId: anna.id, meetingId: m1.meeting.id }, T(1));
  createAction(db, { text: 'review draft', owner: 'them', personId: anna.id, meetingId: m1.meeting.id }, T(1));
  updateMeetingNotes(db, m1.meeting.id, 'Talked about hiring.');
  endMeeting(db, m1.meeting.id, T(1));
  const m2 = startMeeting(db, anna.id, T(8))!;
  updateMeetingNotes(db, m2.meeting.id, 'Second meeting notes.');
  endMeeting(db, m2.meeting.id, T(8));
  updateAction(db, createAction(db, { text: 'old thing', personId: null }, T(2)).id, { status: 'done' }, T(3));
  createNote(db, { title: 'Idea', bodyMd: 'A body\nwith lines', personId: anna.id }, T(2));
  return { db, anna };
}

describe('slugify', () => {
  it('keeps letters, drops separators and dots', () => {
    expect(slugify('Åsa Berg')).toBe('åsa-berg');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('.hidden')).toBe('hidden');
    expect(slugify('a/b\\c')).toBe('a-b-c');
    expect(slugify('...')).toBe('untitled');
    expect(slugify('')).toBe('untitled');
    expect(slugify('x'.repeat(500)).length).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(slugify('å'.repeat(500)))).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(slugify('😀a'.repeat(100)))).toBeLessThanOrEqual(80);
  });
});

describe('defaultExportDir', () => {
  it('formats xo-export-YYYYMMDD-HHmmss', () => {
    expect(defaultExportDir(new Date(Date.UTC(2026, 0, 5, 7, 8, 9)))).toBe('xo-export-20260105-070809');
  });
});

describe('exportAll', () => {
  it('writes people, notes and actions with the expected content', () => {
    const { db } = seed();
    const out = join(tmpDir(), 'out');
    const summary = exportAll(db, out);
    expect(summary).toEqual({ people: 1, notes: 1, actions: 3 });
    const files = walk(out);
    expect(files).toContain('actions.md');
    expect(files).toContain('people/åsa-berg.md');
    expect(files.filter((f) => f.startsWith('notes/'))).toHaveLength(1);
    expect(files.find((f) => f.startsWith('notes/'))).toMatch(/^notes\/2026-01-12-idea-\d+\.md$/);

    const person = read(out, 'people/åsa-berg.md');
    expect(person).toContain('# Åsa Berg');
    expect(person).toContain('Aliases: Åsa');
    expect(person).toContain('- [ ] budget');
    expect(person).toContain('- [ ] carry over');
    expect(person).not.toMatch(/## Open agenda[\s\S]*hiring plan[\s\S]*## Open actions/); // resolved, not open
    expect(person).toContain('Talked about hiring.');
    expect(person).toContain('Second meeting notes.');
    expect(person).toContain('- [x] hiring plan');
    expect(person).toContain('- [ ] (me) send budget');
    expect(person).toContain('- [ ] (them) review draft');
    expect(person).toContain('](../notes/2026-01-12-idea-');
    // newest meeting first
    expect(person.indexOf('Second meeting notes.')).toBeLessThan(person.indexOf('Talked about hiring.'));

    const note = read(out, files.find((f) => f.startsWith('notes/'))!);
    expect(note).toContain('# Idea');
    expect(note).toContain('> A body\n> with lines');
    expect(note).toContain('Person: Åsa Berg');

    const actions = read(out, 'actions.md');
    expect(actions.indexOf('## Open')).toBeLessThan(actions.indexOf('## Done'));
    expect(actions.slice(actions.indexOf('## Open'), actions.indexOf('## Done'))).toContain('send budget');
    expect(actions.slice(actions.indexOf('## Done'))).toContain('old thing');
    expect(actions).toContain('(Åsa Berg)');
  });

  it('skips soft-deleted notes, actions and agenda items', () => {
    const { db, anna } = seed();
    const n = createNote(db, { bodyMd: 'SECRET-NOTE-BODY' }, T(3));
    const a = createAction(db, { text: 'SECRET-ACTION', personId: anna.id }, T(3));
    const g = createAgendaItem(db, { personId: anna.id, text: 'SECRET-AGENDA' }, T(3));
    softDeleteNote(db, n.id, T(4));
    softDeleteAction(db, a.id, T(4));
    softDeleteAgendaItem(db, g.id, T(4));
    const out = join(tmpDir(), 'out');
    exportAll(db, out);
    const all = walk(out).map((f) => read(out, f)).join('\n');
    expect(all).not.toContain('SECRET');
    expect(all).toContain('budget'); // and the capture of live content is really there
  });

  it('keeps hostile names inside the output directory', () => {
    const db = makeTestDb();
    for (const name of ['../../etc', '.hidden', 'a/b\\c', '/abs/path', '..']) createPerson(db, { name }, T(0));
    createNote(db, { title: '../../evil', bodyMd: 'x' }, T(0));
    const base = tmpDir();
    const out = join(base, 'out');
    exportAll(db, out);
    const files = walk(out);
    expect(files.filter((f) => f.startsWith('people/'))).toHaveLength(5);
    for (const f of files) {
      expect(f.split('/').every((seg) => seg !== '..' && !seg.startsWith('.'))).toBe(true);
      expect(resolve(out, f).startsWith(resolve(out) + '/')).toBe(true);
    }
    expect(readdirSync(base)).toEqual(['out']);
  });

  it('disambiguates people whose names slug the same', () => {
    const db = makeTestDb();
    const a = createPerson(db, { name: 'Anna B' }, T(0));
    const b = createPerson(db, { name: 'anna  b' }, T(0));
    const out = join(tmpDir(), 'out');
    exportAll(db, out);
    expect(walk(out).filter((f) => f.startsWith('people/')).sort()).toEqual([`people/anna-b-${b.id}.md`, 'people/anna-b.md']);
    expect(read(out, 'people/anna-b.md')).toContain('# Anna B');
    expect(a.id).toBeLessThan(b.id);
  });

  it('creates the directory 0700 and files 0600', () => {
    const { db } = seed();
    const out = join(tmpDir(), 'out');
    exportAll(db, out);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(statSync(join(out, 'people')).mode & 0o777).toBe(0o700);
    for (const f of walk(out)) expect(statSync(join(out, f)).mode & 0o777).toBe(0o600);
  });

  it('refuses a non-empty directory and leaves it untouched', () => {
    const { db } = seed();
    const out = tmpDir();
    writeFileSync(join(out, 'keep.txt'), 'mine');
    expect(() => exportAll(db, out)).toThrow(/not empty/);
    expect(readdirSync(out)).toEqual(['keep.txt']);
  });

  it('accepts an existing empty directory and keeps its mode', () => {
    const { db } = seed();
    const out = tmpDir();
    chmodSync(out, 0o750);
    exportAll(db, out);
    expect(statSync(out).mode & 0o777).toBe(0o750);
    expect(existsSync(join(out, 'actions.md'))).toBe(true);
    expect(readdirSync(dirname(out)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('refuses an existing directory that is group- or other-writable', () => {
    const { db } = seed();
    for (const mode of [0o770, 0o707, 0o777]) {
      const out = tmpDir();
      chmodSync(out, mode);
      expect(() => exportAll(db, out)).toThrow(/writable by group or others/);
      expect(readdirSync(out)).toEqual([]);
    }
  });

  it('does not create missing parent directories', () => {
    const { db } = seed();
    const base = tmpDir();
    expect(() => exportAll(db, join(base, 'no', 'such', 'out'))).toThrow();
    expect(readdirSync(base)).toEqual([]);
  });

  it('survives colliding people names (Anna, Anna 3, Anna) with unique files', () => {
    const db = makeTestDb();
    const ids = ['Anna', 'Anna 3', 'Anna', 'Anna 3', 'anna'].map((name) => createPerson(db, { name }, T(0)).id);
    const out = join(tmpDir(), 'out');
    exportAll(db, out);
    const files = walk(out).filter((f) => f.startsWith('people/'));
    expect(new Set(files).size).toBe(5);
    expect(files).toContain('people/anna.md');
    expect(files).toContain(`people/anna-${ids[2]}.md`);
    expect(files).toContain('people/anna-3.md');
  });

  it('exports people with very long non-ASCII names', () => {
    const db = makeTestDb();
    createPerson(db, { name: 'å'.repeat(200) }, T(0));
    createNote(db, { title: 'ö'.repeat(300), bodyMd: 'x' }, T(0));
    const out = join(tmpDir(), 'out');
    exportAll(db, out);
    for (const f of walk(out)) expect(Buffer.byteLength(f.split('/').pop()!)).toBeLessThan(255);
  });

  it('leaves nothing behind and does not block a retry when writing fails', () => {
    const db = makeTestDb();
    createPerson(db, { name: 'Anna' }, T(0));
    const base = tmpDir();
    const out = join(base, 'out');
    // Make the temp directory unwritable by pre-creating nothing: instead force a failure through a read-only parent.
    chmodSync(base, 0o500);
    try {
      expect(() => exportAll(db, out)).toThrow(/export failed \(\w+\)/);
    } finally {
      chmodSync(base, 0o700);
    }
    expect(readdirSync(base)).toEqual([]);
    exportAll(db, out);
    expect(existsSync(join(out, 'actions.md'))).toBe(true);
  });

  it('error messages do not contain file names', () => {
    const db = makeTestDb();
    createPerson(db, { name: 'Secret Person' }, T(0));
    const base = tmpDir();
    chmodSync(base, 0o500);
    let msg = '';
    try {
      exportAll(db, join(base, 'sensitive-dir'));
    } catch (e) {
      msg = (e as Error).message;
    } finally {
      chmodSync(base, 0o700);
    }
    expect(msg).toMatch(/export failed/);
    expect(msg).not.toContain('sensitive-dir');
    expect(msg).not.toContain('secret');
  });

  it('includes agenda items resolved outside a meeting, but not deleted ones', () => {
    const db = makeTestDb();
    const p = createPerson(db, { name: 'Bo' }, T(0));
    const a = createAgendaItem(db, { personId: p.id, text: 'done outside' }, T(0));
    const b = createAgendaItem(db, { personId: p.id, text: 'dropped outside' }, T(0));
    const c = createAgendaItem(db, { personId: p.id, text: 'DELETED outside' }, T(0));
    createAgendaItem(db, { personId: p.id, text: 'still open' }, T(0));
    updateAgendaItem(db, a.id, { status: 'done' }, T(1));
    updateAgendaItem(db, b.id, { status: 'dropped' }, T(1));
    updateAgendaItem(db, c.id, { status: 'done' }, T(1));
    softDeleteAgendaItem(db, c.id, T(2));
    const out = join(tmpDir(), 'out');
    exportAll(db, out);
    const person = read(out, 'people/bo.md');
    const sec = person.slice(person.indexOf('## Resolved outside meetings'));
    expect(person).toContain('## Resolved outside meetings');
    expect(sec).toContain('- [x] done outside');
    expect(sec).toContain('- [-] dropped outside (dropped)');
    expect(person).not.toContain('DELETED');
    expect(person.slice(person.indexOf('## Open agenda'), person.indexOf('## Resolved'))).toContain('still open');
  });

  it('puts user Markdown in blockquotes so headings cannot break the outline', () => {
    const db = makeTestDb();
    const p = createPerson(db, { name: 'Cy' }, T(0));
    updatePerson(db, p.id, { notesMd: '# Evil H1\n\n## Evil H2' }, T(0));
    createNote(db, { title: 'T', bodyMd: '# Body H1\n---\ntext', personId: p.id }, T(0));
    const m = startMeeting(db, p.id, T(1))!;
    updateMeetingNotes(db, m.meeting.id, '# Meeting H1\nSetext\n=====');
    const out = join(tmpDir(), 'out');
    exportAll(db, out);
    for (const f of walk(out).filter((x) => x.endsWith('.md') && x !== 'actions.md')) {
      const headings = read(out, f).split('\n').filter((l) => /^#{1,6} /.test(l));
      expect(headings.every((h) => !/Evil|Body H1|Meeting H1/.test(h))).toBe(true);
    }
    const person = read(out, 'people/cy.md');
    expect(person).toContain('> # Evil H1');
    expect(person).toContain('> Setext');
    expect(read(out, walk(out).find((f) => f.startsWith('notes/'))!)).toContain('> # Body H1');
  });

  it('writes owner labels that a link reference definition cannot turn into links', () => {
    const db = makeTestDb();
    const p = createPerson(db, { name: 'Di' }, T(0));
    createAction(db, { text: 'x', owner: 'me', personId: p.id }, T(0));
    createAction(db, { text: 'y', owner: 'them', personId: p.id }, T(0));
    const out = join(tmpDir(), 'out');
    exportAll(db, out);
    const actions = read(out, 'actions.md');
    expect(actions).toContain('(me)');
    expect(actions).toContain('(them)');
    expect(actions).not.toMatch(/\[(me|them)\]/);
  });

  it('refuses a world- or group-writable parent without the sticky bit, allows it with', () => {
    const db = makeTestDb();
    const parent = tmpDir();
    chmodSync(parent, 0o777);
    expect(() => exportAll(db, join(parent, 'out'))).toThrow(/sticky/);
    chmodSync(parent, 0o770);
    expect(() => exportAll(db, join(parent, 'out'))).toThrow(/sticky/);
    chmodSync(parent, 0o1777);
    exportAll(db, join(parent, 'out'));
    expect(existsSync(join(parent, 'out', 'actions.md'))).toBe(true);
    chmodSync(parent, 0o700);
  });

  it('labels times as UTC', () => {
    const { db } = seed();
    const out = join(tmpDir(), 'out');
    exportAll(db, out);
    expect(read(out, 'people/åsa-berg.md')).toContain('### 2026-01-11 09:30 UTC');
  });

  it('leaves the database usable after export (snapshot transaction closed)', () => {
    const { db, anna } = seed();
    exportAll(db, join(tmpDir(), 'out'));
    expect(() => createAgendaItem(db, { personId: anna.id, text: 'after' }, T(9))).not.toThrow();
  });

  it('refuses a symlink as output directory, even to an empty directory', () => {
    const { db } = seed();
    const base = tmpDir();
    const target = join(base, 'target');
    mkdirSync(target);
    const link = join(base, 'link');
    symlinkSync(target, link);
    expect(() => exportAll(db, link)).toThrow(/symbolic link/);
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses a file as output path', () => {
    const { db } = seed();
    const f = join(tmpDir(), 'file');
    writeFileSync(f, 'x');
    expect(() => exportAll(db, f)).toThrow(/not a directory/);
  });
});

describe('run', () => {
  it('rejects unknown arguments and a missing --out value before writing anything', async () => {
    const db = makeTestDb();
    const ctx = { config: {} as never, db };
    await expect(run(['--bogus'], ctx)).rejects.toThrow(/Usage/);
    await expect(run(['--out'], ctx)).rejects.toThrow(/--out needs/);
  });

  it('exports to --out and --out=', async () => {
    const { db } = seed();
    const base = tmpDir();
    await run(['--out', join(base, 'a')], { config: {} as never, db });
    await run([`--out=${join(base, 'b')}`], { config: {} as never, db });
    expect(existsSync(join(base, 'a', 'actions.md'))).toBe(true);
    expect(existsSync(join(base, 'b', 'actions.md'))).toBe(true);
  });
});

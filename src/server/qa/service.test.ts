import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDeps } from '../../../test/helpers.ts';
import type { Capture } from '../../shared/types.ts';
import { createCaptureService } from '../capture/service.ts';
import type { CaptureService } from '../capture/service.ts';
import type { AppDeps } from '../deps.ts';
import { FakeAnswerer } from '../llm/fake.ts';
import type { Answerer, AnswerInput, AnswerOutput } from '../llm/types.ts';
import { LlmError } from '../llm/types.ts';
import { createAction } from '../repos/actions.ts';
import { getCaptureRecord } from '../repos/captures.ts';
import { createNote, softDeleteNote } from '../repos/notes.ts';
import { createPerson } from '../repos/people.ts';
import { purgeDeleted } from '../repos/purge.ts';
import { createQaService, NO_MATCH_ANSWER } from './service.ts';
import type { QaService } from './service.ts';

let deps: AppDeps;
let captures: CaptureService;
let qa: QaService;
let answer: ReturnType<typeof vi.fn<Answerer['answer']>>;
let warnings: string[];

const SECRET_NOTE = 'ZEBRA-secret-budget-text';
function setup(impl?: (i: AnswerInput, s?: AbortSignal) => Promise<AnswerOutput>, opts: { timeoutMs?: number } = {}): void {
  const fake = new FakeAnswerer();
  answer = vi.fn<Answerer['answer']>(impl ?? ((i) => fake.answer(i)));
  deps = makeDeps({ answerer: { answer: (i, s) => answer(i, s) } });
  captures = createCaptureService(deps);
  warnings = [];
  qa = createQaService(deps, { ...opts, warn: (m) => warnings.push(m) });
}
beforeEach(() => setup());

const ask = async (text = '/ask what is the budget status?'): Promise<Capture> => captures.submit(text, 'text');
const list = (): Capture[] => captures.list({ limit: 50 });

describe('createQaService.ask', () => {
  it('answers an asked capture from retrieved excerpts, stores answer and ids-only sources', async () => {
    const anna = createPerson(deps.db, { name: 'Anna Berg' }, deps.now());
    const note = createNote(deps.db, { title: 'Budget plan', bodyMd: `${SECRET_NOTE} for Anna`, personId: anna.id }, deps.now());
    const c = await ask('/ask what is the budget status?');
    expect(c).toMatchObject({ status: 'asked', answer: null, classifiedBy: 'prefix' });
    const res = (await qa.ask(c.id)) as Capture;
    expect(res.status).toBe('answered');
    expect(res.answer).toMatchObject({ redacted: false });
    expect(res.answer!.text).toContain('Budget plan');
    expect(res.answer!.sources).toContainEqual({ kind: 'note', id: note.id, title: 'Budget plan' });
    // What reached the answerer: the cleaned question and capped, ref-labelled excerpts (JSON-able plain data).
    const input = answer.mock.calls[0]![0];
    expect(input.question).toBe('what is the budget status?');
    expect(input.excerpts.map((e) => e.ref)).toContain(`note:${note.id}`);
    // Stored: ids only, never titles; the capture row is the only place the answer lives.
    const rec = getCaptureRecord(deps.db, c.id)!;
    expect(rec.status).toBe('answered');
    const raw = deps.db.prepare('SELECT answer, sources FROM captures WHERE id = ?').get(c.id) as { answer: string; sources: string };
    expect(JSON.parse(raw.sources)).toEqual({ sent: expect.any(Array), cited: expect.any(Array) });
    expect(raw.sources).not.toContain('Budget plan');
    expect(raw.answer).toContain('Found');
    // And the list shows the same.
    expect(list().find((x) => x.id === c.id)!.answer).toEqual(res.answer);
  });

  it('no excerpts: the fixed answer, nothing sent, no answerer call', async () => {
    createNote(deps.db, { bodyMd: 'unrelated stuff' }, deps.now());
    const c = await ask('/ask what is the weather in Paris?');
    const res = (await qa.ask(c.id)) as Capture;
    expect(answer).not.toHaveBeenCalled();
    expect(res.status).toBe('answered');
    expect(res.answer).toEqual({ text: NO_MATCH_ANSWER, sources: [], redacted: false });
    // Same with a question made only of stop words.
    const d = await ask('/ask what is it?');
    expect(((await qa.ask(d.id)) as Capture).answer!.text).toBe(NO_MATCH_ANSWER);
    expect(answer).not.toHaveBeenCalled();
  });

  it('sends only capped excerpts', async () => {
    for (let i = 0; i < 40; i++) createNote(deps.db, { bodyMd: `common ${'filler '.repeat(300)}` }, deps.now());
    const c = await ask('/ask what about common things?');
    await qa.ask(c.id);
    const sent = answer.mock.calls[0]![0].excerpts;
    expect(sent.length).toBeLessThanOrEqual(24);
    expect(sent.every((e) => e.text.length <= 600)).toBe(true);
    expect(sent.reduce((n, e) => n + e.title.length + e.text.length, 0)).toBeLessThanOrEqual(12_000);
  });

  it('caps the question that is searched and sent', async () => {
    createNote(deps.db, { bodyMd: 'budget' }, deps.now());
    const c = await ask(`/ask budget ${'long '.repeat(1000)}`);
    await qa.ask(c.id);
    expect(Array.from(answer.mock.calls[0]![0].question).length).toBeLessThanOrEqual(1000);
  });

  it('keeps only cited refs that were sent, and stores them', async () => {
    setup(async (i) => ({ answer: 'x', cited: [i.excerpts[0]!.ref, 'note:424242', 'person:1'] }));
    const n = createNote(deps.db, { title: 'Budget one', bodyMd: 'budget one' }, deps.now());
    const c = await ask('/ask budget?');
    const res = (await qa.ask(c.id)) as Capture;
    expect(res.answer!.sources).toEqual([{ kind: 'note', id: n.id, title: 'Budget one' }]);
    expect(getCaptureRecord(deps.db, c.id)!.sources!.cited).toEqual([{ kind: 'note', id: n.id }]);
  });

  it('answers 404 / not_asked / no_llm without calling the model', async () => {
    expect(await qa.ask(9999)).toBe('not_found');
    const pending = await captures.submit('hmm ??', 'text');
    expect(pending.status).toBe('pending');
    expect(await qa.ask(pending.id)).toBe('not_asked');
    const filed = await captures.submit('/note hello', 'text');
    expect(await qa.ask(filed.id)).toBe('not_asked');
    createNote(deps.db, { bodyMd: 'budget' }, deps.now());
    const c = await ask('/ask budget?');
    await qa.ask(c.id);
    expect(await qa.ask(c.id)).toBe('not_asked'); // already answered
    expect(answer).toHaveBeenCalledTimes(1);

    const bare = makeDeps({ answerer: null });
    const q2 = createQaService(bare);
    const c2 = await createCaptureService(bare).submit('/ask budget?', 'text');
    expect(await q2.ask(c2.id)).toBe('no_llm');
    expect(getCaptureRecord(bare.db, c2.id)!.status).toBe('asked');
  });

  it('a failing, invalid or hanging answerer leaves the capture asked; logs carry the error class only', async () => {
    createNote(deps.db, { bodyMd: `${SECRET_NOTE} budget` }, deps.now());
    const bad: [string, (i: AnswerInput) => Promise<AnswerOutput>][] = [
      ['LlmError', async () => { throw new LlmError(`upstream said ${SECRET_NOTE}`); }],
      ['invalid output', async () => ({ answer: 7, cited: [] }) as unknown as AnswerOutput],
      ['empty answer', async () => ({ answer: '   ', cited: [] })],
      ['too long', async () => ({ answer: 'a'.repeat(4001), cited: [] })],
      ['null', async () => null as unknown as AnswerOutput],
    ];
    for (const [name, impl] of bad) {
      setup(impl);
      createNote(deps.db, { bodyMd: `${SECRET_NOTE} budget` }, deps.now());
      const c = await ask('/ask what is the budget question?');
      expect(await qa.ask(c.id), name).toBe('failed');
      expect(getCaptureRecord(deps.db, c.id)).toMatchObject({ status: 'asked', answer: null, sources: null });
      expect(warnings.length, name).toBeGreaterThan(0);
      for (const w of warnings) {
        expect(w).not.toContain(SECRET_NOTE);
        expect(w).not.toContain('budget');
        expect(w).toMatch(/^question answering failed: (LlmError|AbortError|TimeoutError|Error)$/);
      }
    }
  });

  it('the deadline ends an answerer that ignores the abort signal', async () => {
    setup(() => new Promise<AnswerOutput>(() => undefined), { timeoutMs: 30 });
    createNote(deps.db, { bodyMd: 'budget' }, deps.now());
    const c = await ask('/ask budget?');
    const t0 = Date.now();
    expect(await qa.ask(c.id)).toBe('failed');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(getCaptureRecord(deps.db, c.id)!.status).toBe('asked');
  });

  it('an aborted request signal stops the call and stores nothing', async () => {
    let seen: AbortSignal | undefined;
    setup((_i, s) => { seen = s; return new Promise<AnswerOutput>(() => undefined); });
    createNote(deps.db, { bodyMd: 'budget' }, deps.now());
    const c = await ask('/ask budget?');
    const ac = new AbortController();
    const p = qa.ask(c.id, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(await p).toBe('failed');
    expect(seen?.aborted).toBe(true);
    expect(getCaptureRecord(deps.db, c.id)!.answer).toBeNull();
  });

  it('an answer that arrives after the question was undone is dropped, not stored', async () => {
    let release!: () => void;
    setup(async () => { await new Promise<void>((r) => { release = r; }); return { answer: 'late', cited: [] }; });
    createNote(deps.db, { bodyMd: 'budget' }, deps.now());
    const c = await ask('/ask budget?');
    const p = qa.ask(c.id);
    await new Promise((r) => setTimeout(r, 5));
    captures.undo(c.id);
    release();
    expect(await p).toBe('not_asked');
    expect(getCaptureRecord(deps.db, c.id)).toMatchObject({ status: 'discarded', answer: null, sources: null });
  });
});

describe('one answer per capture at a time', () => {
  it('a second ask for a capture that is being answered is busy and never reaches the model; the first still lands', async () => {
    let release!: () => void;
    setup(async () => { await new Promise<void>((r) => { release = r; }); return { answer: 'done', cited: [] }; });
    createNote(deps.db, { bodyMd: 'budget' }, deps.now());
    const c = await ask('/ask budget?');
    const first = qa.ask(c.id);
    await new Promise((r) => setTimeout(r, 5));
    expect(await qa.ask(c.id)).toBe('busy');
    expect(answer).toHaveBeenCalledTimes(1);
    release();
    expect(((await first) as Capture).status).toBe('answered');
    expect(await qa.ask(c.id)).toBe('not_asked'); // the entry was freed
  });

  it('the entry is freed after a failure, so a retry is accepted', async () => {
    let fail = true;
    setup(async () => { if (fail) throw new LlmError('x'); return { answer: 'ok', cited: [] }; });
    createNote(deps.db, { bodyMd: 'budget' }, deps.now());
    const c = await ask('/ask budget?');
    expect(await qa.ask(c.id)).toBe('failed');
    fail = false;
    expect(((await qa.ask(c.id)) as Capture).status).toBe('answered');
  });
});

describe('answers and deletion', () => {
  async function answered(): Promise<{ c: Capture; cited: number; uncited: number }> {
    // The fake cites the first two excerpts; three notes match, so one used note is NOT cited.
    const ids = [1, 2, 3].map((i) => createNote(deps.db, { title: `Zeta ${i}`, bodyMd: `zeta ${SECRET_NOTE} ${i}` }, new Date(deps.now().getTime() + i * 1000)).id);
    const c = await ask('/ask what about zeta?');
    const res = (await qa.ask(c.id)) as Capture;
    const citedIds = res.answer!.sources.map((s) => s.id);
    expect(citedIds).toHaveLength(2);
    return { c: res, cited: citedIds[0]!, uncited: ids.find((i) => !citedIds.includes(i))! };
  }

  it('deleting a cited OR an uncited sent item blanks the answer on the next read', async () => {
    for (const which of ['cited', 'uncited'] as const) {
      setup();
      const { c, cited, uncited } = await answered();
      expect(list().find((x) => x.id === c.id)!.answer!.text).toContain('Found 3');
      softDeleteNote(deps.db, which === 'cited' ? cited : uncited, deps.now());
      const after = list().find((x) => x.id === c.id)!;
      expect(after.answer).toEqual({ text: '', sources: [], redacted: true });
      expect(after.status).toBe('answered');
      expect(JSON.stringify(after)).not.toContain(SECRET_NOTE);
      expect(JSON.stringify(after.answer)).not.toContain('Zeta');
    }
  });

  it('redacts when a sent action, agenda item or project is deleted or the row is gone', async () => {
    const anna = createPerson(deps.db, { name: 'Anna' }, deps.now());
    const action = createAction(deps.db, { text: 'yankee task', personId: anna.id }, deps.now());
    createNote(deps.db, { bodyMd: 'yankee note' }, deps.now());
    const c = await ask('/ask what about yankee?');
    const res = (await qa.ask(c.id)) as Capture;
    expect(res.answer!.redacted).toBe(false);
    deps.db.prepare('UPDATE actions SET deleted_at = ? WHERE id = ?').run(deps.now().toISOString(), action.id);
    expect(list().find((x) => x.id === c.id)!.answer!.redacted).toBe(true);
    deps.db.prepare('DELETE FROM actions WHERE id = ?').run(action.id); // a gone row counts the same
    expect(list().find((x) => x.id === c.id)!.answer).toEqual({ text: '', sources: [], redacted: true });
  });

  it('one damaged entry in sent (or cited) blanks the whole answer, even when every other entry is alive', async () => {
    const { c } = await answered();
    const alive = (deps.db.prepare('SELECT sources FROM captures WHERE id = ?').get(c.id) as { sources: string }).sources;
    const good = JSON.parse(alive) as { sent: unknown[]; cited: unknown[] };
    expect(list().find((x) => x.id === c.id)!.answer!.redacted).toBe(false);
    for (const [name, sources] of [
      ['sent entry with a bad kind', { ...good, sent: [...good.sent, { kind: 'toString', id: 1 }] }],
      ['sent entry with a bad id', { ...good, sent: [...good.sent, { kind: 'note', id: 'x' }] }],
      ['sent entry that is not an object', { ...good, sent: [...good.sent, 7] }],
      ['cited entry damaged', { ...good, cited: [...good.cited, null] }],
      ['sent is not a list', { ...good, sent: 'x' }],
    ] as const) {
      deps.db.prepare('UPDATE captures SET sources = ? WHERE id = ?').run(JSON.stringify(sources), c.id);
      expect(list().find((x) => x.id === c.id)!.answer, name).toEqual({ text: '', sources: [], redacted: true });
    }
  });

  it('a damaged stored answer is blanked (fail closed)', async () => {
    const { c } = await answered();
    deps.db.prepare("UPDATE captures SET sources = 'not json' WHERE id = ?").run(c.id);
    expect(list().find((x) => x.id === c.id)!.answer).toEqual({ text: '', sources: [], redacted: true });
  });

  it('purge erases an answered capture when a sent item is purged, and no table keeps the text', async () => {
    const { c, uncited } = await answered();
    const t = deps.now();
    softDeleteNote(deps.db, uncited, t);
    const later = new Date(t.getTime() + 31 * 86_400_000);
    const scan = (): string => {
      const out: string[] = [];
      for (const { name } of deps.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
        out.push(JSON.stringify(deps.db.prepare(`SELECT * FROM ${name}`).all()));
      }
      return out.join('\n');
    };
    expect(scan()).toContain(SECRET_NOTE); // the text is really in the database before the purge
    expect(scan()).toContain('Found 3 item(s)');
    expect(purgeDeleted(deps.db, later).captures).toBeGreaterThanOrEqual(1);
    expect(getCaptureRecord(deps.db, c.id)).toBeNull();
    // The two other notes still hold their text; the purged capture's answer text is gone from every table.
    expect(scan()).not.toContain('Found 3 item(s)');
    expect(scan()).not.toContain(`Zeta ${uncited}`);
  });

  it('an unrelated answered capture survives the purge', async () => {
    const { c } = await answered();
    softDeleteNote(deps.db, createNote(deps.db, { bodyMd: 'other' }, deps.now()).id, deps.now());
    purgeDeleted(deps.db, new Date(deps.now().getTime() + 31 * 86_400_000));
    expect(getCaptureRecord(deps.db, c.id)!.answer).not.toBeNull();
  });
});

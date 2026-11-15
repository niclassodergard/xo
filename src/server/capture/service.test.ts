import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDeps } from '../../../test/helpers.ts';
import type { AppDeps } from '../deps.ts';
import { FakeClassifier } from '../llm/fake.ts';
import type { Classifier, ClassifyInput, ClassifyOutput } from '../llm/types.ts';
import { LlmError } from '../llm/types.ts';
import { createAgendaItem, getAgendaItem } from '../repos/agenda.ts';
import { emptyDraft, insertCapture } from '../repos/captures.ts';
import { LIMITS } from '../../shared/api.ts';
import { createNote, getNote } from '../repos/notes.ts';
import { createProject, getProject, listProjects, softDeleteProject } from '../repos/projects.ts';
import { listActions } from '../repos/actions.ts';
import { listNotes } from '../repos/notes.ts';
import { purgeDeleted } from '../repos/purge.ts';
import { createPerson, getPerson, getPersonDetail, listPeople } from '../repos/people.ts';
import { createCaptureService } from './service.ts';
import type { CaptureService } from './service.ts';
import type { Capture } from '../../shared/types.ts';

let deps: AppDeps;
let svc: CaptureService;
let classify: ReturnType<typeof vi.fn<Classifier['classify']>>;

function counts(): { notes: number; actions: number; agenda: number } {
  const n = (t: string): number => (deps.db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number }).c;
  return { notes: n('notes'), actions: n('actions'), agenda: n('agenda_items') };
}
const NOTHING = { notes: 0, actions: 0, agenda: 0 };
const person = (name: string, aliases: string[] = []) => createPerson(deps.db, { name, aliases }, deps.now());

function setup(classifier: Classifier | null = new FakeClassifier(), opts: Parameters<typeof createCaptureService>[1] = {}): void {
  const fake = new FakeClassifier();
  classify = vi.fn<Classifier['classify']>((input) => fake.classify(input));
  const spy: Classifier | null = classifier === null ? null : { classify: (i, s) => (classifier instanceof FakeClassifier ? classify(i, s) : classifier.classify(i, s)) };
  deps = makeDeps({ classifier: spy });
  svc = createCaptureService(deps, opts);
}
beforeEach(() => setup());

describe('prefix captures (no LLM)', () => {
  it('/todo files an action for me without calling the classifier', async () => {
    const c = await svc.submit('/todo call the bank', 'text');
    expect(c.status).toBe('filed');
    expect(c.classifiedBy).toBe('prefix');
    expect(c.summary).toBe('Action (me): call the bank');
    expect(c.filed).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
    expect(listActions(deps.db)[0]).toMatchObject({ text: 'call the bank', owner: 'me', personId: null });
  });

  it('/wait @anna files an action owned by them linked to Anna', async () => {
    const anna = person('Anna Berg');
    const c = await svc.submit('/wait @anna budget numbers', 'text');
    expect(c.status).toBe('filed');
    expect(c.draft).toMatchObject({ kind: 'action', owner: 'them', personId: anna.id });
    expect(c.summary).toBe('Action (them) · Anna Berg: anna budget numbers');
    expect(listActions(deps.db)[0]).toMatchObject({ owner: 'them', personId: anna.id });
  });

  it('/agenda @anna files an agenda item for Anna', async () => {
    const anna = person('Anna');
    const c = await svc.submit('/agenda @anna hiring plan', 'text');
    expect(c.status).toBe('filed');
    expect(getPersonDetail(deps.db, anna.id)!.openAgenda).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it('/note files a note', async () => {
    await svc.submit('/note remember the milk', 'voice');
    expect(listNotes(deps.db)[0]!.bodyMd).toBe('remember the milk');
  });

  it('rejects text that is empty after parsing', async () => {
    await expect(svc.submit('/todo   ', 'text')).rejects.toMatchObject({ status: 400 });
    await expect(svc.submit('   ', 'text')).rejects.toMatchObject({ status: 400 });
    expect(counts()).toEqual(NOTHING);
  });
});

describe('LLM classification', () => {
  it('a confident result is filed with classifiedBy llm and a summary', async () => {
    const c = await svc.submit('todo: send the budget', 'text');
    expect(c).toMatchObject({ status: 'filed', classifiedBy: 'llm', question: null });
    expect(c.summary).toBe('Action (me): todo: send the budget');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(counts().actions).toBe(1);
  });

  it('sends capped, trimmed people to the classifier and the parsed text', async () => {
    for (let i = 0; i < 250; i++) person(`P${i}`, Array.from({ length: 20 }, (_, j) => `${'x'.repeat(300)}${j}`));
    await svc.submit('hello world', 'text');
    const input = classify.mock.calls[0]![0] as ClassifyInput;
    expect(input.people).toHaveLength(200);
    expect(input.people[0]!.aliases).toHaveLength(10);
    expect(input.people[0]!.aliases[0]!.length).toBe(100);
    expect(input.text).toBe('hello world');
  });

  it('low confidence asks for the kind and writes nothing', async () => {
    const c = await svc.submit('what is this ??', 'text');
    expect(c.status).toBe('pending');
    expect(c.question?.type).toBe('kind');
    expect(c.filed).toEqual([]);
    expect(counts()).toEqual(NOTHING);
  });

  it('a throwing classifier asks for the kind', async () => {
    const c = await svc.submit('this will !!fail', 'text');
    expect(c).toMatchObject({ status: 'pending', question: { type: 'kind' } });
    expect(counts()).toEqual(NOTHING);
  });

  it('no classifier (no API key) asks for the kind', async () => {
    setup(null);
    const c = await svc.submit('plain thought', 'text');
    expect(c).toMatchObject({ status: 'pending', question: { type: 'kind' } });
    expect(counts()).toEqual(NOTHING);
  });

  it.each([
    ['unknown kind', { kind: 'journal', confidence: 0.99, personName: null, owner: 'me' }],
    ['string confidence', { kind: 'note', confidence: '0.99', personName: null, owner: 'me' }],
    ['confidence above 1', { kind: 'note', confidence: 7, personName: null, owner: 'me' }],
    ['NaN confidence', { kind: 'note', confidence: NaN, personName: null, owner: 'me' }],
    ['bad owner', { kind: 'note', confidence: 0.99, personName: null, owner: 'x' }],
    ['non-string name', { kind: 'note', confidence: 0.99, personName: 5, owner: 'me' }],
    ['null output', null],
  ])('invalid classifier output (%s) asks instead of filing', async (_n, out) => {
    setup({ classify: async () => out as unknown as ClassifyOutput });
    const c = await svc.submit('some text', 'text');
    expect(c).toMatchObject({ status: 'pending', question: { type: 'kind' } });
    expect(counts()).toEqual(NOTHING);
  });

  it('a hanging classifier times out into a question', async () => {
    const warn = vi.fn();
    setup({ classify: () => new Promise<ClassifyOutput>(() => {}) }, { classifyTimeoutMs: 20, warn });
    const c = await svc.submit('stuck', 'text');
    expect(c.question?.type).toBe('kind');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warnings never contain capture text', async () => {
    const warn = vi.fn();
    setup({ classify: async () => { throw new LlmError('secret-text-in-message'); } }, { warn });
    await svc.submit('my private thought', 'text');
    expect(warn).toHaveBeenCalledWith('capture classifier failed: LlmError');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });

  it('warnings only ever name allowlisted error classes', async () => {
    const warn = vi.fn();
    class SecretError extends Error { override name = 'JaneDoe'; }
    setup({ classify: async () => { throw new SecretError('x'); } }, { warn });
    await svc.submit('t', 'text');
    expect(warn).toHaveBeenCalledWith('capture classifier failed: Error');
  });

  it('answering the kind question files with classifiedBy user', async () => {
    const c = await svc.submit('what ??', 'text');
    const done = (await svc.answer(c.id, { key: 't' })) as Capture;
    expect(done).toMatchObject({ status: 'filed', classifiedBy: 'user', question: null });
    expect(counts().actions).toBe(1);
  });
});

describe('people', () => {
  it('a known name in free text links automatically', async () => {
    const anna = person('Anna');
    const c = await svc.submit('lunch with Anna tomorrow', 'text');
    expect(c).toMatchObject({ status: 'filed', draft: { personId: anna.id } });
    expect(listNotes(deps.db)[0]!.personId).toBe(anna.id);
  });

  it('links by alias and non-ASCII name', async () => {
    const asa = person('Åsa', ['Åse']);
    const c = await svc.submit('/todo ring Åsa', 'text');
    expect(c.draft.personId).toBe(asa.id);
  });

  it('unknown @bob asks; c creates the person and files', async () => {
    const c = await svc.submit('/todo @bob send contract', 'text');
    expect(c).toMatchObject({ status: 'pending', question: { type: 'unknown_person', name: 'bob' } });
    expect(counts()).toEqual(NOTHING);
    expect(listPeople(deps.db)).toHaveLength(0);
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(done.status).toBe('filed');
    const bob = listPeople(deps.db)[0]!;
    expect(bob.name).toBe('bob');
    expect(done.filed).toEqual([{ kind: 'action', id: expect.any(Number) }, { kind: 'person', id: bob.id }]);
    expect(listActions(deps.db)[0]!.personId).toBe(bob.id);
  });

  it('c on two pending captures for the same new name creates one person', async () => {
    const c1 = await svc.submit('/todo @lisa one', 'text');
    const c2 = await svc.submit('/todo @lisa two', 'text');
    const d1 = (await svc.answer(c1.id, { key: 'c' })) as Capture;
    const d2 = (await svc.answer(c2.id, { key: 'c' })) as Capture;
    expect(listPeople(deps.db)).toHaveLength(1);
    expect(d1.filed).toHaveLength(2);
    expect(d2).toMatchObject({ status: 'filed', draft: { personId: d1.draft.personId } });
    expect(d2.filed).toEqual([{ kind: 'action', id: expect.any(Number) }]);
  });

  it('c creates a new person when only a similar name exists now', async () => {
    const c = await svc.submit('/todo @lisa one', 'text');
    const berg = person('Lisa Berg');
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(done.status).toBe('filed');
    expect(done.draft.personId).not.toBe(berg.id);
    expect(listPeople(deps.db).map((p) => p.name).sort()).toEqual(['Lisa Berg', 'lisa']);
  });

  it('c links an exact alias match instead of creating', async () => {
    const c = await svc.submit('/todo @lisa one', 'text');
    const l = person('Elisabet', ['LISA']);
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(done.draft.personId).toBe(l.id);
    expect(listPeople(deps.db)).toHaveLength(1);
  });

  it('c when two people now match exactly asks which instead of creating', async () => {
    const c = await svc.submit('/todo @lisa one', 'text');
    person('Lisa A', ['Lisa']);
    person('Lisa B', ['lisa']);
    const next = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(next).toMatchObject({ status: 'pending', question: { type: 'ambiguous_person' } });
    expect(listPeople(deps.db)).toHaveLength(2);
  });

  it('s files without a person', async () => {
    const c = await svc.submit('/todo @bob send contract', 'text');
    const done = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(done.status).toBe('filed');
    expect(listActions(deps.db)[0]!.personId).toBeNull();
    expect(listPeople(deps.db)).toHaveLength(0);
  });

  it('p then { personId } links an existing person', async () => {
    const carl = person('Carl');
    const c = await svc.submit('/todo @bob send contract', 'text');
    expect(await svc.answer(c.id, { key: 'p' })).toBe('bad_answer'); // the client opens its picker instead
    const done = (await svc.answer(c.id, { personId: carl.id })) as Capture;
    expect(done.status).toBe('filed');
    expect(listActions(deps.db)[0]!.personId).toBe(carl.id);
  });

  it('two matching people ask which; a candidate key links', async () => {
    const a = person('Anna Berg');
    const b = person('Anna Lund');
    const c = await svc.submit('/todo @anna call back', 'text');
    expect(c.question).toMatchObject({ type: 'ambiguous_person', name: 'anna' });
    const q = c.question as Extract<NonNullable<Capture['question']>, { type: 'ambiguous_person' }>;
    expect(q.candidates.map((x) => x.personId).sort()).toEqual([a.id, b.id].sort());
    const done = (await svc.answer(c.id, { key: q.candidates[1]!.key })) as Capture;
    expect(done.status).toBe('filed');
    expect(done.draft.personId).toBe(q.candidates[1]!.personId);
  });

  it('two people named in free text ask, with a skip option', async () => {
    person('Anna');
    person('Bo');
    const c = await svc.submit('/note meeting with Anna and Bo', 'text');
    expect(c.question?.type).toBe('ambiguous_person');
    expect(c.question!.options.map((o) => o.key)).toEqual(['s', 'd']);
    expect(await svc.answer(c.id, { key: '9' })).toBe('bad_answer');
    const done = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(done.status).toBe('filed');
    expect(done.draft.personId).toBeNull();
  });

  it('agenda without a person asks needs_person (no skip)', async () => {
    const c = await svc.submit('/agenda hiring plan', 'text');
    expect(c.question).toMatchObject({ type: 'needs_person' });
    expect(await svc.answer(c.id, { key: 's' })).toBe('bad_answer');
    expect(listNotes(deps.db)).toHaveLength(0); // the reclassified original stays deleted
    const anna = person('Anna');
    const done = (await svc.answer(c.id, { personId: anna.id })) as Capture;
    expect(done.status).toBe('filed');
    expect(getPersonDetail(deps.db, anna.id)!.openAgenda).toHaveLength(1);
  });

  it('agenda with an unknown person has no skip option', async () => {
    const c = await svc.submit('/agenda @bob hiring', 'text');
    expect(c.question!.options.map((o) => o.key)).toEqual(['c', 'p', 'd']);
    expect(await svc.answer(c.id, { key: 's' })).toBe('bad_answer');
  });

  it('an LLM-derived unknown name asks before creating a person', async () => {
    const c = await svc.submit('catch up with Zelda about hiring', 'text');
    expect(c).toMatchObject({ status: 'pending', question: { type: 'unknown_person', name: 'Zelda' } });
    expect(listPeople(deps.db)).toHaveLength(0);
    expect(counts()).toEqual(NOTHING);
  });

  const llmNamed = (name: string): Classifier => ({ classify: async () => ({ kind: 'note', confidence: 0.99, personName: name, projectName: null, owner: 'me' }) });

  it('an LLM-suggested person is only a suggestion: asked, never auto-linked', async () => {
    setup(llmNamed('zelda'));
    const z = person('Zelda Fitz');
    const c = await svc.submit('xyz', 'text');
    expect(c.status).toBe('pending');
    expect(c.classifiedBy).toBe('llm');
    const q = c.question as Extract<NonNullable<Capture['question']>, { type: 'ambiguous_person' }>;
    expect(q.type).toBe('ambiguous_person');
    expect(q.candidates).toEqual([{ key: '1', personId: z.id, name: 'Zelda Fitz' }]);
    expect(q.options.map((o) => o.key)).toEqual(['s', 'd']);
    expect(counts()).toEqual(NOTHING);
    const done = (await svc.answer(c.id, { key: '1' })) as Capture;
    expect(done).toMatchObject({ status: 'filed', draft: { personId: z.id } });
  });

  it('probe: "bring up the reorg" with LLM name "Anna Berg" asks', async () => {
    setup(llmNamed('Anna Berg'));
    person('Anna Berg');
    const c = await svc.submit('bring up the reorg', 'text');
    expect(c).toMatchObject({ status: 'pending', question: { type: 'ambiguous_person' } });
  });

  it('probe: "i will call the bank" with LLM name "will" does not link', async () => {
    setup(llmNamed('will'));
    person('Will');
    const c = await svc.submit('i will call the bank', 'text');
    expect(c.status).toBe('pending');
    expect(c.draft.personId).toBeNull();
    const skipped = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(skipped).toMatchObject({ status: 'filed', draft: { personId: null } });
  });

  it('an LLM name matching several people asks which', async () => {
    setup(llmNamed('zelda'));
    person('Zelda Fitz');
    person('Zelda Berg');
    const c = await svc.submit('xyz', 'text');
    expect(c.question?.type).toBe('ambiguous_person');
  });

  it('an over-long or control-character LLM name is ignored', async () => {
    setup(llmNamed('x'.repeat(201)));
    expect((await svc.submit('xyz', 'text')).status).toBe('filed');
    setup(llmNamed('Bo\u0000b'));
    expect((await svc.submit('xyz', 'text')).status).toBe('filed');
    expect(listPeople(deps.db)).toHaveLength(0);
  });

  it('LLM names are ignored when confidence is low', async () => {
    const c = await svc.submit('what with Zelda ??', 'text');
    expect(c.question?.type).toBe('kind');
    expect(c.draft.personName).toBeNull();
  });

  it('asks the kind first, then the person', async () => {
    const c = await svc.submit('?? @bob thing', 'text');
    expect(c.question?.type).toBe('kind');
    const next = (await svc.answer(c.id, { key: 'n' })) as Capture;
    expect(next).toMatchObject({ status: 'pending', question: { type: 'unknown_person' } });
    expect(counts()).toEqual(NOTHING);
  });

  it('ignores archived people', async () => {
    const a = person('Anna');
    deps.db.prepare('UPDATE people SET archived_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', a.id);
    const c = await svc.submit('/todo @anna x', 'text');
    expect(c.question?.type).toBe('unknown_person');
    expect(await svc.answer(c.id, { personId: a.id })).toBe('bad_answer');
  });
});

describe('damaged stored question', () => {
  it.each([
    ['options not an array', '{"type":"kind","options":"x"}'],
    ['bad option entries', '{"type":"kind","options":[1]}'],
    ['unknown type', '{"type":"zzz","options":[]}'],
    ['unknown_person without name', '{"type":"unknown_person","options":[]}'],
    ['ambiguous without candidates', '{"type":"ambiguous_person","name":"x","options":[]}'],
    ['ambiguous with bad candidates', '{"type":"ambiguous_person","name":"x","options":[],"candidates":[{"key":1}]}'],
  ])('%s: the question is re-derived', async (_n, json) => {
    const c = await svc.submit('what ??', 'text');
    deps.db.prepare('UPDATE captures SET question = ? WHERE id = ?').run(json, c.id);
    const done = (await svc.answer(c.id, { key: 'n' })) as Capture;
    expect(done.status).toBe('filed');
  });
});

describe('answers', () => {
  it('d discards without filing', async () => {
    const c = await svc.submit('what ??', 'text');
    const done = (await svc.answer(c.id, { key: 'd' })) as Capture;
    expect(done).toMatchObject({ status: 'discarded', question: null, filed: [] });
    expect(counts()).toEqual(NOTHING);
  });

  it('rejects answers to non-pending captures, unknown ids, bad keys and personId for the kind question', async () => {
    const filed = await svc.submit('/todo x', 'text');
    expect(await svc.answer(filed.id, { key: 'n' })).toBe('not_pending');
    expect(await svc.answer(9999, { key: 'n' })).toBe('not_found');
    const q = await svc.submit('what ??', 'text');
    expect(await svc.answer(q.id, { key: 'z' })).toBe('bad_answer');
    expect(await svc.answer(q.id, { key: 'c' })).toBe('bad_answer');
    const p = person('Anna');
    expect(await svc.answer(q.id, { personId: p.id })).toBe('bad_answer');
    expect(await svc.answer(q.id, { personId: 424242 })).toBe('bad_answer');
    expect(getPerson(deps.db, p.id)).not.toBeNull();
    expect((await svc.answer(q.id, { key: 'N' })) as Capture).toMatchObject({ status: 'filed' });
  });
});

describe('undo and reclassify', () => {
  it.each(['undo', 'reclassify'] as const)('%s never touches an agenda item or project sharing a ref id with a project ref', (op) => {
    const p = person('Anna');
    const project = createProject(deps.db, { title: 'Apollo' }, deps.now());
    const agenda = createAgendaItem(deps.db, { personId: p.id, text: 'unrelated' }, deps.now());
    const note = createNote(deps.db, { bodyMd: 'filed note', projectId: project.id }, deps.now());
    expect(agenda.id).toBe(project.id); // same numeric id on purpose
    const cap = insertCapture(deps.db, {
      text: 'filed note', source: 'text', status: 'filed', draft: { ...emptyDraft(), kind: 'note', text: 'filed note', projectId: project.id },
      question: null, filed: [{ kind: 'note', id: note.id }, { kind: 'project', id: project.id }], summary: 'Note', classifiedBy: 'prefix',
    }, deps.now());
    expect(typeof svc[op](cap.id)).toBe('object');
    expect(getNote(deps.db, note.id)).toBeNull();
    expect(getAgendaItem(deps.db, agenda.id)).not.toBeNull();
    expect(getProject(deps.db, project.id)).not.toBeNull();
  });

  it('undo soft-deletes the item, keeps a created person, and a second undo is not_filed', async () => {
    const c = await svc.submit('/todo @bob call', 'text');
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    const undone = svc.undo(done.id) as Capture;
    expect(undone).toMatchObject({ status: 'undone', deleted: true, text: '', summary: '(deleted)' });
        expect(listActions(deps.db, { status: 'all' })).toHaveLength(0);
    expect(listPeople(deps.db)).toHaveLength(1);
    expect(svc.undo(done.id)).toBe('not_filed');
    expect(svc.undo(777)).toBe('not_found');
  });

  it('undo and reclassify of a capture whose item was deleted elsewhere answer gone, without text, and change nothing', async () => {
    const c = await svc.submit('/note very private', 'text');
    deps.db.prepare('UPDATE notes SET deleted_at = ?').run(deps.now().toISOString());
    expect(svc.undo(c.id)).toBe('gone');
    expect(svc.reclassify(c.id)).toBe('gone');
    const row = deps.db.prepare('SELECT status, filed FROM captures WHERE id = ?').get(c.id) as { status: string; filed: string };
    expect(row.status).toBe('filed');
    expect(JSON.parse(row.filed)).toHaveLength(1);
    expect(svc.list({ limit: 5 })[0]).toMatchObject({ deleted: true, text: '' });
  });

  it('a capture whose item was deleted elsewhere is removed by the purge after 30 days', async () => {
    const c = await svc.submit('/note very private', 'text');
    deps.db.prepare('UPDATE notes SET deleted_at = ?').run(deps.now().toISOString());
    expect(svc.undo(c.id)).toBe('gone');
    purgeDeleted(deps.db, new Date(deps.now().getTime() + 31 * 86_400_000));
    expect(deps.db.prepare('SELECT count(*) AS n FROM captures').get()).toEqual({ n: 0 });
  });

  it('reclassify resets the owner to me', async () => {
    const c = await svc.submit('/wait ring Bo', 'text');
    expect(c.draft.owner).toBe('them');
    expect((svc.reclassify(c.id) as Capture).draft.owner).toBe('me');
    const again = (await svc.answer(c.id, { key: 't' })) as Capture;
    expect(listActions(deps.db)[0]!.owner).toBe('me');
    expect(again.status).toBe('filed');
  });

  it('reclassify after the linked person was archived asks about the person instead of filing', async () => {
    const anna = person('Anna');
    const c = await svc.submit('/note chat with Anna', 'text');
    expect(c.draft.personId).toBe(anna.id);
    svc.reclassify(c.id);
    deps.db.prepare('UPDATE people SET archived_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', anna.id);
    const next = (await svc.answer(c.id, { key: 'n' })) as Capture;
    expect(next).toMatchObject({ status: 'pending', filed: [], draft: { personId: null }, question: { type: 'unknown_person', name: 'Anna' } });
    expect(listNotes(deps.db)).toHaveLength(0); // the reclassified original stays deleted
  });

  it('an archived person is never silently replaced by a similar live one', async () => {
    const anna = person('Anna');
    const berg = person('Anna Berg');
    const c = await svc.submit('/note chat with Anna', 'text');
    expect(c.draft.personId).toBe(anna.id);
    svc.reclassify(c.id);
    deps.db.prepare('UPDATE people SET archived_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', anna.id);
    const next = (await svc.answer(c.id, { key: 'n' })) as Capture;
    expect(next).toMatchObject({ status: 'pending', draft: { personId: null } });
    const q = next.question as Extract<NonNullable<Capture['question']>, { type: 'ambiguous_person' }>;
    expect(q.type).toBe('ambiguous_person');
    expect(q.candidates.map((x) => x.personId)).toEqual([berg.id]);
    expect(q.options.map((o) => o.key)).toEqual(['s', 'd']);
    expect(listNotes(deps.db)).toHaveLength(0);
    const skipped = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(skipped).toMatchObject({ status: 'filed', draft: { personId: null } });
  });

  it('reclassify to agenda after the person was archived asks needs_person', async () => {
    const anna = person('Anna');
    const c = await svc.submit('/note chat with Anna', 'text');
    svc.reclassify(c.id);
    deps.db.prepare('UPDATE people SET archived_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', anna.id);
    const next = (await svc.answer(c.id, { key: 'a' })) as Capture;
    expect(next).toMatchObject({ status: 'pending', question: { type: 'needs_person' } });
    expect(listNotes(deps.db)).toHaveLength(0);
  });

  it('reclassify deletes the old item and goes back to a kind question, keeping the person', async () => {
    const anna = person('Anna');
    const c = await svc.submit('/todo ring Anna', 'text');
    const re = svc.reclassify(c.id) as Capture;
    expect(re).toMatchObject({ status: 'pending', question: { type: 'kind' }, filed: [], draft: { kind: null, personId: anna.id }, classifiedBy: null });
    expect(listActions(deps.db, { status: 'all' })).toHaveLength(0);
    expect(svc.reclassify(c.id)).toBe('not_filed');
    const again = (await svc.answer(c.id, { key: 'n' })) as Capture;
    // filed holds only the new filing, never the old refs.
    expect(again.filed).toEqual([{ kind: 'note', id: expect.any(Number) }]);
    expect(again).toMatchObject({ status: 'filed', classifiedBy: 'user' });
    expect(listNotes(deps.db)[0]!.personId).toBe(anna.id);
  });

  it('reclassify after a created person keeps the link and drops the person ref from filed', async () => {
    const c = await svc.submit('/todo @bob call', 'text');
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    svc.reclassify(done.id);
    const again = (await svc.answer(c.id, { key: 'n' })) as Capture;
    expect(again.filed).toHaveLength(1);
    expect(again.draft.personId).toBe(listPeople(deps.db)[0]!.id);
    expect(listPeople(deps.db)).toHaveLength(1);
  });

  it('reclassify to agenda on a capture without a person asks for one', async () => {
    const c = await svc.submit('/note plain', 'text');
    svc.reclassify(c.id);
    const next = (await svc.answer(c.id, { key: 'a' })) as Capture;
    expect(next.question?.type).toBe('needs_person');
  });
});

describe('atomic filing', () => {
  const boom = (): void => {
    deps.db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON captures WHEN NEW.status = 'filed'
      BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  };

  it('a failure while answering rolls back the item and the created person', async () => {
    const c = await svc.submit('/todo @bob call', 'text');
    boom();
    await expect(svc.answer(c.id, { key: 'c' })).rejects.toThrow();
    expect(counts()).toEqual(NOTHING);
    expect(listPeople(deps.db)).toHaveLength(0);
    expect(svc.list({ limit: 10 })[0]).toMatchObject({ status: 'pending', question: { type: 'unknown_person' } });
  });

  it('a failure while submitting leaves no item and no capture', async () => {
    deps.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON captures WHEN NEW.status = 'filed'
      BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    await expect(svc.submit('/todo x', 'text')).rejects.toThrow();
    expect(counts()).toEqual(NOTHING);
    expect(svc.list({ limit: 10 })).toEqual([]);
  });

  it('a failing undo rolls back', async () => {
    const c = await svc.submit('/todo x', 'text');
    deps.db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON captures WHEN NEW.status = 'undone'
      BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() => svc.undo(c.id)).toThrow();
    expect(listActions(deps.db)).toHaveLength(1);
  });
});

describe('list', () => {
  it('re-derives a damaged question of a pending capture', async () => {
    const c = await svc.submit('what ??', 'text');
    deps.db.prepare("UPDATE captures SET question = '{\"type\":\"kind\",\"options\":5}' WHERE id = ?").run(c.id);
    expect(svc.list({ limit: 5 })[0]!.question).toMatchObject({ type: 'kind' });
  });

  it('pages newest-first by cursor, oldest first within a page', async () => {
    for (let i = 1; i <= 5; i++) await svc.submit(`/note n${i}`, 'text');
    const page1 = svc.list({ limit: 2 });
    expect(page1.map((c) => c.text)).toEqual(['/note n4', '/note n5']);
    const page2 = svc.list({ limit: 2, before: page1[0]!.id });
    expect(page2.map((c) => c.text)).toEqual(['/note n2', '/note n3']);
    expect(svc.list({ limit: 10, before: page2[0]!.id })).toHaveLength(1);
  });

  it('hides text, draft and summary once every filed item is deleted', async () => {
    const keep = await svc.submit('/note secret keep', 'text');
    const gone = await svc.submit('/note secret gone', 'text');
    const undone = await svc.submit('/todo secret undone', 'text');
    svc.undo(undone.id);
    deps.db.prepare("UPDATE notes SET deleted_at = ? WHERE body_md = 'secret gone'").run('2026-01-01T00:00:00.000Z');
    const list = svc.list({ limit: 10 });
    expect(list.find((c) => c.id === keep.id)).toMatchObject({ text: '/note secret keep', deleted: false });
    for (const id of [gone.id, undone.id]) {
      const c = list.find((x) => x.id === id)!;
      expect(c).toMatchObject({ text: '', summary: '(deleted)', filed: [], question: null, deleted: true });
      expect(c.draft.text).toBe('');
    }
    expect(JSON.stringify(list.filter((c) => c.id !== keep.id))).not.toContain('secret');
  });

  it('keeps a capture visible while one of its items is alive, and shows pending and discarded ones', async () => {
    const pending = await svc.submit('why ??', 'text');
    const disc = await svc.submit('drop ??', 'text');
    await svc.answer(disc.id, { key: 'd' });
    const list = svc.list({ limit: 10 });
    expect(list.map((c) => c.text)).toEqual(['why ??', 'drop ??']);
    expect(pending.status).toBe('pending');
  });

  it('survives a damaged row', async () => {
    const c = await svc.submit('/note ok', 'text');
    deps.db.prepare("UPDATE captures SET draft = 'not json', question = '{', filed = '{\"x\":1}' WHERE id = ?").run(c.id);
    expect(() => svc.list({ limit: 10 })).not.toThrow();
    // No usable item refs at all: redacted rather than shown.
    expect(svc.list({ limit: 10 })[0]).toMatchObject({ deleted: true, text: '' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Projects (plan 4.6 / 4.7)

const project = (title: string, aliases: string[] = [], status: 'active' | 'on_hold' | 'done' = 'active') =>
  createProject(deps.db, { title, aliases, status }, deps.now());
const rawCaptures = (): string => JSON.stringify(deps.db.prepare('SELECT text, draft, question, filed, summary FROM captures').all());
const llmProject = (name: string | null, extra: Partial<ClassifyOutput> = {}): Classifier => ({
  classify: async () => ({ kind: 'note', confidence: 0.99, personName: null, projectName: name, owner: 'me', ...extra }),
});
const projectCount = (): number => (deps.db.prepare('SELECT count(*) AS c FROM projects').get() as { c: number }).c;

describe('projects: explicit #mention', () => {
  it('/todo #alias files an action with the project, without calling the classifier', async () => {
    const p = project('Apollo Launch', ['apollo']);
    const c = await svc.submit('/todo #apollo fix slides', 'text');
    expect(c).toMatchObject({ status: 'filed', classifiedBy: 'prefix', question: null, draft: { projectId: p.id, text: 'apollo fix slides' } });
    expect(classify).not.toHaveBeenCalled();
    expect(listActions(deps.db)[0]).toMatchObject({ text: 'apollo fix slides', projectId: p.id });
    // Rule 4.6-8: the summary carries no project title (the title was known to the pipeline: it was linked).
    expect(c.summary).toBe('Action (me): apollo fix slides');
    expect(c.summary).not.toContain('Apollo Launch');
    expect(c.draft.projectName).toBeNull();
  });

  it('a note links the project too, and a title match ignores case, hyphens and Swedish letters', async () => {
    const p = project('Åre resa');
    const c = await svc.submit('/note #åre-resa book hotel', 'text');
    expect(c.status).toBe('filed');
    expect(listNotes(deps.db)[0]).toMatchObject({ projectId: p.id });
  });

  it('an unknown #zeta asks; c creates the project at filing and files with it', async () => {
    const c = await svc.submit('/todo #zeta write plan', 'text');
    expect(c).toMatchObject({ status: 'pending', question: { type: 'unknown_project', name: 'zeta' }, draft: { projectName: 'zeta', projectId: null } });
    expect(c.question!.options.map((o) => o.key)).toEqual(['c', 'p', 's', 'd']);
    expect(counts()).toEqual(NOTHING);
    expect(projectCount()).toBe(0);
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(done.status).toBe('filed');
    const z = listProjects(deps.db)[0]!;
    expect(z.title).toBe('zeta');
    expect(done.filed).toEqual([{ kind: 'action', id: expect.any(Number) }, { kind: 'project', id: z.id }]);
    expect(listActions(deps.db)[0]).toMatchObject({ projectId: z.id });
    // Rule 4.6-8: only the id stays in the draft; the summary names no project.
    expect(done.draft).toMatchObject({ projectId: z.id, projectName: null });
    expect(done.summary).toBe('Action (me): zeta write plan');
    const stored = JSON.parse((deps.db.prepare('SELECT draft FROM captures WHERE id = ?').get(c.id) as { draft: string }).draft);
    expect(stored).toMatchObject({ projectName: null, projectCreate: null, personCreate: null, projectPending: false });
  });

  it('the "title is in the draft before, gone after" pairing for a created project', async () => {
    const c = await svc.submit('/todo #"Zeta Plan" go', 'text');
    const before = JSON.parse((deps.db.prepare('SELECT draft FROM captures WHERE id = ?').get(c.id) as { draft: string }).draft);
    expect(before.projectName).toBe('Zeta Plan');
    const created = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(created.status).toBe('filed');
    const after = JSON.parse((deps.db.prepare('SELECT draft, summary FROM captures WHERE id = ?').get(c.id) as { draft: string }).draft);
    expect(after.projectName).toBeNull();
    expect(after.projectCreate).toBeNull();
    expect(created.summary).toBe('Action (me): Zeta Plan go'); // the user's own typed words only
    expect(created.summary).not.toContain('·');
  });

  it('s files without a project', async () => {
    const c = await svc.submit('/todo #zeta write plan', 'text');
    const done = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(done.status).toBe('filed');
    expect(listActions(deps.db)[0]!.projectId).toBeNull();
    expect(projectCount()).toBe(0);
    expect(done.draft).toMatchObject({ projectId: null, projectName: null });
  });

  it('p alone is not an answer; p then { projectId } links an existing project', async () => {
    const p = project('Apollo');
    const c = await svc.submit('/todo #zeta write plan', 'text');
    expect(await svc.answer(c.id, { key: 'p' })).toBe('bad_answer');
    const done = (await svc.answer(c.id, { projectId: p.id })) as Capture;
    expect(done).toMatchObject({ status: 'filed', draft: { projectId: p.id } });
    expect(listActions(deps.db)[0]!.projectId).toBe(p.id);
    expect(projectCount()).toBe(1);
  });

  it('several matches ask which; a candidate key links, s skips, a bad key is refused', async () => {
    const a = project('Board deck');
    const b = project('Board meeting');
    const c = await svc.submit('/todo #board prepare', 'text');
    expect(c.question).toMatchObject({
      type: 'ambiguous_project', name: 'board',
      candidates: [{ key: '1', projectId: a.id, title: 'Board deck' }, { key: '2', projectId: b.id, title: 'Board meeting' }],
    });
    expect(c.question!.options.map((o) => o.key)).toEqual(['s', 'd']);
    expect(await svc.answer(c.id, { key: '9' })).toBe('bad_answer');
    expect(await svc.answer(c.id, { key: 'c' })).toBe('bad_answer');
    const done = (await svc.answer(c.id, { key: '2' })) as Capture;
    expect(done.draft.projectId).toBe(b.id);
    const c2 = await svc.submit('/todo #board again', 'text');
    expect(((await svc.answer(c2.id, { key: 's' })) as Capture).draft.projectId).toBeNull();
  });

  it('an exact title beats a longer title that starts with it', async () => {
    const board = project('Board');
    project('Board deck');
    const c = await svc.submit('/note #board x', 'text');
    expect(c.draft.projectId).toBe(board.id);
  });

  it('a done project is never matched; the mention asks as unknown', async () => {
    project('Old thing', [], 'done');
    const c = await svc.submit('/note #"Old thing" x', 'text');
    expect(c.question).toMatchObject({ type: 'unknown_project', name: 'Old thing' });
  });

  it('a deleted project is never matched', async () => {
    const p = project('Gone');
    softDeleteProject(deps.db, p.id, deps.now());
    const c = await svc.submit('/note #gone x', 'text');
    expect(c.question).toMatchObject({ type: 'unknown_project' });
  });

  it('creating a done project\'s exact title links it instead of making a twin', async () => {
    const old = project('Old thing', [], 'done');
    const c = await svc.submit('/note #"Old thing" x', 'text');
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(done.draft.projectId).toBe(old.id);
    expect(projectCount()).toBe(1);
    expect(done.filed).toEqual([{ kind: 'note', id: expect.any(Number) }]);
  });

  it('c links a project created meanwhile with exactly that title, but not a merely similar one', async () => {
    const c1 = await svc.submit('/note #zeta one', 'text');
    const c2 = await svc.submit('/note #zeta two', 'text');
    const meanwhile = project('Zeta');
    const d1 = (await svc.answer(c1.id, { key: 'c' })) as Capture;
    expect(d1.draft.projectId).toBe(meanwhile.id);
    expect(projectCount()).toBe(1);
    softDeleteProject(deps.db, meanwhile.id, deps.now());
    project('Zeta Two');
    const d2 = (await svc.answer(c2.id, { key: 'c' })) as Capture;
    expect(projectCount()).toBe(3);
    expect(d2.filed.some((r) => r.kind === 'project')).toBe(true);
  });

  it('c when two projects now match exactly asks which instead of creating', async () => {
    const c = await svc.submit('/note #zeta one', 'text');
    const a = project('Zeta');
    const b = project('Other', ['zeta']);
    const q = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(q.status).toBe('pending');
    expect(q.question).toMatchObject({ type: 'ambiguous_project' });
    expect((q.question as { candidates: { projectId: number }[] }).candidates.map((x) => x.projectId).sort()).toEqual([a.id, b.id].sort());
    expect(projectCount()).toBe(2);
    expect(counts()).toEqual(NOTHING);
  });

  it('an over-long or control-character project name is ignored', async () => {
    const c1 = await svc.submit(`/note #"${'a'.repeat(LIMITS.name + 1)}" x`, 'text');
    expect(c1.status).toBe('filed');
    const c2 = await svc.submit('/note #"a\u0007b" x', 'text');
    expect(c2.status).toBe('filed');
    expect(projectCount()).toBe(0);
  });

  it('agenda drops the project: no project question, item filed, nothing created', async () => {
    const anna = person('Anna');
    const c = await svc.submit('/agenda @anna talk about #zeta', 'text');
    expect(c).toMatchObject({ status: 'filed', question: null, draft: { projectId: null, projectName: null } });
    expect(getPersonDetail(deps.db, anna.id)!.openAgenda).toHaveLength(1);
    expect(projectCount()).toBe(0);
    project('Apollo');
    const c2 = await svc.submit('/agenda @anna about #apollo', 'text');
    expect(c2).toMatchObject({ status: 'filed', draft: { projectId: null } });
  });

  it('answering the kind question with agenda drops a pending project question too', async () => {
    person('Anna');
    const c = await svc.submit('about #zeta with Anna ??', 'text');
    expect(c.question?.type).toBe('kind');
    const done = (await svc.answer(c.id, { key: 'a' })) as Capture;
    expect(done.status).toBe('filed');
    expect(projectCount()).toBe(0);
  });
});

describe('projects: free text and the classifier', () => {
  it('one multi-word title in the text links without asking', async () => {
    const p = project('Board deck');
    const c = await svc.submit('/todo update the board deck', 'text');
    expect(c).toMatchObject({ status: 'filed', draft: { projectId: p.id } });
  });

  it('a single word title in the text is only a suggestion: asked, with skip', async () => {
    const p = project('Apollo');
    const c = await svc.submit('/todo slides for apollo', 'text');
    expect(c).toMatchObject({ status: 'pending', question: { type: 'ambiguous_project', candidates: [{ projectId: p.id, title: 'Apollo' }] } });
    expect(c.question!.options.map((o) => o.key)).toEqual(['s', 'd']);
    expect(counts()).toEqual(NOTHING);
    const done = (await svc.answer(c.id, { key: '1' })) as Capture;
    expect(done.draft.projectId).toBe(p.id);
  });

  it('several multi-word matches ask', async () => {
    project('Board deck');
    project('Q4 plan');
    const c = await svc.submit('/todo compare board deck and q4 plan', 'text');
    expect(c.question).toMatchObject({ type: 'ambiguous_project' });
    expect((c.question as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('free text never matches a done or deleted project', async () => {
    project('Board deck', [], 'done');
    const g = project('Q4 plan');
    softDeleteProject(deps.db, g.id, deps.now());
    const c = await svc.submit('/todo board deck and q4 plan and apollo', 'text');
    expect(c.status).toBe('filed');
    expect(listActions(deps.db)[0]!.projectId).toBeNull();
  });

  it('an LLM-suggested project is always asked, never linked silently', async () => {
    setup(llmProject('Apollo'));
    const p = project('Apollo', ['Moon']);
    const c = await svc.submit('some plain thought', 'text');
    expect(c).toMatchObject({ status: 'pending', classifiedBy: 'llm', question: { type: 'ambiguous_project', name: 'Apollo' } });
    expect(counts()).toEqual(NOTHING);
    const done = (await svc.answer(c.id, { key: '1' })) as Capture;
    expect(done).toMatchObject({ status: 'filed', draft: { projectId: p.id, projectName: null } });
  });

  it('the fake classifier\'s "project Apollo" suggestion asks too', async () => {
    const p = project('Apollo');
    const c = await svc.submit('todo: slides for project Apollo', 'text');
    expect(c.question).toMatchObject({ type: 'ambiguous_project', candidates: [{ projectId: p.id }] });
  });

  it('an LLM project name that is not a known title or alias is ignored', async () => {
    setup(llmProject('Mallory'));
    project('Apollo');
    const c = await svc.submit('some plain thought', 'text');
    expect(c.status).toBe('filed');
    expect(listNotes(deps.db)[0]!.projectId).toBeNull();
  });

  it('an LLM project name is ignored for a done project, a prefix capture, or low confidence', async () => {
    setup(llmProject('Old', { confidence: 0.99 }));
    project('Old', [], 'done');
    expect((await svc.submit('plain', 'text')).status).toBe('filed');
    setup(llmProject('Apollo'));
    project('Apollo');
    expect((await svc.submit('/note plain', 'text')).status).toBe('filed');
    setup(llmProject('Apollo', { confidence: 0.1 }));
    project('Apollo');
    expect((await svc.submit('plain', 'text')).question?.type).toBe('kind');
  });

  it('a classifier reply without projectName counts as no project; a non-string one is invalid', async () => {
    setup({ classify: async () => ({ kind: 'note', confidence: 0.99, personName: null, owner: 'me' }) as unknown as ClassifyOutput });
    expect((await svc.submit('plain', 'text')).status).toBe('filed');
    setup({ classify: async () => ({ kind: 'note', confidence: 0.99, personName: null, projectName: 5, owner: 'me' }) as unknown as ClassifyOutput });
    expect((await svc.submit('plain', 'text')).question?.type).toBe('kind');
  });

  it('sends capped, trimmed, live and not-done projects to the classifier', async () => {
    for (let i = 0; i < 120; i++) project(`P${i} ${'x'.repeat(200)}`, Array.from({ length: 15 }, (_, j) => `${'y'.repeat(300)}${j}`));
    project('Finished', [], 'done');
    const gone = project('Deleted');
    softDeleteProject(deps.db, gone.id, deps.now());
    await svc.submit('hello world', 'text');
    const input = classify.mock.calls[0]![0] as ClassifyInput;
    expect(input.projects).toHaveLength(100);
    expect(Array.from(input.projects[0]!.title)).toHaveLength(100);
    expect(input.projects[0]!.aliases).toHaveLength(10);
    expect(Array.from(input.projects[0]!.aliases[0]!)).toHaveLength(100);
    expect(JSON.stringify(input)).not.toContain('Finished');
    expect(JSON.stringify(input)).not.toContain('Deleted');
  });
});

describe('projects: order of questions and creation at filing', () => {
  it('asks the kind, then the person, then the project, one at a time', async () => {
    const c = await svc.submit('about @bob and #zeta ??', 'text');
    expect(c.question?.type).toBe('kind');
    const q2 = (await svc.answer(c.id, { key: 't' })) as Capture;
    expect(q2.question).toMatchObject({ type: 'unknown_person', name: 'bob' });
    const q3 = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(q3.question).toMatchObject({ type: 'unknown_project', name: 'zeta' });
    expect(((await svc.answer(c.id, { key: 's' })) as Capture).status).toBe('filed');
  });

  it('create person then create project: neither exists before filing, both are created at filing', async () => {
    const c = await svc.submit('/todo @bob #zeta send it', 'text');
    expect(c.question?.type).toBe('unknown_person');
    const q = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(q).toMatchObject({ status: 'pending', question: { type: 'unknown_project', name: 'zeta' } });
    expect(listPeople(deps.db)).toHaveLength(0);
    expect(projectCount()).toBe(0);
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(done.status).toBe('filed');
    const bob = listPeople(deps.db)[0]!;
    const z = listProjects(deps.db)[0]!;
    expect(done.filed).toEqual([{ kind: 'action', id: expect.any(Number) }, { kind: 'person', id: bob.id }, { kind: 'project', id: z.id }]);
    expect(listActions(deps.db)[0]).toMatchObject({ personId: bob.id, projectId: z.id });
    expect(done.draft).toMatchObject({ personId: bob.id, projectId: z.id, projectName: null });
  });

  it('create person with an agenda item still needs no extra question and files', async () => {
    const c = await svc.submit('/agenda @bob salary', 'text');
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    expect(done.status).toBe('filed');
    expect(getPersonDetail(deps.db, listPeople(deps.db)[0]!.id)!.openAgenda).toHaveLength(1);
  });

  it('a failure at filing rolls back both the created person and the created project', async () => {
    const c = await svc.submit('/todo @bob #zeta send it', 'text');
    await svc.answer(c.id, { key: 'c' });
    deps.db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON captures WHEN NEW.status = 'filed'
      BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    await expect(svc.answer(c.id, { key: 'c' })).rejects.toThrow();
    expect(counts()).toEqual(NOTHING);
    expect(listPeople(deps.db)).toHaveLength(0);
    expect(projectCount()).toBe(0);
    expect(svc.list({ limit: 5 })[0]).toMatchObject({ status: 'pending', question: { type: 'unknown_project' } });
  });

  it('a person created meanwhile with exactly that name is linked, not duplicated, at filing', async () => {
    const c = await svc.submit('/todo @bob #zeta send it', 'text');
    await svc.answer(c.id, { key: 'c' });
    const bob = person('Bob');
    const done = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(done.draft.personId).toBe(bob.id);
    expect(listPeople(deps.db)).toHaveLength(1);
    expect(done.filed.some((r) => r.kind === 'person')).toBe(false);
  });

  it('two people with that exact name at filing ask which instead of creating', async () => {
    const c = await svc.submit('/todo @bob #zeta send it', 'text');
    await svc.answer(c.id, { key: 'c' });
    person('Bob');
    person('Robert', ['bob']);
    const q = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(q).toMatchObject({ status: 'pending', question: { type: 'ambiguous_person' } });
    expect(listPeople(deps.db)).toHaveLength(2);
  });

  it('undo keeps a created project, like a created person', async () => {
    const c = await svc.submit('/todo #zeta x', 'text');
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    svc.undo(done.id);
    expect(projectCount()).toBe(1);
    expect(listActions(deps.db)).toHaveLength(0);
    expect(listProjects(deps.db)[0]!.title).toBe('zeta');
  });

  it('reclassify keeps the project link, and the next filing uses it', async () => {
    const p = project('Apollo');
    const c = await svc.submit('/todo #apollo fix', 'text');
    const r = svc.reclassify(c.id) as Capture;
    expect(r).toMatchObject({ status: 'pending', question: { type: 'kind' }, draft: { projectId: p.id } });
    const done = (await svc.answer(c.id, { key: 'n' })) as Capture;
    expect(done.status).toBe('filed');
    expect(listNotes(deps.db)[0]).toMatchObject({ projectId: p.id });
  });

  it('reclassify of a capture that created a project drops only the item, keeps the project and its link', async () => {
    const c = await svc.submit('/todo #zeta x', 'text');
    const done = (await svc.answer(c.id, { key: 'c' })) as Capture;
    const z = listProjects(deps.db)[0]!;
    const r = svc.reclassify(done.id) as Capture;
    expect(r.draft.projectId).toBe(z.id);
    expect(r.filed).toEqual([]);
    expect(projectCount()).toBe(1);
  });
});

describe('projects: deleted between the question and the answer', () => {
  const rec = (id: number) => deps.db.prepare('SELECT * FROM captures WHERE id = ?').get(id) as { draft: string; question: string | null };

  it('{ projectId } of a project deleted since the picker opened files the item without a project', async () => {
    const p = project('Picked');
    const c = await svc.submit('/todo #zeta x', 'text');
    softDeleteProject(deps.db, p.id, deps.now());
    const done = (await svc.answer(c.id, { projectId: p.id })) as Capture;
    expect(done).toMatchObject({ status: 'filed', draft: { projectId: null } });
    expect(listActions(deps.db)[0]!.projectId).toBeNull();
  });

  it('an unknown project id is a bad answer, not a 500; a project id answers only a project question', async () => {
    const p = project('Real');
    const c = await svc.submit('/todo #zeta x', 'text');
    expect(await svc.answer(c.id, { projectId: 9999 })).toBe('bad_answer');
    const k = await svc.submit('what ??', 'text');
    expect(await svc.answer(k.id, { projectId: p.id })).toBe('bad_answer');
    const pp = await svc.submit('/todo @bob #zeta x', 'text');
    expect(await svc.answer(pp.id, { projectId: p.id })).toBe('bad_answer');
    expect(await svc.answer(c.id, { personId: person('Anna').id })).toBe('bad_answer');
    expect(counts()).toEqual(NOTHING);
  });

  it('a linked project deleted behind the pipeline\'s back (no scrub) still files without it', async () => {
    const p = project('Apollo');
    const c = await svc.submit('/todo @bob #apollo x', 'text');
    expect(c).toMatchObject({ question: { type: 'unknown_person' }, draft: { projectId: p.id } });
    deps.db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', p.id);
    const done = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(done).toMatchObject({ status: 'filed', draft: { projectId: null } });
    expect(listActions(deps.db)[0]!.projectId).toBeNull();
  });

  it('a deleted candidate leaves the other ones; the question is re-derived on read with the kept name', async () => {
    const a = project('Board deck');
    const b = project('Board meeting');
    const c = await svc.submit('/todo #board prepare', 'text');
    expect(c.question?.type).toBe('ambiguous_project');
    softDeleteProject(deps.db, a.id, deps.now());
    expect(rec(c.id).question).toBeNull(); // scrubbed, not stored
    const listed = svc.list({ limit: 5 })[0]!;
    expect(listed.question).toMatchObject({
      type: 'ambiguous_project', name: 'board', candidates: [{ key: '1', projectId: b.id, title: 'Board meeting' }],
    });
    expect(listed.question!.options.map((o) => o.key)).toEqual(['s', 'd']);
    expect(JSON.stringify(listed)).not.toContain('Board deck');
    const done = (await svc.answer(c.id, { key: '1' })) as Capture;
    expect(done.draft.projectId).toBe(b.id);
  });

  it('a suggested pending project that loses its candidate also loses the suggested name', async () => {
    setup(llmProject('Zephyr Plan'));
    const a = project('Zephyr Plan');
    const b = project('Orion', ['Zephyr Plan']);
    const c = await svc.submit('plain thought', 'text');
    expect(c.question).toMatchObject({ type: 'ambiguous_project', name: 'Zephyr Plan' });
    expect(JSON.parse(rec(c.id).draft).projectName).toBe('Zephyr Plan');
    softDeleteProject(deps.db, a.id, deps.now());
    const d = JSON.parse(rec(c.id).draft);
    expect(d).toMatchObject({ projectName: null, projectCandidates: [b.id], projectPending: true, projectSuggested: true });
    // Re-derived on read: the name is the first remaining candidate's current title.
    const listed = svc.list({ limit: 5 })[0]!;
    expect(listed.question).toMatchObject({ type: 'ambiguous_project', name: 'Orion' });
    expect(JSON.stringify(listed)).not.toContain('Zephyr Plan');
  });

  it('every candidate deleted: no project question remains, and Skip or Discard are the only answers', async () => {
    const a = project('Board deck');
    const b = project('Board meeting');
    const c = await svc.submit('/todo #board prepare', 'text');
    softDeleteProject(deps.db, a.id, deps.now());
    softDeleteProject(deps.db, b.id, deps.now());
    expect(svc.list({ limit: 5 })[0]).toMatchObject({ status: 'pending', question: null });
    expect(await svc.answer(c.id, { key: 'c' })).toBe('bad_answer');
    expect(await svc.answer(c.id, { key: '1' })).toBe('bad_answer');
    const done = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(done).toMatchObject({ status: 'filed', draft: { projectId: null, projectName: null } });
    expect(listActions(deps.db)[0]!.projectId).toBeNull();
  });

  it('a project deleted while it was linked on a pending capture files without it', async () => {
    const p = project('Apollo');
    const c = await svc.submit('/todo @bob #apollo x', 'text');
    softDeleteProject(deps.db, p.id, deps.now());
    expect(JSON.parse(rec(c.id).draft)).toMatchObject({ projectId: null, projectName: null });
    const done = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(done.status).toBe('filed');
    expect(listActions(deps.db)[0]!.projectId).toBeNull();
  });
});

describe('scrubProjectFromCaptures hardening', () => {
  it('drops an unreadable ambiguous_project question that names the project, even when the draft does not', () => {
    const p = project('Zephyr Plan');
    const other = project('Orion');
    const damaged = (id: number, title: string) => JSON.stringify({
      type: 'ambiguous_project', name: 'x', options: 'not an array', candidates: [{ key: '1', projectId: id, title }],
    });
    const ins = (question: string): number => insertCapture(deps.db, {
      text: 'x', source: 'text', status: 'pending', draft: emptyDraft(), question: null, filed: [], summary: '', classifiedBy: null,
    }, deps.now()).id;
    const mine = ins('');
    const theirs = ins('');
    const set = deps.db.prepare('UPDATE captures SET question = ? WHERE id = ?');
    set.run(damaged(p.id, 'Zephyr Plan'), mine);
    set.run(damaged(other.id, 'Orion'), theirs);
    const q = (id: number) => (deps.db.prepare('SELECT question FROM captures WHERE id = ?').get(id) as { question: string | null }).question;
    expect(q(mine)).toContain('Zephyr Plan');
    softDeleteProject(deps.db, p.id, deps.now());
    expect(q(mine)).toBeNull();
    expect(q(theirs)).toContain('Orion'); // unrelated questions are left alone
    expect(rawCaptures()).not.toContain('Zephyr Plan');
  });

  it('an unreadable question that names no project id and is not ambiguous_project is left alone', () => {
    const p = project('Zephyr Plan');
    const id = insertCapture(deps.db, {
      text: 'x', source: 'text', status: 'pending', draft: emptyDraft(), question: null, filed: [], summary: '', classifiedBy: null,
    }, deps.now()).id;
    deps.db.prepare('UPDATE captures SET question = ? WHERE id = ?').run('{"type":"kind","options":5}', id);
    softDeleteProject(deps.db, p.id, deps.now());
    expect((deps.db.prepare('SELECT question FROM captures WHERE id = ?').get(id) as { question: string }).question).toBe('{"type":"kind","options":5}');
  });

  it('an explicit (not suggested) name is kept when a candidate is deleted and others remain', async () => {
    const a = project('Board deck');
    project('Board meeting');
    const c = await svc.submit('/todo #board x', 'text');
    softDeleteProject(deps.db, a.id, deps.now());
    expect(JSON.parse((deps.db.prepare('SELECT draft FROM captures WHERE id = ?').get(c.id) as { draft: string }).draft).projectName).toBe('board');
  });
});

describe('erasure: the title of a deleted project is in no other table', () => {
  /** Every table and text-ish column that holds `needle`, as "table.column". */
  function scan(needle: string, opts: { skip?: string[] } = {}): string[] {
    const hits: string[] = [];
    const tables = deps.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of tables) {
      if (opts.skip?.includes(name)) continue;
      const cols = deps.db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
      for (const col of cols) {
        const r = deps.db.prepare(`SELECT count(*) AS c FROM "${name}" WHERE instr(CAST("${col.name}" AS TEXT), ?) > 0`).get(needle) as { c: number };
        if (r.c > 0) hits.push(`${name}.${col.name}`);
      }
    }
    return hits;
  }

  it('a pending capture with an LLM-suggested name and several candidates leaves no trace after the delete', async () => {
    setup(llmProject('zp'));
    const victim = project('Zephyr Plan', ['zp']);
    project('Orion', ['zp']);
    project('Vega', ['zp']);
    const c = await svc.submit('slides for the launch', 'text');
    expect(c.question).toMatchObject({ type: 'ambiguous_project', name: 'zp' });
    expect((c.question as { candidates: unknown[] }).candidates).toHaveLength(3);

    // Before: the title really is stored in the question (so the scan can find things).
    expect(scan('Zephyr Plan')).toEqual(expect.arrayContaining(['captures.question', 'projects.title']));

    softDeleteProject(deps.db, victim.id, deps.now());

    // The soft-deleted project row itself lives until the 30-day purge (covered by the purge tests);
    // everything else must be clean, and the scan must still be able to see the project row.
    expect(scan('Zephyr Plan', { skip: ['projects'] })).toEqual([]);
    expect(scan('Zephyr Plan')).toEqual(['projects.title']);
    // The survivors are still there and the user's own typed text is untouched.
    expect(scan('slides for the launch')).toContain('captures.text');
    expect(svc.list({ limit: 5 })[0]!.question).toMatchObject({ type: 'ambiguous_project' });
    expect(JSON.stringify(svc.list({ limit: 5 }))).not.toContain('Zephyr Plan');
  });

  it('a suggestion that is literally the deleted title leaves no trace either', async () => {
    setup(llmProject('Zephyr Plan'));
    const victim = project('Zephyr Plan');
    project('Orion', ['Zephyr Plan']);
    await svc.submit('slides for the launch', 'text');
    expect(scan('Zephyr Plan', { skip: ['projects'] })).toEqual(expect.arrayContaining(['captures.draft', 'captures.question']));
    softDeleteProject(deps.db, victim.id, deps.now());
    expect(scan('Zephyr Plan', { skip: ['projects'] })).toEqual([]);
  });
});

describe('projects: races and dead ends', () => {
  const draftOf = (id: number) => JSON.parse((deps.db.prepare('SELECT draft FROM captures WHERE id = ?').get(id) as { draft: string }).draft);

  it('a project deleted while the classifier runs leaves no dead id or title in the stored draft', async () => {
    const p = project('Zephyr Plan');
    let seenBefore = '';
    setup({
      classify: async () => {
        seenBefore = 'present';
        softDeleteProject(deps.db, p.id, deps.now());
        return { kind: 'note', confidence: 0.1, personName: null, projectName: null, owner: 'me' };
      },
    });
    // multi-word title in the text: linked before the classifier is awaited
    const c = await svc.submit('review zephyr plan status', 'text');
    expect(seenBefore).toBe('present'); // the link existed when the classifier ran (paired positive)
    expect(c.draft).toMatchObject({ projectId: null, projectName: null });
    expect(draftOf(c.id)).toMatchObject({ projectId: null, projectName: null });
    expect(JSON.stringify(deps.db.prepare('SELECT draft, question FROM captures').all())).not.toContain(`"projectId":${p.id}`);
  });

  it('candidates deleted during the classifier wait are filtered, and none left clears the pending project', async () => {
    const p = project('Budget');
    setup({
      classify: async () => {
        softDeleteProject(deps.db, p.id, deps.now());
        return { kind: 'note', confidence: 0.1, personName: null, projectName: null, owner: 'me' };
      },
    });
    const c = await svc.submit('budget review', 'text');
    expect(c.question?.type).toBe('kind');
    expect(draftOf(c.id)).toMatchObject({ projectCandidates: [], projectPending: false, projectSuggested: false, projectName: null });
  });

  it('weak match, project deleted: list shows pending with no question; s files it, d discards', async () => {
    const p = project('Budget');
    const c = await svc.submit('/note budget review', 'text');
    expect(c.question?.type).toBe('ambiguous_project');
    softDeleteProject(deps.db, p.id, deps.now());
    expect(svc.list({ limit: 5 })[0]).toMatchObject({ status: 'pending', question: null });
    const done = (await svc.answer(c.id, { key: 's' })) as Capture;
    expect(done).toMatchObject({ status: 'filed', draft: { projectId: null } });
    expect(listNotes(deps.db)[0]!.projectId).toBeNull();
  });

  it('the same dead end can be discarded', async () => {
    const p = project('Budget');
    const c = await svc.submit('/note budget review', 'text');
    softDeleteProject(deps.db, p.id, deps.now());
    const d = (await svc.answer(c.id, { key: 'd' })) as Capture;
    expect(d.status).toBe('discarded');
    expect(counts()).toEqual(NOTHING);
  });
});

describe('questions (v0.2 Q&A)', () => {
  it('/ask and /q force a question without calling the classifier; text is the cleaned question', async () => {
    for (const prefix of ['/ask', '/q', '/ASK']) {
      const c = await svc.submit(`${prefix} what did I promise @Anna?`, 'text');
      expect(c).toMatchObject({ status: 'asked', question: null, classifiedBy: 'prefix', answer: null, deleted: false, filed: [] });
      expect(c.draft).toMatchObject({ kind: 'question', text: 'what did I promise Anna?' });
    }
    expect(classify).not.toHaveBeenCalled();
    expect(counts()).toEqual(NOTHING);
  });

  it('a question asks nothing more: no person or project question, no person created', async () => {
    createProject(deps.db, { title: 'Board deck' }, deps.now());
    const c = await svc.submit('/ask what is up with @Zed and #Nowhere and the Board deck?', 'text');
    expect(c.status).toBe('asked');
    expect(c.question).toBeNull();
    expect(c.draft).toMatchObject({ kind: 'question', personName: null });
    expect(listPeople(deps.db)).toEqual([]);
  });

  it('a confident classifier question is stored as asked (classifiedBy llm)', async () => {
    const c = await svc.submit('what did I promise Anna?', 'text');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(c).toMatchObject({ status: 'asked', classifiedBy: 'llm', question: null });
    expect(c.draft.kind).toBe('question');
  });

  it('an unsure classification asks the kind question, which now offers "Answer it"', async () => {
    const c = await svc.submit('is this a thing ??', 'text');
    expect(c.status).toBe('pending');
    expect(c.question).toMatchObject({ type: 'kind' });
    expect((c.question as { options: { key: string; label: string }[] }).options).toEqual([
      { key: 'n', label: 'Note' }, { key: 't', label: 'Action' }, { key: 'a', label: 'Agenda item' }, { key: 'q', label: 'Answer it' }, { key: 'd', label: 'Discard' },
    ]);
    const answered = await svc.answer(c.id, { key: 'q' });
    expect(answered).toMatchObject({ status: 'asked', question: null, classifiedBy: 'user', answer: null });
    expect((answered as Capture).draft.kind).toBe('question');
    expect(counts()).toEqual(NOTHING);
  });

  it('with no classifier a question mark still asks the kind question, and q answers it', async () => {
    setup(null);
    const c = await svc.submit('what did I promise Anna?', 'text');
    expect(c.status).toBe('pending');
    expect(await svc.answer(c.id, { key: 'q' })).toMatchObject({ status: 'asked' });
  });

  it('q is only an answer to the kind question', async () => {
    const c = await svc.submit('/note meet @Zed', 'text');
    expect(c.question).toMatchObject({ type: 'unknown_person' });
    expect(await svc.answer(c.id, { key: 'q' })).toBe('bad_answer');
  });

  it('a classifier that failed or is unsure never files a question as a note', async () => {
    const c = await svc.submit('what next?? !!fail', 'text');
    expect(c.status).toBe('pending');
    expect(counts()).toEqual(NOTHING);
  });

  it('undo of an asked question discards it; undo of an answered one erases answer and sources at once', async () => {
    const asked = await svc.submit('/ask hello?', 'text');
    expect(svc.undo(asked.id)).toMatchObject({ status: 'discarded', summary: 'Discarded', answer: null });
    expect(svc.undo(asked.id)).toBe('not_filed');

    const c = await svc.submit('/ask hello?', 'text');
    deps.db.prepare("UPDATE captures SET status = 'answered', answer = 'SECRET-ANSWER', sources = ? WHERE id = ?")
      .run(JSON.stringify({ sent: [{ kind: 'note', id: 1 }], cited: [] }), c.id);
    const undone = svc.undo(c.id) as Capture;
    expect(undone).toMatchObject({ status: 'discarded', answer: null });
    const row = deps.db.prepare('SELECT answer, sources FROM captures WHERE id = ?').get(c.id);
    expect(row).toEqual({ answer: null, sources: null });
  });

  it('reclassify of an asked or answered question returns to the kind question and erases the answer', async () => {
    for (const status of ['asked', 'answered']) {
      const c = await svc.submit('/ask hello there?', 'text');
      if (status === 'answered') {
        deps.db.prepare("UPDATE captures SET status = 'answered', answer = 'SECRET-ANSWER', sources = '{\"sent\":[],\"cited\":[]}' WHERE id = ?").run(c.id);
      }
      const r = svc.reclassify(c.id) as Capture;
      expect(r).toMatchObject({ status: 'pending', question: { type: 'kind' }, answer: null, classifiedBy: null });
      expect(r.draft).toMatchObject({ kind: null, text: 'hello there?' });
      expect(deps.db.prepare('SELECT answer, sources FROM captures WHERE id = ?').get(c.id)).toEqual({ answer: null, sources: null });
      // File instead: the user picks Note, and the text is filed as one.
      const filed = (await svc.answer(c.id, { key: 'n' })) as Capture;
      expect(filed).toMatchObject({ status: 'filed' });
    }
    expect(listNotes(deps.db)).toHaveLength(2);
  });

  it('asked and answered captures are listed with their text; the list never throws on odd rows', async () => {
    const c = await svc.submit('/ask hello?', 'text');
    deps.db.prepare("UPDATE captures SET status = 'answered', answer = NULL, sources = NULL WHERE id = ?").run(c.id);
    const [listed] = svc.list({ limit: 5 });
    expect(listed).toMatchObject({ id: c.id, status: 'answered', text: '/ask hello?', answer: { text: '', redacted: true } });
  });

  it('every other capture carries answer null', async () => {
    await svc.submit('/note a', 'text');
    await svc.submit('??', 'text');
    for (const c of svc.list({ limit: 5 })) expect(c.answer).toBeNull();
  });

  describe('"File instead" keeps what the parser stripped from the question', () => {
    it('an ambiguous @person: reclassify then Note asks the person question again', async () => {
      person('Anna Berg'); person('Anna Lind');
      const c = await svc.submit('/ask what did @Anna say?', 'text');
      expect(c.status).toBe('asked');
      expect(c.draft).toMatchObject({ kind: 'question', personName: null, personId: null }); // unresolved names are not shown
      const row = deps.db.prepare('SELECT draft FROM captures WHERE id = ?').get(c.id) as { draft: string };
      expect(JSON.parse(row.draft)).toMatchObject({ personPending: true, personName: 'Anna' }); // but they are stored
      const re = (await svc.reclassify(c.id)) as Capture;
      expect(re).toMatchObject({ status: 'pending', question: { type: 'kind' } });
      const next = (await svc.answer(c.id, { key: 'n' })) as Capture;
      expect(next).toMatchObject({ status: 'pending', question: { type: 'ambiguous_person', name: 'Anna' } });
      expect((next.question as { candidates: unknown[] }).candidates).toHaveLength(2);
      expect(counts()).toEqual(NOTHING);
      const filed = (await svc.answer(c.id, { key: '1' })) as Capture;
      expect(filed.status).toBe('filed');
      expect(listNotes(deps.db)[0]).toMatchObject({ personId: expect.any(Number) });
    });

    it('an unknown #project: reclassify then Note asks unknown_project', async () => {
      const c = await svc.submit('/ask how is #Zeta going?', 'text');
      expect(c.draft.projectName).toBeNull();
      await svc.reclassify(c.id);
      const next = (await svc.answer(c.id, { key: 'n' })) as Capture;
      expect(next).toMatchObject({ status: 'pending', question: { type: 'unknown_project', name: 'Zeta' } });
    });

    it('an unsure capture with a pending person, answered "q" and filed later, still asks about the person', async () => {
      const c = await svc.submit('talk to @Zed about this ??', 'text');
      expect(c).toMatchObject({ status: 'pending', question: { type: 'kind' } });
      const asked = (await svc.answer(c.id, { key: 'q' })) as Capture;
      expect(asked.status).toBe('asked');
      await svc.reclassify(c.id);
      const next = (await svc.answer(c.id, { key: 'n' })) as Capture;
      expect(next).toMatchObject({ status: 'pending', question: { type: 'unknown_person', name: 'Zed' } });
      expect(listPeople(deps.db)).toEqual([]);
      const filed = (await svc.answer(c.id, { key: 'c' })) as Capture;
      expect(filed.status).toBe('filed');
      expect(listPeople(deps.db).map((p) => p.name)).toEqual(['Zed']);
    });
  });
});

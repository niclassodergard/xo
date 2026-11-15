import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDeps } from '../../../test/helpers.ts';
import type { AppDeps } from '../deps.ts';
import { FakeClassifier } from '../llm/fake.ts';
import type { Classifier, ClassifyInput, ClassifyOutput } from '../llm/types.ts';
import { LlmError } from '../llm/types.ts';
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

  const llmNamed = (name: string): Classifier => ({ classify: async () => ({ kind: 'note', confidence: 0.99, personName: name, owner: 'me' }) });

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

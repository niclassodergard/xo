import { describe, expect, it } from 'vitest';
import type { Capture, CaptureAnswer, CaptureQuestion } from '../../shared/types.ts';
import type { CaptureApi, Lookups, RecallPos, Stash } from './stream-logic.ts';
import {
  askFailureMessage, askFailureOf, CAPTURE_PAGE, capturesPath, NO_MATCH_TEXT, sourceChips, sourceRef, chipsFor, composerKey, countChars, counterState, createLandedFeed, createSendQueue, defaultChipId,
  historyTexts, loadCaptures, mergeLoaded, openRef, prependPage, questionChoices, questionPrompt, recallNext, recallStep,
  replyFor, replyText, stepSelection, upsertCapture, upsertLanded,
} from './stream-logic.ts';

const kindQ: CaptureQuestion = {
  type: 'kind',
  options: [{ key: 'n', label: 'note' }, { key: 't', label: 'action' }, { key: 'a', label: 'agenda' }, { key: 'd', label: 'discard' }],
};
const unknownQ: CaptureQuestion = {
  type: 'unknown_person', name: 'Bob',
  options: [{ key: 'c', label: 'create' }, { key: 'p', label: 'pick existing' }, { key: 's', label: 'skip' }, { key: 'd', label: 'discard' }],
};
const ambiguousQ: CaptureQuestion = {
  type: 'ambiguous_person', name: 'Anna',
  candidates: [{ key: '1', personId: 4, name: 'Anna Berg' }, { key: '2', personId: 9, name: 'Anna Lind' }],
  options: [{ key: 's', label: 'skip' }, { key: 'd', label: 'discard' }],
};
const needsQ: CaptureQuestion = { type: 'needs_person', options: [{ key: 'p', label: 'pick existing' }, { key: 'd', label: 'discard' }] };
const unknownProjectQ: CaptureQuestion = {
  type: 'unknown_project', name: 'Zeta',
  options: [{ key: 'c', label: 'create' }, { key: 'p', label: 'pick existing' }, { key: 's', label: 'skip' }, { key: 'd', label: 'discard' }],
};
const ambiguousProjectQ: CaptureQuestion = {
  type: 'ambiguous_project', name: 'Apollo',
  candidates: [{ key: '1', projectId: 3, title: 'Apollo' }],
  options: [{ key: 's', label: 'skip' }, { key: 'd', label: 'discard' }],
};

function cap(id: number, over: Partial<Capture> = {}): Capture {
  return {
    id, text: `text ${id}`, source: 'text', status: 'filed',
    draft: { kind: 'note', text: `text ${id}`, personId: null, personName: null, projectId: null, projectName: null, owner: 'me' },
    question: null, filed: [{ kind: 'note', id: 10 + id }], summary: 'Note: x', classifiedBy: 'llm', deleted: false,
    createdAt: '2026-11-15T10:00:00.000Z', answer: null, ...over,
  };
}
const pending = (id: number, q: CaptureQuestion | null = kindQ) => cap(id, { status: 'pending', question: q, filed: [], summary: '' });
const draftOf = (over: Partial<Capture['draft']>): Capture['draft'] => ({ ...cap(1).draft, ...over });

const lookups: Lookups = {
  personName: (id) => ({ 4: 'Anna Berg', 9: 'Anna Lind', 5: 'Anna' } as Record<number, string>)[id] ?? null,
  projectTitle: (id) => ({ 3: 'Board deck' } as Record<number, string>)[id] ?? null,
};

describe('questions', () => {
  it('renders candidates before options as choices', () => {
    expect(questionChoices(ambiguousQ).map((c) => c.key)).toEqual(['1', '2', 's', 'd']);
    expect(questionChoices(ambiguousQ)[0]?.label).toBe('Anna Berg');
    expect(questionChoices(ambiguousProjectQ)[0]).toEqual({ key: '1', label: 'Apollo' });
  });
  it('prompts are plain text containing the name as given', () => {
    expect(questionPrompt(unknownQ)).toContain('"Bob"');
    expect(questionPrompt({ ...unknownQ, name: '<b>x</b>' })).toContain('<b>x</b>');
    expect(questionPrompt(kindQ)).toBe('What is this?');
    expect(questionPrompt(unknownProjectQ)).toContain('"Zeta"');
    expect(questionPrompt(ambiguousProjectQ)).toContain('"Apollo"');
    expect(questionPrompt(needsQ)).toContain('agenda');
  });
});

describe('replyFor', () => {
  const filed = (draft: Partial<Capture['draft']>, filedRefs: Capture['filed'] = [{ kind: 'action', id: 7 }]) =>
    cap(1, { draft: draftOf(draft), filed: filedRefs });

  it('a task for me, with person and project, as links', () => {
    const r = replyFor(filed({ kind: 'action', personId: 5, personName: 'Anna', projectId: 3 }), lookups);
    expect(replyText(r)).toBe('Filed as a task for you · Anna · on Board deck');
    expect(r.tone).toBe('filed');
    expect(r.segments.filter((s) => s.ref).map((s) => s.ref)).toEqual([{ kind: 'person', id: 5 }, { kind: 'project', id: 3 }]);
  });
  it('a task for me without person or project', () => {
    expect(replyText(replyFor(filed({ kind: 'action' }), lookups))).toBe('Filed as a task for you');
  });
  it('waiting on someone', () => {
    expect(replyText(replyFor(filed({ kind: 'action', owner: 'them', personId: 5, personName: 'Anna' }), lookups))).toBe('Waiting on Anna for this');
    expect(replyText(replyFor(filed({ kind: 'action', owner: 'them' }), lookups))).toBe('Waiting for someone on this');
    expect(replyText(replyFor(filed({ kind: 'action', owner: 'them', personId: 5, projectId: 3 }), lookups))).toBe('Waiting on Anna for this · on Board deck');
  });
  it('an agenda item names the person', () => {
    const r = replyFor(filed({ kind: 'agenda', personId: 5 }, [{ kind: 'agenda', id: 2 }]), lookups);
    expect(replyText(r)).toBe("Added to Anna's 1-1 agenda");
    expect(r.segments[1]?.ref).toEqual({ kind: 'person', id: 5 });
    expect(replyText(replyFor(filed({ kind: 'agenda' }, [{ kind: 'agenda', id: 2 }]), lookups))).toBe('Added to a 1-1 agenda');
  });
  it('a note', () => {
    expect(replyText(replyFor(filed({ kind: 'note' }, [{ kind: 'note', id: 2 }]), lookups))).toBe('Saved as a note');
    expect(replyText(replyFor(filed({ kind: 'note', personId: 4, projectId: 3 }, [{ kind: 'note', id: 2 }]), lookups))).toBe('Saved as a note · Anna Berg · on Board deck');
  });
  it('a person or project created by the capture is marked new', () => {
    const c = filed({ kind: 'note', personId: 9, personName: 'Anna Lind', projectId: 3 }, [{ kind: 'note', id: 2 }, { kind: 'person', id: 9 }, { kind: 'project', id: 3 }]);
    expect(replyText(replyFor(c, lookups))).toBe('Saved as a note · Anna Lind (new) · on Board deck (new)');
  });
  it('unknown ids: no link and no crash; a typed name stays as plain text, a project title is omitted', () => {
    const r = replyFor(filed({ kind: 'action', personId: 99, personName: 'Zed', projectId: 98 }), lookups);
    expect(replyText(r)).toBe('Filed as a task for you · Zed');
    expect(r.segments.some((s) => s.ref !== undefined)).toBe(false);
    expect(replyText(replyFor(filed({ kind: 'action', personId: 99, personName: null }), lookups))).toBe('Filed as a task for you');
    expect(() => replyFor(filed({ kind: null }), lookups)).not.toThrow();
    expect(replyText(replyFor(filed({ kind: null }), lookups))).toBe('Filed');
  });
  it('never shows the server summary (it can carry typed text)', () => {
    expect(replyText(replyFor(cap(1, { summary: 'Note: SECRET' }), lookups))).not.toContain('SECRET');
  });
  it('undone, discarded, deleted', () => {
    expect(replyText(replyFor(cap(1, { status: 'undone' }), lookups))).toBe('Undone');
    expect(replyText(replyFor(cap(1, { status: 'discarded' }), lookups))).toBe('Discarded');
    const del = cap(1, { status: 'undone', text: '', summary: '(deleted)', filed: [], deleted: true });
    expect(replyFor(del, lookups)).toMatchObject({ tone: 'deleted' });
    expect(replyText(replyFor(del, lookups))).toBe('Deleted');
    // Undone by the user in this session: the server's redacted form looks the same as a deleted one.
    expect(replyText(replyFor(del, { ...lookups, undone: (id) => id === 1 }))).toBe('Undone');
    expect(replyText(replyFor({ ...del, id: 2 }, { ...lookups, undone: (id) => id === 1 }))).toBe('Deleted');
  });
  it('pending: the question, or "Ready to file" when there is none (never an endless working state)', () => {
    expect(replyText(replyFor(pending(1), lookups))).toBe('What is this?');
    const ready = replyFor(pending(1, null), lookups);
    expect(ready.tone).toBe('ready');
    expect(replyText(ready)).toBe('Ready to file');
    expect(replyText(ready)).not.toMatch(/working/i);
  });
});

describe('chipsFor', () => {
  const ids = (c: Capture) => chipsFor(c).map((x) => x.id);
  it('filed: Open, Undo, Reclassify; Open is the default', () => {
    expect(chipsFor(cap(1)).map((x) => x.label)).toEqual(['Open', 'Undo', 'Reclassify']);
    expect(defaultChipId(cap(1))).toBe('open');
  });
  it('filed without anywhere to go: no Open and therefore no default (Enter never undoes by default)', () => {
    const c = cap(1, { filed: [{ kind: 'agenda', id: 2 }], draft: draftOf({ kind: 'agenda', personId: null }) });
    expect(ids(c)).toEqual(['undo', 'reclassify']);
    expect(defaultChipId(c)).toBeNull();
  });
  it('a question has no default chip', () => {
    expect(defaultChipId(pending(1))).toBeNull();
    expect(defaultChipId(pending(1, unknownQ))).toBeNull();
  });
  it('kind question: its four choices as answers', () => {
    expect(chipsFor(pending(1)).map((x) => [x.label, x.answer])).toEqual([
      ['Note', { key: 'n' }], ['Action', { key: 't' }], ['Agenda', { key: 'a' }], ['Discard', { key: 'd' }],
    ]);
  });
  it('ambiguous person: candidates first; ambiguous project too', () => {
    expect(chipsFor(pending(1, ambiguousQ)).map((x) => x.label)).toEqual(['Anna Berg', 'Anna Lind', 'Skip', 'Discard']);
    expect(chipsFor(pending(1, ambiguousProjectQ)).map((x) => x.label)).toEqual(['Apollo', 'Skip', 'Discard']);
  });
  it('"Pick existing" opens the matching picker instead of sending p', () => {
    const person = chipsFor(pending(1, unknownQ)).find((x) => x.label === 'Pick existing');
    expect(person).toMatchObject({ kind: 'pick', pickKind: 'person' });
    expect(person?.answer).toBeUndefined();
    expect(chipsFor(pending(1, needsQ)).find((x) => x.kind === 'pick')?.pickKind).toBe('person');
    expect(chipsFor(pending(1, unknownProjectQ)).find((x) => x.kind === 'pick')?.pickKind).toBe('project');
  });
  it('a question without a question object: File and Discard, answered s and d', () => {
    expect(chipsFor(pending(1, null)).map((x) => [x.label, x.answer])).toEqual([['File', { key: 's' }], ['Discard', { key: 'd' }]]);
  });
  it('finished and redacted captures have no chips', () => {
    expect(chipsFor(cap(1, { status: 'undone' }))).toEqual([]);
    expect(chipsFor(cap(1, { status: 'discarded' }))).toEqual([]);
    expect(chipsFor(cap(1, { status: 'undone', deleted: true, filed: [] }))).toEqual([]);
  });
  it('server-supplied tokens that are not one letter or digit are never offered', () => {
    const q: CaptureQuestion = { type: 'kind', options: [{ key: 'ctrl+x', label: 'x' }, { key: '', label: 'e' }, { key: ' ', label: 's' }, { key: 'n', label: 'note' }] };
    expect(chipsFor(pending(1, q)).map((x) => x.id)).toEqual(['a:n']);
  });
});

describe('openRef', () => {
  it('notes open the note, actions the list, persons their page', () => {
    expect(openRef(cap(1))).toEqual({ kind: 'note', id: 11 });
    expect(openRef(cap(1, { filed: [{ kind: 'action', id: 3 }] }))).toEqual({ kind: 'actions' });
    expect(openRef(cap(1, { filed: [{ kind: 'person', id: 7 }] }))).toEqual({ kind: 'person', id: 7 });
  });
  it('agenda opens the linked person; a person ref is used when the draft has none', () => {
    const agenda = cap(1, { filed: [{ kind: 'agenda', id: 2 }], draft: draftOf({ kind: 'agenda', personId: 5 }) });
    expect(openRef(agenda)).toEqual({ kind: 'person', id: 5 });
    expect(openRef({ ...agenda, draft: { ...agenda.draft, personId: null }, filed: [{ kind: 'person', id: 8 }, { kind: 'agenda', id: 2 }] })).toEqual({ kind: 'person', id: 8 });
    expect(openRef({ ...agenda, draft: { ...agenda.draft, personId: null } })).toBeNull();
  });
  it('is null for non-filed captures, deleted ones and bad ids', () => {
    expect(openRef(pending(1))).toBeNull();
    expect(openRef(cap(1, { filed: [{ kind: 'note', id: -1 }] }))).toBeNull();
    expect(openRef(cap(1, { filed: [] }))).toBeNull();
    expect(openRef(cap(1, { deleted: true }))).toBeNull();
  });
});

describe('stepSelection', () => {
  const ids = [1, 2, 3];
  it('Up from nothing picks the newest', () => {
    expect(stepSelection(ids, null, 'up', false)).toEqual({ kind: 'select', id: 3 });
    expect(stepSelection(ids, 99, 'up', false)).toEqual({ kind: 'select', id: 3 }); // stale selection
  });
  it('moves up and down one at a time', () => {
    expect(stepSelection(ids, 3, 'up', false)).toEqual({ kind: 'select', id: 2 });
    expect(stepSelection(ids, 1, 'down', false)).toEqual({ kind: 'select', id: 2 });
  });
  it('Up at the oldest loads the previous page when there is one, else stays', () => {
    expect(stepSelection(ids, 1, 'up', true)).toEqual({ kind: 'older' });
    expect(stepSelection(ids, 1, 'up', false)).toEqual({ kind: 'none' });
  });
  it('Down past the newest returns to the composer', () => {
    expect(stepSelection(ids, 3, 'down', false)).toEqual({ kind: 'composer' });
  });
  it('an empty stream', () => {
    expect(stepSelection([], null, 'up', false)).toEqual({ kind: 'none' });
    expect(stepSelection([], null, 'down', false)).toEqual({ kind: 'composer' });
  });
});

describe('composerKey', () => {
  const ctx = { draft: '', hasCaptures: true, modalOpen: false };
  const key = (k: string, o: Record<string, boolean | number> = {}) => ({ key: k, ...o });
  it('Enter sends, Shift-Enter is a newline', () => {
    expect(composerKey(key('Enter'), ctx)).toBe('send');
    expect(composerKey(key('Enter', { shiftKey: true }), ctx)).toBe('native');
  });
  it('an IME composition (also Safari keyCode 229) is left alone', () => {
    expect(composerKey(key('Enter', { isComposing: true }), ctx)).toBe('native');
    expect(composerKey(key('Enter', { keyCode: 229 }), ctx)).toBe('native');
  });
  it('a held Enter and Enter behind an overlay do nothing', () => {
    expect(composerKey(key('Enter', { repeat: true }), ctx)).toBe('ignore');
    expect(composerKey(key('Enter'), { ...ctx, modalOpen: true })).toBe('ignore');
  });
  it('Up in an empty composer enters the stream; with text or without captures it is native', () => {
    expect(composerKey(key('ArrowUp'), ctx)).toBe('to-stream');
    expect(composerKey(key('ArrowUp'), { ...ctx, draft: 'abc' })).toBe('native');
    expect(composerKey(key('ArrowUp'), { ...ctx, hasCaptures: false })).toBe('native');
    expect(composerKey(key('ArrowUp'), { ...ctx, modalOpen: true })).toBe('native');
  });
  it('plain Down is native', () => {
    expect(composerKey(key('ArrowDown'), ctx)).toBe('native');
    expect(composerKey(key('ArrowDown'), { ...ctx, draft: 'abc' })).toBe('native');
  });
  it('Option-Up / Option-Down recall, empty or not', () => {
    expect(composerKey(key('ArrowUp', { altKey: true }), ctx)).toBe('recall-older');
    expect(composerKey(key('ArrowDown', { altKey: true }), { ...ctx, draft: 'abc' })).toBe('recall-newer');
    expect(composerKey(key('ArrowUp', { altKey: true }), { ...ctx, modalOpen: true })).toBe('native');
  });
  it('other modifiers keep native behaviour', () => {
    for (const m of ['shiftKey', 'ctrlKey', 'metaKey']) {
      expect(composerKey(key('ArrowUp', { [m]: true }), ctx)).toBe('native');
      expect(composerKey(key('ArrowUp', { [m]: true, altKey: true }), ctx)).toBe('native');
    }
  });
  it('ordinary keys are native', () => {
    expect(composerKey(key('a'), ctx)).toBe('native');
    expect(composerKey(key('ArrowLeft'), ctx)).toBe('native');
  });
});

describe('counter', () => {
  it('appears near the limit and flags text over it; counts code points like the server', () => {
    expect(counterState('short', 100).show).toBe(false);
    expect(counterState('x'.repeat(90), 100)).toEqual({ show: true, over: false, text: '90 / 100' });
    expect(counterState('x'.repeat(101), 100).over).toBe(true);
    expect(countChars('a😀b')).toBe(3);
    expect(counterState('😀'.repeat(60), 100).show).toBe(false); // 60 code points, 120 UTF-16 units
  });
});

describe('list merging', () => {
  it('upsert replaces by id and appends new ones without mutating', () => {
    const a = [cap(1), cap(2)];
    const next = upsertCapture(a, cap(2, { status: 'undone' }));
    expect(next[1]?.status).toBe('undone');
    expect(a[1]?.status).toBe('filed');
    expect(upsertCapture(a, cap(3)).map((c) => c.id)).toEqual([1, 2, 3]);
  });
  it('prependPage puts older captures first and skips duplicates', () => {
    expect(prependPage([cap(3), cap(4)], [cap(1), cap(2), cap(3)]).map((c) => c.id)).toEqual([1, 2, 3, 4]);
  });
  it('mergeLoaded: the loaded copy wins, captures that landed meanwhile are kept, ordered by id', () => {
    const merged = mergeLoaded([cap(1), cap(2, { status: 'undone' })], [cap(2), cap(3)]);
    expect(merged.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(merged[1]?.status).toBe('undone');
  });
});

function mockApi(impl: (path: string) => unknown) {
  const paths: string[] = [];
  const api: CaptureApi = {
    get: async <T>(path: string) => { paths.push(path); return impl(path) as T; },
    post: async <T>() => undefined as T,
  };
  return { api, paths };
}

describe('loadCaptures (mock api)', () => {
  it('requests the newest page and reports hasMore for a full page', async () => {
    const { api, paths } = mockApi(() => ({ captures: Array.from({ length: CAPTURE_PAGE }, (_, i) => cap(i + 1)) }));
    const r = await loadCaptures(api);
    expect(paths).toEqual(['/api/captures?limit=50']);
    expect(r.hasMore).toBe(true);
  });
  it('pages back with before and reports no more for a short page', async () => {
    const { api, paths } = mockApi(() => ({ captures: [cap(1)] }));
    const r = await loadCaptures(api, 42);
    expect(paths).toEqual([capturesPath(42)]);
    expect(paths[0]).toBe('/api/captures?limit=50&before=42');
    expect(r.hasMore).toBe(false);
  });
  it('propagates api errors', async () => {
    const { api } = mockApi(() => { throw new Error('boom'); });
    await expect(loadCaptures(api)).rejects.toThrow('boom');
  });
});

describe('send queue', () => {
  const hooks = (log: string[]) => ({
    onSent: (c: Capture) => { log.push(`sent:${c.text}`); },
    onRejected: (text: string) => { log.push(`rejected:${text}`); },
    onTransient: () => { log.push('transient'); },
    isTransient: (e: unknown) => e instanceof Error && e.message === 'net',
  });
  it('sends in order, one at a time', async () => {
    const q = createSendQueue(); const log: string[] = [];
    q.push('a'); q.push('b');
    await q.drain(async (t) => cap(1, { text: t }), hooks(log));
    expect(log).toEqual(['sent:a', 'sent:b']);
    expect(q.size()).toBe(0);
  });
  it('a rejected text is dropped alone and the rest still go out', async () => {
    const q = createSendQueue(); const log: string[] = [];
    q.push('/todo'); q.push('good');
    await q.drain(async (t) => { if (t === '/todo') throw new Error('400'); return cap(1, { text: t }); }, hooks(log));
    expect(log).toEqual(['rejected:/todo', 'sent:good']);
  });
  it('a transient failure keeps everything queued in order', async () => {
    const q = createSendQueue(); const log: string[] = [];
    q.push('a'); q.push('b');
    await q.drain(async () => { throw new Error('net'); }, hooks(log));
    expect(log).toEqual(['transient']);
    expect(q.texts()).toEqual(['a', 'b']);
  });
  it('a late response from before a reset does not delete the newest queued text', async () => {
    const q = createSendQueue(); const log: string[] = [];
    let release!: (c: Capture) => void;
    const slow = new Promise<Capture>((r) => { release = r; });
    q.push('A');
    const old = q.drain(() => slow, hooks(log));       // A in flight
    q.reset();                                          // logout
    q.push('X');                                        // new session submits X
    release(cap(1, { text: 'A' }));                     // A's response arrives late
    await old;
    expect(q.texts()).toEqual(['X']);
    expect(log).toEqual([]);                            // the old drain stopped without reporting
    // a new drain is not blocked by the old one and sends X
    await q.drain(async (t) => cap(2, { text: t }), hooks(log));
    expect(log).toEqual(['sent:X']);
    expect(q.size()).toBe(0);
  });
  it('a drain started while another is running does nothing', async () => {
    const q = createSendQueue(); const log: string[] = [];
    let release!: (c: Capture) => void;
    q.push('a');
    const first = q.drain(() => new Promise<Capture>((r) => { release = r; }), hooks(log));
    await q.drain(async () => { throw new Error('should not run'); }, hooks(log));
    release(cap(1, { text: 'a' }));
    await first;
    expect(log).toEqual(['sent:a']);
  });
  it('isDraining is true while a request is in flight and false after, also after a transient stop', async () => {
    const q = createSendQueue(); const log: string[] = [];
    let release!: (c: Capture) => void;
    q.push('a');
    expect(q.isDraining()).toBe(false);
    const d = q.drain(() => new Promise<Capture>((r) => { release = r; }), hooks(log));
    expect(q.isDraining()).toBe(true);
    release(cap(1, { text: 'a' }));
    await d;
    expect(q.isDraining()).toBe(false);
    q.push('b');
    await q.drain(async () => { throw new Error('net'); }, hooks(log));
    expect(q.isDraining()).toBe(false);
    expect(q.size()).toBe(1);
  });
  it('two fast submits land in order', async () => {
    const q = createSendQueue(); const log: string[] = [];
    const first = (async () => { q.push('one'); await q.drain(async (t) => { await Promise.resolve(); return cap(1, { text: t }); }, hooks(log)); })();
    q.push('two'); // queued behind the one in flight
    await q.drain(async (t) => cap(2, { text: t }), hooks(log)); // a second drain while the first runs does nothing
    await first;
    expect(log).toEqual(['sent:one', 'sent:two']);
  });
});

describe('send queue source', () => {
  it('each entry carries its own source to send and to onRejected', async () => {
    const q = createSendQueue(); const seen: string[] = [];
    q.push('typed'); q.push('spoken', 'voice'); q.push('bad', 'voice');
    await q.drain(async (t, source) => {
      seen.push(`${t}:${source}`);
      if (t === 'bad') throw new Error('400');
      return cap(1, { text: t });
    }, {
      onSent: () => {}, onTransient: () => {}, isTransient: () => false,
      onRejected: (t, _e, source) => { seen.push(`rejected:${t}:${source}`); },
    });
    expect(seen).toEqual(['typed:text', 'spoken:voice', 'bad:voice', 'rejected:bad:voice']);
  });
});

describe('landed feed (Stream remount)', () => {
  it('a send started by one Stream lands in the feed for the next one', async () => {
    const q = createSendQueue(); const feed = createLandedFeed();
    let release!: (c: Capture) => void;
    q.push('slow');
    const drain = q.drain(() => new Promise<Capture>((r) => { release = r; }), {
      onSent: (c) => feed.push(c, 1), onRejected: () => {}, onTransient: () => {}, isTransient: () => false,
    });
    expect(feed.take(1)).toEqual([]);
    release(cap(7, { text: 'slow' }));
    await drain;
    expect(feed.take(1).map((c) => c.id)).toEqual([7]);
    expect(feed.take(1)).toEqual([]); // consumed once
  });
  it('drops entries from an earlier session epoch and on clear', () => {
    const feed = createLandedFeed();
    feed.push(cap(1), 1); feed.push(cap(2), 2); feed.push(cap(3), 2);
    expect(feed.take(2).map((c) => c.id)).toEqual([2, 3]);
    feed.push(cap(4), 2);
    feed.clear();
    expect(feed.take(2)).toEqual([]);
    feed.push(cap(5), 1);
    expect(feed.take(2)).toEqual([]);
    expect(feed.size()).toBe(0);
  });
});

describe('input history', () => {
  const texts = ['one', 'two', 'three'];
  it('skips blanked (deleted) captures', () => {
    expect(historyTexts([cap(1, { text: 'a' }), cap(2, { text: '' }), cap(3, { text: 'c' })])).toEqual(['a', 'c']);
  });
  it('up from the end recalls the last text, then older, stopping at the oldest', () => {
    const a = recallStep(texts, texts.length, 'up');
    expect(a).toEqual({ cursor: 2, text: 'three' });
    expect(recallStep(texts, a.cursor, 'up')).toEqual({ cursor: 1, text: 'two' });
    expect(recallStep(texts, 0, 'up')).toEqual({ cursor: 0, text: 'one' });
  });
  it('down moves forward and past the end gives an empty line', () => {
    expect(recallStep(texts, 1, 'down')).toEqual({ cursor: 2, text: 'three' });
    expect(recallStep(texts, 2, 'down')).toEqual({ cursor: 3, text: '' });
    expect(recallStep(texts, 3, 'down')).toEqual({ cursor: 3, text: '' });
  });
  it('empty history', () => {
    expect(recallStep([], 0, 'up')).toEqual({ cursor: 0, text: '' });
  });
});

describe('recallNext (Option-up / Option-down)', () => {
  const texts = ['one', 'two', 'three'];
  const up = (pos: RecallPos | null, draft: string, stash: Stash | null = null, src: 'text' | 'voice' = 'text') =>
    recallNext(texts, pos, draft, src, stash, 'up');
  const down = (pos: RecallPos | null, draft: string, stash: Stash | null = null) => recallNext(texts, pos, draft, 'text', stash, 'down');

  it('walks up and back down to empty', () => {
    const a = up(null, '');
    expect(a).toEqual({ pos: { cursor: 2, text: 'three' }, text: 'three', source: 'text', stash: null });
    const b = up(a.pos, a.text);
    expect(b.text).toBe('two');
    const c = down(b.pos, b.text);
    const d = down(c.pos, c.text);
    expect(d).toEqual({ pos: null, text: '', source: 'text', stash: null });
  });

  it('recalls over typed text without losing it', () => {
    const a = up(null, 'half typed');
    expect(a.text).toBe('three');
    expect(a.stash).toEqual({ text: 'half typed', source: 'text' });
    const b = down(a.pos, a.text, a.stash);
    expect(b).toEqual({ pos: null, text: 'half typed', source: 'text', stash: null });
  });

  it('keeps the stash source: a dictated stash comes back as voice', () => {
    const a = up(null, 'call Anna', null, 'voice');
    expect(a.source).toBe('text');
    expect(a.stash).toEqual({ text: 'call Anna', source: 'voice' });
    expect(down(a.pos, a.text, a.stash)).toMatchObject({ text: 'call Anna', source: 'voice', stash: null });
  });

  it('editing a recalled line never overwrites the stash', () => {
    const a = up(null, 'mine');
    const b = up(a.pos, 'three!', a.stash); // edited after the recall: not recalling any more
    expect(b.stash).toEqual({ text: 'mine', source: 'text' });
    expect(b.text).toBe('three'); // starts again from the newest
    expect(down(b.pos, b.text, b.stash).text).toBe('mine');
  });

  it('a stash survives a remount (no position) and is restored by stepping down', () => {
    const stash: Stash = { text: 'mine', source: 'text' };
    expect(up(null, 'three', stash).stash).toEqual(stash);
    expect(down(null, 'three', stash)).toEqual({ pos: null, text: 'mine', source: 'text', stash: null });
  });

  it('after a restore, typed text is stashed again by the next recall', () => {
    const a = up(null, 'mine');
    const r = down(a.pos, a.text, a.stash);
    expect(r.pos).toBeNull();
    expect(up(r.pos, r.text).stash).toEqual({ text: 'mine', source: 'text' });
  });

  it('no history leaves the draft alone', () => {
    expect(recallNext([], null, 'abc', 'text', null, 'up').text).toBe('abc');
    expect(recallNext([], null, '', 'text', null, 'down').text).toBe('');
  });
});

describe('question answering: replies and chips', () => {
  const askedCap = cap(20, { status: 'asked', filed: [], draft: draftOf({ kind: 'question' }) });
  const answer = (over: Partial<CaptureAnswer> = {}): CaptureAnswer => ({
    text: 'Found 2 item(s): Budget, Call', redacted: false,
    sources: [{ kind: 'note', id: 3, title: 'Budget' }, { kind: 'action', id: 4, title: 'Call Anna' }], ...over,
  });
  const answeredCap = (a: CaptureAnswer | null) => cap(21, { status: 'answered', filed: [], answer: a });

  it('asked: Answer, File instead, Discard; Retry after a failure; none while asking', () => {
    expect(chipsFor(askedCap).map((c) => c.label)).toEqual(['Answer', 'File instead', 'Discard']);
    expect(chipsFor(askedCap).map((c) => c.kind)).toEqual(['ask', 'reclassify', 'undo']);
    expect(chipsFor(askedCap, { phase: 'failed', failure: 'failed', retryAfter: null })[0]?.label).toBe('Retry');
    expect(chipsFor(askedCap, { phase: 'asking' })).toEqual([]);
    expect(defaultChipId(askedCap)).toBeNull(); // no default: Enter never asks by accident
  });
  it('a question that is gone on the server does not offer Retry', () => {
    expect(chipsFor(askedCap, askFailureOf({ status: 409, code: 'not_asked' })).map((c) => c.label)).toEqual(['File instead', 'Discard']);
  });
  it('asked replies: idle, asking, failed (with Retry-After)', () => {
    expect(replyFor(askedCap, lookups).tone).toBe('asked');
    expect(replyFor(askedCap, { ...lookups, ask: () => ({ phase: 'asking' }) })).toEqual({ tone: 'asking', segments: [{ text: 'Looking through your data…' }] });
    const failed = replyFor(askedCap, { ...lookups, ask: () => ({ phase: 'failed', failure: 'rate_limited', retryAfter: 12 }) });
    expect(failed.tone).toBe('failed');
    expect(replyText(failed)).toContain('12 s');
  });
  it('answered: the answer is one plain-text segment, sources are chips, Delete answer last', () => {
    const c = answeredCap(answer({ text: '<img src=x onerror=alert(1)>' }));
    const r = replyFor(c, lookups);
    expect(r.tone).toBe('answer');
    expect(r.segments).toEqual([{ text: '<img src=x onerror=alert(1)>' }]); // no ref: never a link, rendered as a text node
    const chips = chipsFor(c);
    expect(chips.map((x) => x.label)).toEqual(['Budget', 'Call Anna', 'Delete answer']);
    expect(chips.map((x) => x.kind)).toEqual(['source', 'source', 'undo']);
    expect(chips[0]?.ref).toEqual({ kind: 'note', id: 3 });
    expect(defaultChipId(c)).toBe('src:note:3'); // Enter opens the first source
  });
  it('no matches is its own state, with only Delete answer', () => {
    const c = answeredCap(answer({ text: NO_MATCH_TEXT, sources: [] }));
    expect(replyFor(c, lookups).tone).toBe('nomatch');
    expect(chipsFor(c).map((x) => x.label)).toEqual(['Delete answer']);
    expect(defaultChipId(c)).toBeNull();
  });
  it('a model answer that merely repeats the fixed text but cites sources is a normal answer', () => {
    expect(replyFor(answeredCap(answer({ text: NO_MATCH_TEXT })), lookups).tone).toBe('answer');
  });
  it('redacted (and a missing answer) shows as removed, no text, no sources', () => {
    for (const a of [{ text: '', sources: [], redacted: true }, null]) {
      const c = answeredCap(a);
      const r = replyFor(c, lookups);
      expect(r.tone).toBe('removed');
      expect(replyText(r)).toContain('removed');
      expect(chipsFor(c).map((x) => x.label)).toEqual(['Delete answer']);
    }
  });
  it('a redacted answer ignores any sources that came with it', () => {
    expect(sourceChips(answeredCap(answer({ redacted: true })))).toEqual([]);
  });
  it('source refs: notes, people, projects and meetings open themselves; actions and agenda open a list; bad ids none', () => {
    expect(sourceRef({ kind: 'meeting', id: 5, title: 'm' })).toEqual({ kind: 'meeting', id: 5 });
    expect(sourceRef({ kind: 'project', id: 2, title: 'p' })).toEqual({ kind: 'project', id: 2 });
    expect(sourceRef({ kind: 'person', id: 2, title: 'p' })).toEqual({ kind: 'person', id: 2 });
    expect(sourceRef({ kind: 'action', id: 2, title: 'a' })).toEqual({ kind: 'actions' });
    expect(sourceRef({ kind: 'agenda', id: 2, title: 'a' })).toEqual({ kind: 'people' });
    expect(sourceRef({ kind: 'note', id: 0, title: 'n' })).toBeNull();
    expect(sourceRef({ kind: 'note', id: -1, title: 'n' })).toBeNull();
  });
  it('duplicate sources show once; long and empty titles are handled', () => {
    const long = 'x'.repeat(200);
    const c = answeredCap(answer({ sources: [
      { kind: 'note', id: 3, title: 'A' }, { kind: 'note', id: 3, title: 'A' }, { kind: 'note', id: 4, title: long }, { kind: 'note', id: 5, title: '  ' },
    ] }));
    const labels = sourceChips(c).map((x) => x.label);
    expect(labels).toHaveLength(3);
    expect(Array.from(labels[1]!).length).toBeLessThanOrEqual(60);
    expect(labels[2]).toBe('(note)');
  });
  it('the unsure kind question offers "Answer it" as an answer chip', () => {
    const q: CaptureQuestion = { type: 'kind', options: [{ key: 'n', label: 'note' }, { key: 'q', label: 'Answer it' }, { key: 'd', label: 'discard' }] };
    const chips = chipsFor(pending(22, q));
    expect(chips.find((c) => c.label === 'Answer it')?.answer).toEqual({ key: 'q' });
  });
  it('a deleted capture has no chips even when it was asked', () => {
    expect(chipsFor({ ...askedCap, deleted: true })).toEqual([]);
  });
  it('failure classes and messages', () => {
    expect(askFailureOf({ status: 502, code: 'llm_failed' }).failure).toBe('failed');
    expect(askFailureOf({ status: 503, code: 'no_llm' }).failure).toBe('no_llm');
    expect(askFailureOf({ status: 429, code: 'busy', retryAfter: 5 })).toEqual({ phase: 'failed', failure: 'busy', retryAfter: 5 });
    expect(askFailureOf({ status: 429, code: 'rate_limited' }).failure).toBe('rate_limited');
    expect(askFailureOf({ status: 404 }).failure).toBe('gone');
    expect(askFailureOf({ status: 0 }).failure).toBe('network');
    expect(askFailureOf(new Error('x')).failure).toBe('other');
    expect(askFailureMessage(askFailureOf({ status: 503 }))).toContain('not set up');
  });
});

describe('upsertLanded', () => {
  it('a stale asked copy never replaces the answered capture', () => {
    const answered = cap(30, { status: 'answered', filed: [], answer: { text: 'a', sources: [], redacted: false } });
    const stale = cap(30, { status: 'asked', filed: [] });
    expect(upsertLanded([answered], stale)).toEqual([answered]);
  });
  it('otherwise it behaves like upsertCapture', () => {
    const asked = cap(31, { status: 'asked', filed: [] });
    const answered = cap(31, { status: 'answered', filed: [], answer: { text: 'a', sources: [], redacted: false } });
    expect(upsertLanded([asked], answered)).toEqual([answered]);
    expect(upsertLanded([], asked)).toEqual([asked]);
  });
});

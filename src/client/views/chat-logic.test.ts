import { describe, expect, it } from 'vitest';
import type { SearchHit } from '../../shared/api.ts';
import type { Action, Capture, CaptureQuestion } from '../../shared/types.ts';
import type { CaptureApi, RecallPos, Stash } from './chat-logic.ts';
import {
  answerForKey, capturesPath, downAction, highlightKeys, inputArrow, recallNext, stepOption, createLandedFeed, createSendQueue, describeResult, filedTarget, groupActions, hitTarget, historyTexts, loadCaptures,
  oldestId, openTarget, prependPage, questionChoices, questionKeys, questionPrompt, questionTarget, recallStep,
  searchTerm, upsertCapture, CAPTURE_PAGE, shortDate,
} from './chat-logic.ts';

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
const needsQ: CaptureQuestion = { type: 'needs_person', options: [{ key: 'p', label: 'pick' }, { key: 'd', label: 'discard' }] };

function cap(id: number, over: Partial<Capture> = {}): Capture {
  return {
    id, text: `text ${id}`, source: 'text', status: 'filed',
    draft: { kind: 'note', text: `text ${id}`, personId: null, personName: null, owner: 'me' },
    question: null, filed: [{ kind: 'note', id: 10 + id }], summary: 'Note: x', classifiedBy: 'llm', deleted: false,
    createdAt: '2026-11-15T10:00:00.000Z', ...over,
  };
}
const pending = (id: number, q: CaptureQuestion = kindQ) => cap(id, { status: 'pending', question: q, filed: [], summary: '' });

describe('question keys and answers', () => {
  it('lists option keys, plus candidate keys for ambiguous people', () => {
    expect(questionKeys(kindQ)).toEqual(['n', 't', 'a', 'd']);
    expect(questionKeys(ambiguousQ)).toEqual(['s', 'd', '1', '2']);
  });
  it('maps a key to { key }', () => {
    expect(answerForKey(kindQ, 'n')).toEqual({ kind: 'answer', body: { key: 'n' } });
    expect(answerForKey(ambiguousQ, '2')).toEqual({ kind: 'answer', body: { key: '2' } });
    expect(answerForKey(unknownQ, 'c')).toEqual({ kind: 'answer', body: { key: 'c' } });
  });
  it('opens the picker for p on unknown_person and needs_person only', () => {
    expect(answerForKey(unknownQ, 'p')).toEqual({ kind: 'pick' });
    expect(answerForKey(needsQ, 'p')).toEqual({ kind: 'pick' });
    expect(answerForKey(kindQ, 'p')).toBeNull();
  });
  it('rejects keys that are not part of the question', () => {
    expect(answerForKey(kindQ, 'x')).toBeNull();
    expect(answerForKey(kindQ, 'N')).toBeNull();
    expect(answerForKey(ambiguousQ, '3')).toBeNull();
  });
  it('never binds multi-character or odd server-supplied keys', () => {
    const q: CaptureQuestion = { type: 'kind', options: [{ key: 'ctrl+x', label: 'x' }, { key: '', label: 'e' }, { key: ' ', label: 's' }, { key: 'n', label: 'note' }] };
    expect(questionKeys(q)).toEqual(['n']);
  });
  it('renders candidates before options as choices', () => {
    expect(questionChoices(ambiguousQ).map((c) => c.key)).toEqual(['1', '2', 's', 'd']);
    expect(questionChoices(ambiguousQ)[0]?.label).toBe('Anna Berg');
  });
  it('prompts are plain text containing the name as given', () => {
    expect(questionPrompt(unknownQ)).toBe('Unknown person "Bob".');
    expect(questionPrompt({ ...unknownQ, name: '<b>x</b>' })).toContain('<b>x</b>');
  });
});

describe('one-candidate ambiguous_person (LLM-suggested name)', () => {
  const q: CaptureQuestion = {
    type: 'ambiguous_person', name: 'Anna', candidates: [{ key: '1', personId: 4, name: 'Anna Berg' }],
    options: [{ key: 's', label: 'skip' }, { key: 'd', label: 'discard' }],
  };
  it('renders the candidate with the options and binds its key', () => {
    expect(questionChoices(q)).toEqual([
      { key: '1', label: 'Anna Berg' }, { key: 's', label: 'skip' }, { key: 'd', label: 'discard' },
    ]);
    expect(questionKeys(q)).toEqual(['s', 'd', '1']);
  });
  it('answers the candidate key as { key }, skip and discard likewise, anything else is ignored', () => {
    expect(answerForKey(q, '1')).toEqual({ kind: 'answer', body: { key: '1' } });
    expect(answerForKey(q, 's')).toEqual({ kind: 'answer', body: { key: 's' } });
    expect(answerForKey(q, 'd')).toEqual({ kind: 'answer', body: { key: 'd' } });
    expect(answerForKey(q, '2')).toBeNull();
    expect(answerForKey(q, 'p')).toBeNull();
  });
  it('shows a prompt naming the person', () => {
    expect(questionPrompt(q)).toBe('Which "Anna"?');
  });
});

describe('questionTarget', () => {
  it('prefers the selected pending capture, else the newest pending one', () => {
    const list = [pending(1), cap(2), pending(3, unknownQ)];
    expect(questionTarget(list, 1)?.id).toBe(1);
    expect(questionTarget(list, 2)?.id).toBe(3);
    expect(questionTarget(list, null)?.id).toBe(3);
  });
  it('is null when nothing is pending', () => {
    expect(questionTarget([cap(1), cap(2, { status: 'undone' })], null)).toBeNull();
    expect(questionTarget([], null)).toBeNull();
  });
});

describe('describeResult', () => {
  it('filed: arrow summary and key hints', () => {
    const r = describeResult(cap(1, { summary: 'Action (me) · Anna: send budget' }));
    expect(r.text).toBe('→ Action (me) · Anna: send budget');
    expect(r.hint).toContain('[u] undo');
    expect(r.hint).toContain('[r] reclassify');
  });
  it('other statuses', () => {
    expect(describeResult(cap(1, { status: 'undone' })).tone).toBe('undone');
    expect(describeResult(cap(1, { status: 'discarded' })).tone).toBe('discarded');
    expect(describeResult(pending(1)).text).toContain('What is this?');
  });
  it('a capture flagged deleted is a deleted marker without hints; empty text alone is not', () => {
    const del = cap(1, { status: 'undone', text: '', summary: '(deleted)', filed: [], deleted: true });
    const r = describeResult(del);
    expect(r.tone).toBe('deleted');
    expect(r.hint).toBe('');
    expect(describeResult(cap(2, { text: '', summary: '' })).tone).toBe('filed');
  });
});

describe('openTarget / filedTarget', () => {
  it('notes open the note, actions the list, persons their page', () => {
    expect(openTarget(cap(1))).toBe('/notes/11');
    expect(openTarget(cap(1, { filed: [{ kind: 'action', id: 3 }] }))).toBe('/actions');
    expect(openTarget(cap(1, { filed: [{ kind: 'person', id: 7 }] }))).toBe('/people/7');
  });
  it('agenda opens the linked person; person ref is used when the draft has none', () => {
    const agenda = cap(1, { filed: [{ kind: 'agenda', id: 2 }], draft: { kind: 'agenda', text: 'x', personId: 5, personName: null, owner: 'me' } });
    expect(openTarget(agenda)).toBe('/people/5');
    expect(openTarget({ ...agenda, draft: { ...agenda.draft, personId: null }, filed: [{ kind: 'person', id: 8 }, { kind: 'agenda', id: 2 }] })).toBe('/people/8');
    expect(openTarget({ ...agenda, draft: { ...agenda.draft, personId: null } })).toBeNull();
  });
  it('is null for non-filed captures and bad ids', () => {
    expect(openTarget(pending(1))).toBeNull();
    expect(openTarget(cap(1, { filed: [{ kind: 'note', id: -1 }] }))).toBeNull();
    expect(openTarget(cap(1, { filed: [] }))).toBeNull();
  });
  it('undo target: only the selected capture, never a fallback to an older filed one', () => {
    const list = [cap(1), cap(2, { status: 'undone' }), cap(3), cap(4, { deleted: true })];
    expect(filedTarget(list, 1)?.id).toBe(1);
    expect(filedTarget(list, 2)).toBeNull();
    expect(filedTarget(list, 4)).toBeNull();
    expect(filedTarget(list, null)).toBeNull();
    expect(filedTarget(list, 99)).toBeNull();
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

describe('landed feed (Chat remount)', () => {
  it('a send started by one Chat lands in the feed for the next one', async () => {
    const q = createSendQueue(); const feed = createLandedFeed();
    let release!: (c: Capture) => void;
    q.push('slow');
    const drain = q.drain(() => new Promise<Capture>((r) => { release = r; }), {
      onSent: (c) => feed.push(c, 1), onRejected: () => {}, onTransient: () => {}, isTransient: () => false,
    });
    // the Chat that started the drain unmounts and a new one mounts: nothing to take yet
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

function action(id: number, over: Partial<Action> = {}): Action {
  return { id, text: `a${id}`, owner: 'me', status: 'open', personId: null, meetingId: null, createdAt: '2026-11-15T10:00:00.000Z', doneAt: null, ...over };
}

describe('groupActions', () => {
  it('orders Mine, Waiting for, Done with a header on each group start', () => {
    const rows = groupActions([
      action(1, { owner: 'them' }), action(2), action(3, { status: 'done', doneAt: 'x' }), action(4),
    ]);
    expect(rows.map((r) => r.id)).toEqual([2, 4, 1, 3]);
    expect(rows.map((r) => r.header)).toEqual(['Mine (2)', null, 'Waiting for (1)', 'Done (1)']);
  });
  it('omits empty groups', () => {
    expect(groupActions([])).toEqual([]);
    expect(groupActions([action(1)]).map((r) => r.header)).toEqual(['Mine (1)']);
  });
  it('oldestId is the paging cursor', () => {
    expect(oldestId([{ id: 9 }, { id: 3 }, { id: 5 }])).toBe(3);
    expect(oldestId([])).toBeUndefined();
  });
});

describe('search helpers', () => {
  it('needs two characters after trimming', () => {
    expect(searchTerm('')).toBeNull();
    expect(searchTerm(' a ')).toBeNull();
    expect(searchTerm(' ab ')).toBe('ab');
    expect(searchTerm('å')).toBeNull();
  });
  const hit = (over: Partial<SearchHit>): SearchHit => ({ kind: 'note', id: 3, title: 't', snippet: '', personId: null, archived: false, ...over });
  it('routes each hit kind', () => {
    expect(hitTarget(hit({}))).toBe('/notes/3');
    expect(hitTarget(hit({ kind: 'person', id: 4 }))).toBe('/people/4');
    expect(hitTarget(hit({ kind: 'meeting', id: 5 }))).toBe('/meetings/5');
    expect(hitTarget(hit({ kind: 'action' }))).toBe('/actions');
    expect(hitTarget(hit({ kind: 'agenda', personId: 6 }))).toBe('/people/6');
    expect(hitTarget(hit({ kind: 'agenda', personId: null }))).toBeNull();
  });
  it('refuses malformed ids so a hostile id never becomes a path', () => {
    expect(hitTarget(hit({ id: -1 }))).toBeNull();
    expect(hitTarget(hit({ kind: 'person', id: 1.5 }))).toBeNull();
  });
  it('shortDate', () => {
    expect(shortDate('2026-11-15T10:00:00Z')).toBe('2026-11-15');
    expect(shortDate('garbage')).toBe('');
  });
});

describe('arrow navigation: answer highlight', () => {
  it('lists the options in display order (candidates first), pressable keys only', () => {
    expect(highlightKeys(kindQ)).toEqual(['n', 't', 'a', 'd']);
    expect(highlightKeys(ambiguousQ)).toEqual(['1', '2', 's', 'd']);
    const odd: CaptureQuestion = { type: 'kind', options: [{ key: 'ab', label: 'x' }, { key: 'n', label: 'note' }] };
    expect(highlightKeys(odd)).toEqual(['n']);
  });

  it('steps right/left and clamps at the ends', () => {
    const keys = ['n', 't', 'a'];
    expect(stepOption(keys, null, 'right')).toBe('n');
    expect(stepOption(keys, null, 'left')).toBe('a');
    expect(stepOption(keys, 'n', 'right')).toBe('t');
    expect(stepOption(keys, 'a', 'right')).toBe('a');
    expect(stepOption(keys, 't', 'left')).toBe('n');
    expect(stepOption(keys, 'n', 'left')).toBe('n');
  });

  it('a stale highlight starts over; no options gives null', () => {
    expect(stepOption(['n', 't'], 'zz', 'right')).toBe('n');
    expect(stepOption([], null, 'right')).toBeNull();
  });
});

describe('arrow navigation: chat input', () => {
  const base = { dir: 'up' as const, ctrl: false, shift: false, alt: false, meta: false, draft: '', hasCaptures: true };
  it('plain up in an empty input leaves it', () => {
    expect(inputArrow(base)).toBe('leave');
  });
  it('plain up with no captures, or with text, stays native', () => {
    expect(inputArrow({ ...base, hasCaptures: false })).toBe('native');
    expect(inputArrow({ ...base, draft: 'abc' })).toBe('native');
  });
  it('plain down is native, empty or not', () => {
    expect(inputArrow({ ...base, dir: 'down' })).toBe('native');
    expect(inputArrow({ ...base, dir: 'down', draft: 'abc' })).toBe('native');
  });
  it('alt up/down recall, empty or not', () => {
    expect(inputArrow({ ...base, alt: true })).toBe('recall');
    expect(inputArrow({ ...base, alt: true, dir: 'down', draft: 'abc' })).toBe('recall');
  });
  it('other modifiers keep native behaviour', () => {
    expect(inputArrow({ ...base, shift: true })).toBe('native');
    expect(inputArrow({ ...base, ctrl: true })).toBe('native');
    expect(inputArrow({ ...base, alt: true, ctrl: true })).toBe('native');
    expect(inputArrow({ ...base, meta: true })).toBe('native');
  });
  it('down on the newest capture (or none) returns to the input', () => {
    expect(downAction(2, 3)).toBe('input');
    expect(downAction(0, 0)).toBe('input');
    expect(downAction(1, 3)).toBe('move');
  });
});

describe('recallNext (Alt-up / Alt-down)', () => {
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

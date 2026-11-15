import { effect, signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { LIMITS } from '../../shared/api.ts';
import type { AnswerCaptureRequest, CreateCaptureRequest } from '../../shared/api.ts';
import type { Capture } from '../../shared/types.ts';
import { Pane } from '../components/Pane.tsx';
import { api, ApiError } from '../lib/api.ts';
import { composing, modalOpen, mode, useKeys } from '../lib/keys.ts';
import type { KeyHandler } from '../lib/keys.ts';
import { navigate } from '../lib/router.ts';
import {
  chatDraft, chatDraftSource, chatStash, editChatDraft, epoch, errorText, flash, pickPerson, personPicker, prependChatDraft, refreshPeople, requestFocus, restoreChatDraft, session, shellActive, takeChatStash, useFocusRequest,
} from '../lib/store.ts';
import {
  answerForKey, createLandedFeed, createSendQueue, describeResult, downAction, filedPerson, filedTarget, formatTime, highlightKeys, historyTexts,
  inputArrow, loadCaptures, openTarget, optionLabel, prependPage, questionChoices, questionKeys, questionTarget, recallNext, stepOption,
  upsertCapture,
} from './chat-logic.ts';
import type { CaptureSource, RecallPos } from './chat-logic.ts';

// Unsent texts live at module level, so they survive the view unmounting on a 401 and go out in order
// after re-login (the remounted Chat drains them). A status-0 retry may duplicate a capture the server
// did receive; that is accepted.
export const sendQueue = createSendQueue(); // exported for tests
// Captures that landed from a send. The Chat that is mounted (not necessarily the one that started the
// drain) consumes them, so a capture whose send finished after the user left and came back still shows.
export const landed = createLandedFeed();
const landedTick = signal(0);
// An explicit logout wipes unsent texts like every other draft (a 401 alone keeps shellActive true) and
// invalidates any drain still waiting on a response.
effect(() => { if (!shellActive.value) sendQueue.reset(); });
// Any session end (401 lock included) drops landed captures: they are server data and must not reappear
// after re-login. The send queue is NOT reset here; queued texts survive a 401.
effect(() => { if (session.value === null) landed.clear(); });

/** Chat: capture log + input line. Classification questions are answered with a single key. */
export default function Chat() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [selId, setSelId] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const recall = useRef<RecallPos | null>(null);
  // Answer option highlighted with ←/→ (Enter picks it). Tied to one capture; stale values are ignored.
  const [hl, setHl] = useState<{ id: number; key: string } | null>(null);
  const capsRef = useRef(captures);
  capsRef.current = captures;

  useFocusRequest('chat', () => input.current);
  // Arriving in Chat always lands in the input, so stray typing never acts as commands. Question keys
  // become live when the user leaves the input (Esc) or selects a capture.
  useLayoutEffect(() => { input.current?.focus(); }, []);

  // Show captures that landed from a send, whichever Chat started it. Runs on mount (leftovers) and on
  // every landing; the feed drops entries from an earlier session (epoch guard).
  useEffect(() => effect(() => {
    void landedTick.value;
    const cs = landed.take(epoch());
    const last = cs[cs.length - 1];
    if (!last || !alive.current) return;
    setCaptures((cur) => cs.reduce(upsertCapture, cur));
    setSelId(last.id);
  }), []);

  // Initial load: a plain GET (no state change on route load).
  useEffect(() => {
    alive.current = true;
    const e = epoch();
    loadCaptures(api).then((page) => {
      if (e !== epoch() || !alive.current) return;
      setCaptures((cur) => prependPage(cur, page.captures));
      setHasMore(page.hasMore);
      setLoaded(true);
    }).catch((err) => {
      if (e !== epoch() || !alive.current) return;
      setLoaded(true);
      flash(`Could not load chat: ${errorText(err)}`, 'error');
    });
    if (sendQueue.size() > 0 && session.peek() !== null) void drain(); // texts left over from before a 401
    return () => { alive.current = false; };
  }, []);

  const selected = captures.find((c) => c.id === selId) ?? captures[captures.length - 1] ?? null;
  const target = questionTarget(captures, selected?.id ?? null);
  // ←/→ and Enter-to-answer apply only while the selected capture itself holds the live question.
  const liveSel = selected && target && target.id === selected.id && target.question ? target : null;
  const optionKeys = liveSel?.question ? highlightKeys(liveSel.question) : [];
  const hlKey = hl && liveSel && hl.id === liveSel.id && optionKeys.includes(hl.key) ? hl.key : null;
  const log = useRef<HTMLDivElement>(null);
  // The highlight belongs to one live question on one selected capture: drop it when either changes.
  const questionSig = liveSel?.question ? `${liveSel.id}:${optionKeys.join('')}` : '';
  useLayoutEffect(() => { setHl(null); }, [selected?.id, questionSig]); // layout: must land before the next key

  // Keep the selected row in view (new captures become the selection, so the log follows the newest).
  useEffect(() => {
    log.current?.querySelector('.row.selected')?.scrollIntoView?.({ block: 'nearest' });
  }, [selected?.id, loaded]);

  /** One answer/undo/reclassify at a time. Independent of the submit queue, so neither blocks the other. */
  async function run(id: number, op: () => Promise<Capture>, after?: (c: Capture) => void): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    const e = epoch();
    try {
      const c = await op();
      if (e !== epoch()) return;
      if (alive.current) { setCaptures((cur) => upsertCapture(cur, c)); setSelId(c.id); }
      if (filedPerson(c)) void refreshPeople();
      after?.(c);
    } catch (err) {
      if (e !== epoch()) return;
      if (err instanceof ApiError && err.status === 409) {
        flash(err.code === 'gone' ? 'That item was already deleted; reloaded.' : 'That capture changed in the meantime; reloaded.', 'error');
        void reload(id);
      } else {
        flash(errorText(err), 'error');
      }
    } finally {
      busy.current = false;
    }
  }

  /** Re-read the page that contains capture `id` (before = id + 1) and merge it. */
  async function reload(id: number): Promise<void> {
    const e = epoch();
    try {
      const page = await loadCaptures(api, id + 1);
      if (e !== epoch() || !alive.current) return;
      setCaptures((cur) => page.captures.reduce(upsertCapture, cur));
    } catch { /* the flash above already told the user */ }
  }

  /** Put unsent text back without ever overwriting what the user has typed since. */
  function restore(text: string, err: unknown, source: CaptureSource): void {
    if (chatDraft.peek() === '') {
      restoreChatDraft(text, source);
      flash(`Not sent: ${errorText(err)}`, 'error');
    } else {
      const snippet = text.length > 40 ? `${text.slice(0, 40)}…` : text;
      flash(`Not sent (${errorText(err)}): "${snippet}"`, 'error', {
        sticky: true,
        action: { label: 'restore', run: () => { prependChatDraft(text, source); } },
      });
    }
  }

  /** Enter: snapshot the text and clear the input at once; sends happen in order, one at a time. */
  function submit(): void {
    const text = chatDraft.peek().trim();
    if (!text) return;
    const source = chatDraftSource.peek();
    chatDraft.value = '';
    recall.current = null;
    takeChatStash(); // text typed before a recall comes back after the send
    sendQueue.push(text, source);
    void drain();
  }

  async function drain(): Promise<void> {
    const e = epoch();
    await sendQueue.drain((text, source) => api.post<Capture>('/api/captures', { text, source } satisfies CreateCaptureRequest), {
      isTransient: (err) => err instanceof ApiError && (err.status === 0 || err.status === 401 || err.status === 429),
      onTransient: (err, waiting) => {
        // Session or network trouble: everything stays queued, in order, with a retry.
        if (session.peek() !== null) {
          flash(`Not sent (${errorText(err)}); ${waiting} waiting.`, 'error', { sticky: true, action: { label: 'retry', run: () => { void drain(); } } });
        }
      },
      // Nothing was written for this text: give it back and carry on with the rest.
      onRejected: (text, err, source) => restore(text, err, source),
      onSent: (c) => {
        if (e !== epoch()) return; // session ended meanwhile; the next send stops and keeps its text
        landed.push(c, e);
        landedTick.value++;
        if (filedPerson(c)) void refreshPeople();
      },
    });
  }

  function answer(c: Capture, body: AnswerCaptureRequest): void {
    void run(c.id, () => api.post<Capture>(`/api/captures/${c.id}/answer`, body), (r) => {
      // This capture is done (filed or discarded): back to typing, so stray keys can't act as commands on
      // older pending questions. A follow-up question on the same capture keeps the keys live.
      if (r.status !== 'pending') requestFocus('chat');
    });
  }

  function pressOption(c: Capture, key: string): void {
    if (!c.question) return;
    setHl(null);
    const a = answerForKey(c.question, key);
    if (!a) return;
    if (a.kind === 'pick') {
      // The picker closes itself (app.tsx) before calling onPick.
      pickPerson((p) => { personPicker.value = null; answer(c, { personId: p.id }); });
    } else {
      answer(c, a.body);
    }
  }

  /** u / r act only on the capture the user sees selected. */
  function onSelected(verb: 'undo' | 'reclassify'): void {
    const c = filedTarget(capsRef.current, selected?.id ?? null);
    if (!c) { flash("Selected capture isn't filed"); return; }
    void run(c.id, () => api.post<Capture>(`/api/captures/${c.id}/${verb}`), () => {
      flash(`${verb === 'undo' ? 'Undone' : 'Reclassified'}: ${c.summary}`);
    });
  }
  const undo = () => onSelected('undo');
  const reclassify = () => onSelected('reclassify');

  function move(d: number): void {
    if (captures.length === 0) return;
    const i = Math.max(0, captures.findIndex((c) => c.id === selected?.id));
    const n = captures[Math.min(Math.max(i + d, 0), captures.length - 1)];
    if (n) setSelId(n.id);
  }

  /** ↓ on the newest capture hands the keyboard back to the input. */
  function moveDown(): void {
    const i = captures.findIndex((c) => c.id === selected?.id);
    if (downAction(i, captures.length) === 'input') input.current?.focus(); else move(1);
  }

  function stepHighlight(dir: 'left' | 'right'): void {
    if (!liveSel) return;
    const k = stepOption(optionKeys, hlKey, dir);
    if (k === null) return;
    setHl({ id: liveSel.id, key: k });
    // Purely visual highlight (no DOM focus): announce it through the status line's live region.
    const label = liveSel.question ? questionChoices(liveSel.question).find((o) => o.key === k)?.label : undefined;
    if (label) flash(`Answer: ${label}`);
  }

  function open(): void {
    if (!selected) return;
    const t = openTarget(selected);
    if (t) navigate(t); else flash('Nothing to open');
  }

  async function older(): Promise<void> {
    const first = capsRef.current[0];
    if (!first || busy.current) return;
    const e = epoch();
    try {
      const page = await loadCaptures(api, first.id);
      if (e !== epoch() || !alive.current) return;
      setCaptures((cur) => prependPage(cur, page.captures));
      setHasMore(page.hasMore);
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
    }
  }

  const bindings: Record<string, KeyHandler> = {
    j: () => move(1), down: moveDown,
    k: () => move(-1), up: () => move(-1),
    'g g': () => { const f = captures[0]; if (f) setSelId(f.id); },
    'shift+g': () => { const l = captures[captures.length - 1]; if (l) setSelId(l.id); },
    enter: () => { if (liveSel && hlKey !== null) pressOption(liveSel, hlKey); else open(); },
    u: undo, r: reclassify,
    ...(hasMore ? { o: () => { void older(); } } : {}),
  };
  const descriptions: Record<string, string> = {
    j: 'next capture', k: 'previous capture', 'g g': 'first capture', 'shift+g': 'newest capture',
    down: 'next capture (past the newest: back to the input)', up: 'previous capture', enter: 'open filed item / answer with the highlighted option', u: 'undo capture', r: 'reclassify capture', o: 'load older captures',
  };
  // The live question's option keys win over the fixed ones above.
  if (target?.question) {
    for (const k of questionKeys(target.question)) {
      bindings[k] = () => pressOption(target, k);
      descriptions[k] = 'answer the question';
    }
  }
  useKeys(bindings, { descriptions });
  useKeys({ left: () => stepHighlight('left'), right: () => stepHighlight('right') }, {
    enabled: liveSel !== null,
    descriptions: { left: 'previous answer option', right: 'next answer option' },
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e)) return;
    // Behind an overlay or during a voice recording the input must not act (it may still hold focus); in
    // particular Enter belongs to the voice Send, never to sending the draft.
    if (e.key === 'Enter') { e.preventDefault(); if (!modalOpen()) submit(); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Behind an overlay or during a voice recording the input must not act (it may still hold focus).
      if (modalOpen()) return;
      const dir = e.key === 'ArrowUp' ? 'up' : 'down';
      const draft = chatDraft.peek();
      const act = inputArrow({
        dir, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, draft, hasCaptures: capsRef.current.length > 0,
      });
      if (act === 'native') return;
      e.preventDefault();
      if (act === 'leave') {
        // Back to NORMAL on the newest capture; a pending one makes its question live (chat focus rule).
        const newest = capsRef.current[capsRef.current.length - 1];
        if (newest) setSelId(newest.id);
        input.current?.blur();
        mode.value = 'normal';
        return;
      }
      const next = recallNext(historyTexts(capsRef.current), recall.current, draft, chatDraftSource.peek(), chatStash.peek(), dir);
      // The stash (your own typed text) stays until Alt-↓ restores it or a send brings it back. Edits to a
      // recalled line are NOT protected: it is a copy of history, so they may be discarded by the next recall.
      recall.current = next.pos;
      chatStash.value = next.stash;
      restoreChatDraft(next.text, next.source);
    }
  };

  return (
    <Pane title="Chat" focused class="chat">
      <div class="list chat-log" role="log" aria-label="Captures" ref={log}>
        {!loaded && <div class="empty">Loading…</div>}
        {loaded && captures.length === 0 && <div class="empty">Nothing captured yet. Type below and press Enter.</div>}
        {hasMore && <div class="hint">[o] load older</div>}
        {captures.map((c) => {
          const isSel = c.id === selected?.id;
          const res = describeResult(c);
          const live = target?.id === c.id && c.question;
          return (
            <div key={c.id} class={`row${isSel ? ' selected' : ''}`} onClick={() => setSelId(c.id)}>
              <span class="row-marker" aria-hidden="true">{isSel ? '>' : ' '}</span>
              <div class="row-body">
                <div>
                  <span class="dim">{formatTime(c.createdAt)} </span>
                  {res.tone === 'deleted' ? <span class="dim">(deleted)</span> : c.text}
                </div>
                {res.tone !== 'deleted' && (
                  <div class={res.tone === 'pending' ? 'pending' : 'dim'}>
                    {res.text}
                    {res.hint && <span class="dim">{`   ${res.hint}`}</span>}
                  </div>
                )}
                {live && c.question && (
                  <div>
                    <div class="hint">Esc, then press a key (or ←/→ and Enter) to answer</div>
                    {questionChoices(c.question).map((o) => (
                      <button
                        key={o.key} type="button" class={`tbtn${hlKey === o.key ? ' highlight' : ''}`}
                        aria-current={hlKey === o.key ? 'true' : undefined}
                        onClick={(ev) => { ev.stopPropagation(); pressOption(c, o.key); }}
                      >
                        <span class="row-marker" aria-hidden="true">{hlKey === o.key ? '>' : ' '}</span>{optionLabel(o)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div class="prompt-line">
        <span class="accent" aria-hidden="true">&gt;</span>
        <input
          ref={input} class="textedit" type="text" value={chatDraft.value} spellcheck={false} autocomplete="off"
          maxLength={LIMITS.captureText} placeholder="note, thought or action…" aria-label="Chat input"
          onInput={(e) => {
            editChatDraft((e.target as HTMLInputElement).value);
          }}
          onKeyDown={onKeyDown}
        />
        <button type="button" class="tbtn" onClick={submit} aria-label="Send">⏎</button>
      </div>
      <div class="hint">
        /note /todo /wait /agenda · @person · Enter send · Esc normal mode · Alt-↑/↓ recall · ↑ select newest · j/k ↑/↓ select · u undo · r reclassify
      </div>
    </Pane>
  );
}

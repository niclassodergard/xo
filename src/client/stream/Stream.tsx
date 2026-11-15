import { effect } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AnswerCaptureRequest } from '../../shared/api.ts';
import type { Capture, Id } from '../../shared/types.ts';
import { Chip } from '../components/Chip.tsx';
import { focusTarget } from '../lib/focus.ts';
import { formatTime, oldestId } from '../lib/format.ts';
import { keystrokeMark, typedSince, useKeys } from '../lib/keys.ts';
import { docPath, openDoc } from '../lib/nav.ts';
import { stepAction } from '../lib/row-actions.ts';
import { api, ApiError } from '../lib/api.ts';
import { askPick, epoch, errorText, flash, personName, projectTitle } from '../lib/store.ts';
import { askQuestion, askStates, drainQueue, landed, landedVersion, queuedTexts, refreshLinks, reloadVersion, sending, streamCaptures, undoneHere } from './send.ts';
import {
  chipsFor, defaultChipId, loadCaptures, mergeLoaded, openRef, prependPage, replyFor, replyText, stepSelection, upsertCapture, upsertLanded,
} from './stream-logic.ts';
import type { ChipSpec, Seg } from './stream-logic.ts';
import '../styles/stream.css';

const lookups = {
  personName,
  projectTitle,
  undone: (id: Id) => undoneHere.has(id),
  ask: (id: Id) => askStates.value.get(id),
};

/** The chips of a capture, with the client-side state of its question (Answer / Retry / none while asking). */
const chipsOf = (c: Capture): ChipSpec[] => chipsFor(c, askStates.value.get(c.id));

function Segments(props: { segs: Seg[] }) {
  return (
    <>
      {props.segs.map((s, i) => s.ref
        ? (
          <a key={i} href={`#${docPath(s.ref)}`} class="msg-link" onClick={(e) => { e.preventDefault(); openDoc(s.ref!); }}>{s.text}</a>
        )
        : <span key={i}>{s.text}</span>)}
    </>
  );
}

/**
 * The conversation: one turn per capture (the user's text and XO's reply, composed on the client), then the texts
 * still waiting to be sent. Up/Down pick a turn, Left/Right a chip, Enter runs it (keys live in the `stream`
 * scope, so they only fire while focus is inside the log). Nothing here moves focus on its own.
 */
export default function Stream() {
  const caps = streamCaptures.value;
  const queued = queuedTexts.value;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [hasMore, setHasMoreState] = useState(false);
  const [selId, setSelState] = useState<Id | null>(null);
  const [, bump] = useState(0);
  const [announce, setAnnounce] = useState('');
  const box = useRef<HTMLDivElement>(null);
  // Mirrors of the highlight, updated synchronously: two quick key presses must both see the first one's result.
  const selRef = useRef<Id | null>(null);
  const chipRef = useRef<string | null>(null); // the chip the user moved to; null = the capture's default
  const hasMoreRef = useRef(false);
  const busy = useRef(new Set<Id>());
  const loadingOlder = useRef(false);
  const mounted = useRef(true);
  const stick = useRef(true);
  const adjust = useRef<{ h: number; top: number } | null>(null);
  const capsRef = useRef(caps);
  capsRef.current = caps;

  const setSel = (id: Id | null) => { selRef.current = id; chipRef.current = null; setSelState(id); };
  const setHasMore = (v: boolean) => { hasMoreRef.current = v; setHasMoreState(v); };
  const rerender = () => { if (mounted.current) bump((n) => n + 1); };
  const find = (id: Id | null): Capture | undefined => (id === null ? undefined : capsRef.current.find((c) => c.id === id));
  const effChip = (c: Capture): string | null => {
    const chips = chipsOf(c);
    return chipRef.current !== null && chips.some((x) => x.id === chipRef.current) ? chipRef.current : defaultChipId(c);
  };

  // Landed sends (this Stream may be a newer one than the Stream that started the send): take them now and on each landing.
  useLayoutEffect(() => {
    mounted.current = true;
    const stop = effect(() => {
      void landedVersion.value;
      const got = landed.take(epoch());
      if (got.length > 0) streamCaptures.value = got.reduce(upsertLanded, streamCaptures.peek());
    });
    return () => { mounted.current = false; stop(); };
  }, []);

  // The one request on load: the newest page. Epoch-guarded; merged with whatever already landed.
  const load = async (): Promise<void> => {
    const e = epoch();
    try {
      const r = await loadCaptures(api);
      if (e !== epoch()) return;
      streamCaptures.value = mergeLoaded(r.captures, streamCaptures.peek());
      setHasMore(r.hasMore);
      if (mounted.current) setStatus('ready');
    } catch (err) {
      if (e === epoch() && mounted.current) setStatus('error');
      if (e === epoch() && err instanceof ApiError && err.status !== 401) flash(`Could not load the conversation: ${errorText(err)}`, 'error');
    }
  };
  useEffect(() => { void load(); }, []);
  // An ask found the capture changed on the server: show what the server has now.
  const loadRef = useRef(load);
  loadRef.current = load;
  useLayoutEffect(() => {
    let first = true;
    return effect(() => {
      void reloadVersion.value;
      if (first) { first = false; return; }
      void loadRef.current();
    });
  }, []);

  // Scrolling: stay at the bottom while the user is there; keep the view when an older page is put in front.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (adjust.current) {
      el.scrollTop = adjust.current.top + (el.scrollHeight - adjust.current.h);
      adjust.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  });
  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // The highlight is visual plus a live-region announcement; the turn is kept in view.
  const selected = find(selId);
  const selChip = selected ? effChip(selected) : null;
  useEffect(() => {
    if (selId === null || !selected) { setAnnounce(''); return; }
    document.getElementById(`cap-${selId}`)?.scrollIntoView?.({ block: 'nearest' });
    const label = chipsOf(selected).find((x) => x.id === selChip)?.label;
    setAnnounce(`${replyText(replyFor(selected, lookups))}${label ? `, ${label}` : ''}`);
  }, [selId, selChip, selected?.status, selected ? askStates.value.get(selected.id)?.phase : undefined]);

  const loadOlder = async (): Promise<boolean> => {
    if (loadingOlder.current || !hasMoreRef.current) return false;
    const before = oldestId(streamCaptures.peek());
    if (before === undefined) return false;
    const e = epoch();
    loadingOlder.current = true;
    try {
      const r = await loadCaptures(api, before);
      if (e !== epoch()) return false;
      const el = box.current;
      if (el) adjust.current = { h: el.scrollHeight, top: el.scrollTop };
      stick.current = false;
      streamCaptures.value = prependPage(streamCaptures.peek(), r.captures);
      setHasMore(r.hasMore);
      return r.captures.length > 0;
    } catch (err) {
      if (e === epoch()) flash(`Could not load earlier messages: ${errorText(err)}`, 'error');
      return false;
    } finally {
      loadingOlder.current = false;
    }
  };

  // ---- actions on a capture ----

  /** One request about one capture. The in-flight guard comes first; the result never moves focus after typing. */
  const mutate = async (id: Id, path: string, body: unknown, kind: 'undo' | 'answer' | 'other'): Promise<void> => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    rerender();
    const e = epoch();
    const mark = keystrokeMark();
    try {
      const c = await api.post<Capture>(path, body);
      if (e !== epoch()) return;
      if (kind === 'undo') undoneHere.add(c.id);
      streamCaptures.value = upsertCapture(streamCaptures.peek(), c);
      refreshLinks(c);
      // "Answer it" on an unsure question: the capture is now `asked`; the user chose it, so answer it now.
      if (kind === 'answer' && c.status === 'asked') void askQuestion(c.id);
      if (selRef.current === c.id) chipRef.current = null;
      // Done with this item: hand the keyboard back to the composer, unless the user has typed since or moved on.
      if (c.status !== 'pending' && !typedSince(mark) && box.current?.contains(document.activeElement)) {
        focusTarget('composer', { queue: false });
      }
    } catch (err) {
      if (e !== epoch()) return;
      flash(errorText(err), 'error');
      // The capture changed under us (answered elsewhere, item gone): show what the server has now.
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) void load();
    } finally {
      busy.current.delete(id);
      rerender();
    }
  };

  const answer = (id: Id, body: AnswerCaptureRequest) => mutate(id, `/api/captures/${id}/answer`, body, 'answer');

  const run = (c: Capture, spec: ChipSpec): void => {
    if (spec.kind === 'open') {
      const ref = openRef(c);
      if (ref) openDoc(ref);
    } else if (spec.kind === 'pick' && spec.pickKind) {
      const kind = spec.pickKind;
      askPick(kind, (pid) => { void answer(c.id, kind === 'person' ? { personId: pid } : { projectId: pid }); });
    } else if (spec.kind === 'source') {
      if (spec.ref) openDoc(spec.ref);
    } else if (spec.kind === 'ask') {
      void askQuestion(c.id);
    } else if (spec.kind === 'answer' && spec.answer) {
      void answer(c.id, spec.answer);
    } else if (spec.kind === 'undo' || spec.kind === 'reclassify') {
      void mutate(c.id, `/api/captures/${c.id}/${spec.kind}`, undefined, spec.kind === 'undo' ? 'undo' : 'other');
    }
  };

  // ---- keys (only while focus is inside the log) ----

  const step = (dir: 'up' | 'down') => {
    const list = capsRef.current;
    const s = stepSelection(list.map((c) => c.id), selRef.current, dir, hasMoreRef.current);
    if (s.kind === 'select') setSel(s.id);
    else if (s.kind === 'composer') { setSel(null); focusTarget('composer', { queue: false }); }
    else if (s.kind === 'older') {
      const was = selRef.current;
      void loadOlder().then((ok) => {
        if (!ok || selRef.current !== was) return;
        const all = capsRef.current;
        const i = all.findIndex((c) => c.id === was);
        const prev = all[i - 1];
        if (prev) setSel(prev.id);
      });
    }
  };
  const stepChip = (dir: 'left' | 'right') => {
    const c = find(selRef.current);
    if (!c) return;
    const ids = chipsOf(c).map((x) => x.id);
    const next = stepAction(ids, effChip(c), dir);
    if (next !== null) { chipRef.current = next; rerender(); }
  };
  const runHighlighted = () => {
    const c = find(selRef.current); // the visible selection only, re-checked now
    if (!c) return;
    const id = effChip(c);
    const spec = id === null ? undefined : chipsOf(c).find((x) => x.id === id);
    if (spec) run(c, spec);
  };
  useKeys({
    up: () => step('up'), down: () => step('down'),
    left: () => stepChip('left'), right: () => stepChip('right'),
    enter: runHighlighted,
  }, { scope: 'stream' });

  const onFocus = (e: FocusEvent) => {
    if (e.target === e.currentTarget && selRef.current === null) {
      const last = capsRef.current[capsRef.current.length - 1];
      if (last) setSel(last.id);
    }
  };
  // Leaving the log clears the highlight. A named handler (Preact would not find a `focusout` prop on the element).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const onFocusOut = (e: FocusEvent) => {
      const to = e.relatedTarget;
      if (!(to instanceof Node && el.contains(to)) && selRef.current !== null) setSel(null);
    };
    el.addEventListener('focusout', onFocusOut);
    return () => el.removeEventListener('focusout', onFocusOut);
  }, []);

  const empty = status === 'ready' && caps.length === 0 && queued.length === 0;
  return (
    <>
      <div
        class="stream" data-region="stream" role="log" aria-label="Conversation" tabIndex={0} ref={box}
        onScroll={onScroll} onFocus={onFocus}
      >
        <div class="stream-inner">
          {hasMore && (
            <button type="button" class="btn load-older" onClick={() => { void loadOlder(); }}>Load earlier messages</button>
          )}
          {status === 'loading' && caps.length === 0 && <p class="muted stream-note">Loading…</p>}
          {status === 'error' && caps.length === 0 && (
            <p class="stream-note">
              <span class="muted">Could not load the conversation. </span>
              <button type="button" class="btn" onClick={() => { setStatus('loading'); void load(); }}>Try again</button>
            </p>
          )}
          {empty && <p class="muted stream-note">Nothing here yet. Write a note, a task (/todo) or a name (@Anna) below.</p>}
          {caps.map((c) => {
            const reply = replyFor(c, lookups);
            const chips = chipsOf(c);
            const isSel = c.id === selId;
            const eff = isSel ? effChip(c) : null;
            const sourceChips = chips.filter((x) => x.kind === 'source');
            const actionChips = chips.filter((x) => x.kind !== 'source');
            const chipEl = (ch: ChipSpec) => (
              <Chip
                key={ch.id} label={ch.label} highlighted={isSel && eff === ch.id} tabIndex={isSel ? 0 : -1}
                onClick={() => { setSel(c.id); chipRef.current = ch.id; run(c, ch); }}
              />
            );
            return (
              <article key={c.id} id={`cap-${c.id}`} class={`turn${isSel ? ' selected' : ''}`} data-capture={c.id}>
                {c.text !== '' && (
                  <div class="msg user">
                    <p class="msg-text">{c.text}</p>
                    <span class="msg-meta">{formatTime(c.createdAt)}{c.source === 'voice' ? ' · voice' : ''}</span>
                  </div>
                )}
                <div class={`msg xo tone-${reply.tone}${busy.current.has(c.id) ? ' busy' : ''}`}>
                  <p class="msg-text"><Segments segs={reply.segments} /></p>
                  {sourceChips.length > 0 && (
                    <div class="turn-chips answer-sources" role="group" aria-label="Sources">
                      <span class="muted answer-sources-label">Sources:</span>
                      {sourceChips.map(chipEl)}
                    </div>
                  )}
                  {actionChips.length > 0 && (
                    <div class="turn-chips" role="group" aria-label="Actions">
                      {actionChips.map(chipEl)}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          {queued.map((t, i) => (
            <article key={`q${i}`} class="turn queued">
              <div class="msg user"><p class="msg-text">{t}</p></div>
              <div class="msg xo tone-pending">
                <p class="msg-text muted">{i === 0 && sending.value ? 'Sending…' : 'Waiting to send…'}</p>
                {i === 0 && !sending.value && <div class="turn-chips"><Chip label="Send now" onClick={() => { void drainQueue(); }} /></div>}
              </div>
            </article>
          ))}
        </div>
      </div>
      <div class="sr-only" role="status" aria-live="polite">{announce}</div>
    </>
  );
}

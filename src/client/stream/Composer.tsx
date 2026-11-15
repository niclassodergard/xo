import { useLayoutEffect, useRef } from 'preact/hooks';
import { registerFocusTarget } from '../lib/focus.ts';
import { modalOpen } from '../lib/keys.ts';
import {
  chatDraft, chatDraftSource, chatStash, editChatDraft, flash, restoreChatDraft,
} from '../lib/store.ts';
import MicButton from '../voice/MicButton.tsx';
import { sendDraft, streamCaptures } from './send.ts';
import { composerKey, counterState, historyTexts, recallNext } from './stream-logic.ts';
import type { RecallPos } from './stream-logic.ts';
import '../styles/stream.css';

const MAX_ROWS = 8;

/**
 * The composer: an autosizing textarea (1-8 rows), Enter sends, Shift-Enter is a newline, Up in an empty composer
 * enters the stream, Option-Up/Down recall earlier texts. It registers the `composer` focus target. Sending goes
 * through the module-level queue in send.ts, so a second text is queued behind the first and a 401 loses nothing.
 */
export default function Composer() {
  const el = useRef<HTMLTextAreaElement>(null);
  const recall = useRef<RecallPos | null>(null);
  useLayoutEffect(() => registerFocusTarget('composer', () => el.current), []);

  const draft = chatDraft.value;
  const counter = counterState(draft);
  const empty = draft.trim() === '';

  // Height from JS (CSP forbids style attributes in markup; setting el.style is fine).
  useLayoutEffect(() => {
    const ta = el.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const cs = getComputedStyle(ta);
    const line = Number.parseFloat(cs.lineHeight) || 24;
    const pad = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
    const border = Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth);
    const max = line * MAX_ROWS + pad + border; // box-sizing: border-box
    const want = ta.scrollHeight + border;
    ta.style.height = `${Math.min(want, max)}px`;
    ta.style.overflowY = want > max ? 'auto' : 'hidden';
  }, [draft]);

  const send = (): void => {
    if (counterState(chatDraft.peek()).over) { flash('That is too long to send. Shorten it first.', 'error'); return; }
    if (sendDraft(chatDraft.peek(), chatDraftSource.peek())) recall.current = null;
  };

  const recallStep = (dir: 'up' | 'down'): void => {
    const r = recallNext(historyTexts(streamCaptures.peek()), recall.current, chatDraft.peek(), chatDraftSource.peek(), chatStash.peek(), dir);
    recall.current = r.pos;
    chatStash.value = r.stash;
    if (r.source === 'voice') restoreChatDraft(r.text, 'voice');
    else editChatDraft(r.text, true);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const ta = e.currentTarget as HTMLTextAreaElement;
    const act = composerKey(e, { draft: ta.value, hasCaptures: streamCaptures.peek().length > 0, modalOpen: modalOpen() });
    if (act === 'native') return;
    e.preventDefault();
    if (act === 'send') send();
    else if (act === 'recall-older') recallStep('up');
    else if (act === 'recall-newer') recallStep('down');
    else if (act === 'to-stream') document.querySelector<HTMLElement>('[data-region="stream"]')?.focus();
  };

  return (
    <div class="composer">
      <div class="composer-row">
        <textarea
          ref={el} class="textedit composer-input" rows={1} aria-label="Message XO" placeholder="Message XO" spellcheck={false}
          aria-describedby="composer-hint" enterkeyhint="send"
          value={draft}
          onInput={(e) => editChatDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
        />
        <MicButton />
        <button
          type="button" class="btn primary composer-send" disabled={empty || counter.over}
          onClick={() => { send(); el.current?.focus(); }}
        >
          Send
        </button>
      </div>
      <div class="composer-meta">
        <span id="composer-hint" class="hint">/note /todo /wait /agenda /ask @person #project</span>
        {counter.show && <span class={`hint counter${counter.over ? ' over' : ''}`} aria-live="polite">{counter.text}</span>}
      </div>
    </div>
  );
}

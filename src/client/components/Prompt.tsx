import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { composing, useKeys } from '../lib/keys.ts';
import { promptRequest } from '../lib/store.ts';
import { Overlay } from './Overlay.tsx';
import { Pane } from './Pane.tsx';

/** One-line text prompt (e.g. "New person"). Enter submits, Esc cancels. Rendered while a request is set. */
export function Prompt() {
  const req = promptRequest.value;
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // Synchronous focus so the first typed characters land here.
  useLayoutEffect(() => { setValue(''); input.current?.focus(); }, [req]);
  const cancel = () => { promptRequest.value = null; };
  useKeys({ esc: cancel }, { scope: 'modal', modes: ['normal', 'insert', 'command'], enabled: req !== null });
  if (!req) return null;
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    promptRequest.value = null;
    req.onSubmit(v);
  };
  return (
    <Overlay label={req.label} onBackdrop={cancel}>
      <Pane title={req.label} focused>
        <input
          ref={input} class="textedit" type="text" value={value} spellcheck={false} maxLength={200} aria-label={req.label}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !composing(e)) { e.preventDefault(); submit(); } }}
        />
        <div class="hint">Enter to confirm, Esc to cancel</div>
      </Pane>
    </Overlay>
  );
}

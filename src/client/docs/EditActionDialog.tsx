import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Overlay } from '../components/Overlay.tsx';
import { composing, useKeys } from '../lib/keys.ts';

/** One-line text dialog with a starting value (the shared Prompt has none). */
export function EditActionDialog(props: { label: string; initial: string; onSubmit: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(props.initial);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useKeys({ esc: props.onCancel }, { scope: 'modal' });
  const submit = () => {
    const v = value.trim();
    if (v) props.onSubmit(v);
  };
  return (
    <Overlay label={props.label} onBackdrop={props.onCancel}>
      <h2>{props.label}</h2>
      <input
        ref={input} class="input" type="text" value={value} spellcheck={false} aria-label={props.label}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !composing(e)) { e.preventDefault(); if (!e.repeat) submit(); } }}
      />
      <div class="hint">Enter to save, Esc to cancel</div>
    </Overlay>
  );
}

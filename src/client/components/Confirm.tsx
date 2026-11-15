import { useLayoutEffect, useRef } from 'preact/hooks';
import { useKeys } from '../lib/keys.ts';
import { confirmRequest } from '../lib/store.ts';
import { Overlay } from './Overlay.tsx';

/** Yes/No dialog for `askConfirm`. Focus starts on "No" (the safe choice); Esc cancels. Rendered while a request is set. */
export function Confirm() {
  const req = confirmRequest.value;
  const no = useRef<HTMLButtonElement>(null);
  const cancel = () => { confirmRequest.value = null; };
  useKeys({ esc: cancel }, { scope: 'modal', enabled: req !== null });
  useLayoutEffect(() => { no.current?.focus(); }, [req]);
  if (!req) return null;
  const yes = () => { confirmRequest.value = null; req.onYes(); };
  return (
    <Overlay label="Confirm" onBackdrop={cancel}>
      <p>{req.message}</p>
      <div class="dialog-actions">
        <button type="button" class="btn" ref={no} onClick={cancel}>No</button>
        <button type="button" class="btn danger" onClick={yes}>Yes</button>
      </div>
    </Overlay>
  );
}

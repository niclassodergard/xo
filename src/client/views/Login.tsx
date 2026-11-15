import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { LoginRequest, SessionResponse } from '../../shared/api.ts';
import { api, ApiError } from '../lib/api.ts';
import { useKeys } from '../lib/keys.ts';
import { session } from '../lib/store.ts';

/** Password + 6-digit code. Keyboard only: Enter in the password field moves on, Enter in the code submits. */
export default function Login() {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const pw = useRef<HTMLInputElement>(null);
  const totp = useRef<HTMLInputElement>(null);

  // Login is modal: no view or global binding may run behind it (also during a 401 re-login).
  useKeys({}, { scope: 'modal' });
  useLayoutEffect(() => { pw.current?.focus(); }, []);
  // Login covers an inert shell, so focus outside the form is always wrong: anything that moves focus
  // away after the lock (an unmounting view, a late result) is undone, and the user can type at once.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const inside = (el: Element | null): boolean => !!el && !!form.current?.contains(el);
    const onFocusIn = (e: FocusEvent): void => { if (!inside(e.target as Element | null)) pw.current?.focus(); };
    const onFocusOut = (e: FocusEvent): void => {
      if (e.relatedTarget !== null) return; // moving to another element: focusin handles it
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (document.hasFocus() && (a === null || a === document.body)) pw.current?.focus();
      });
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    if (!inside(document.activeElement)) pw.current?.focus();
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);
  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => {
      setWait((w) => w - 1);
      if (wait <= 1) setError(null); // countdown over: drop the rate-limit message
    }, 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const submit = async (ev?: Event) => {
    ev?.preventDefault();
    if (busy || wait > 0) return;
    if (!password || !/^\d{6}$/.test(code)) { setError('Enter your password and the 6-digit code.'); return; }
    setBusy(true); setError(null);
    try {
      const body: LoginRequest = { password, totp: code };
      const r = await api.post<SessionResponse>('/api/auth/login', body);
      setPassword(''); setCode('');
      session.value = { csrfToken: r.csrfToken };
    } catch (e) {
      setPassword(''); setCode('');
      if (e instanceof ApiError && e.status === 429) {
        const secs = e.retryAfter ?? 60;
        setWait(secs);
        setError(`Too many attempts. Try again in ${secs} seconds.`);
      } else if (e instanceof ApiError && e.status === 0) {
        setError(e.message);
      } else {
        setError('Login failed.'); // deliberately generic
      }
      pw.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="login-wrap">
      <form ref={form} class="login" onSubmit={submit} autocomplete="off">
        <h1>XO</h1>
        <label class="field">
          <span>Password</span>
          <input
            ref={pw} class="input" type="password" autocomplete="current-password" value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); totp.current?.focus(); } }}
          />
        </label>
        <label class="field">
          <span>Code</span>
          <input
            ref={totp} class="input" type="text" inputMode="numeric" autocomplete="one-time-code" maxLength={6} pattern="[0-9]{6}"
            value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))}
          />
        </label>
        {error && <div class="error-text" role="alert">{wait > 0 ? `Too many attempts. Try again in ${wait} seconds.` : error}</div>}
        <button type="submit" class="btn primary" disabled={busy || wait > 0}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

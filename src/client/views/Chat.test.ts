import { afterEach, describe, expect, it } from 'vitest';
import type { Capture } from '../../shared/types.ts';
import { session, shellActive } from '../lib/store.ts';
import { landed, sendQueue } from './Chat.tsx';

const cap = { id: 1, text: 'x' } as unknown as Capture;

afterEach(() => { session.value = null; shellActive.value = false; landed.clear(); sendQueue.reset(); });

describe('landed feed and the session', () => {
  it('a 401 (session null, shell still active) drops landed captures', () => {
    session.value = { csrfToken: 't' };
    landed.push(cap, 1);
    expect(landed.size()).toBe(1);
    session.value = null;
    expect(landed.size()).toBe(0);
  });

  it('a 401 keeps queued chat texts; only leaving the shell (logout) clears them', () => {
    session.value = { csrfToken: 't' };
    expect(shellActive.value).toBe(true);
    sendQueue.push('typed before the 401');
    session.value = null; // 401: shell stays active
    expect(shellActive.value).toBe(true);
    expect(sendQueue.size()).toBe(1);
    shellActive.value = false; // logout
    expect(sendQueue.size()).toBe(0);
  });
});

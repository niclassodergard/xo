import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Stored format: scrypt$N$r$p$saltB64$hashB64
export const SCRYPT_DEFAULTS = { N: 2 ** 17, r: 8, p: 1 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;
// Upper bounds applied when parsing a stored string, so a tampered value cannot demand huge memory.
const MAX_N = 2 ** 20;
const MAX_R = 16;
const MAX_P = 4;

export interface ScryptParams { N: number; r: number; p: number }

// One scrypt at a time: each N=2^17 run holds ~128 MiB, so concurrent logins must not run in parallel.
let queueTail: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.then(() => undefined, () => undefined);
  return run;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return serialize(() => deriveNow(password, salt, params));
}

function deriveNow(password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must exceed 128 * N * r bytes (default 32 MiB is too small for N=2^17).
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, { N, r, p, maxmem: 128 * N * r + 4 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Hash a password. `params` exists so tests can use a cheap N; production uses the defaults. */
export async function hashPassword(password: string, params: ScryptParams = SCRYPT_DEFAULTS): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  if (![n, r, p].every((x) => /^[1-9]\d{0,9}$/.test(x))) return null;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (params.N < 2 || params.N > MAX_N || (params.N & (params.N - 1)) !== 0) return null;
  if (params.r > MAX_R || params.p > MAX_P) return null;
  const salt = Buffer.from(saltB64, 'base64');
  const hash = Buffer.from(hashB64, 'base64');
  if (salt.length < 8 || hash.length !== KEY_LEN) return null;
  return { params, salt, hash };
}

/**
 * Constant-time verification. A malformed stored string yields false. A failure of scrypt itself
 * (e.g. out of memory) still rejects. Calls are queued: only one scrypt runs at a time.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return timingSafeEqual(key, parsed.hash);
}

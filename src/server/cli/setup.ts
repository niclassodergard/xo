import { createInterface } from 'node:readline/promises';
import type { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';
import type { Config } from '../config.ts';
import { hashPassword } from '../auth/password.ts';
import type { ScryptParams } from '../auth/password.ts';
import { deleteAllDevices } from '../auth/devices.ts';
import { deleteAllSessions } from '../auth/sessions.ts';
import { base32Decode, generateSecret, otpauthUri, verifyTotp } from '../auth/totp.ts';

export const MIN_PASSWORD_LENGTH = 12;

export interface SetupInput {
  password: string;
  /** Base32 secret the user has enrolled in their authenticator. */
  secret: string;
  /** A current code from that authenticator; required before anything is written. */
  code: string;
  /** Replace an existing user (and delete all sessions). */
  force?: boolean;
  now: Date;
  /** Cheaper scrypt parameters for tests only. */
  scryptParams?: ScryptParams;
}

export const MAX_PASSWORD_LENGTH = 256;
const MIN_SECRET_BYTES = 16;

/**
 * Non-interactive core of `xo setup`: validates the password and confirming TOTP code, then writes the
 * single user row. With `force` the credentials are replaced and every session and trusted device is
 * deleted. Without it an existing user is an error. The existence check and the write happen in one
 * `BEGIN IMMEDIATE` transaction.
 *
 * NOTE: the confirming code's step is consumed (stored as `totp_last_step`), so it cannot be used to
 * log in. Callers (the e2e setup, tests) should confirm with the PREVIOUS step's code (still accepted
 * by the +-1 window) and then log in with the current step's code.
 */
export async function setupUser(db: DatabaseSync, input: SetupInput): Promise<void> {
  const length = [...input.password].length;
  if (length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (length > MAX_PASSWORD_LENGTH) {
    throw new Error(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  let step: number | null;
  try {
    if (base32Decode(input.secret).length < MIN_SECRET_BYTES) throw new Error('short');
    step = verifyTotp(input.secret, input.code.replace(/\s+/g, ''), input.now, 0);
  } catch {
    throw new Error('the TOTP secret is invalid (it must be base32 and at least 128 bits)');
  }
  if (step === null) throw new Error('the confirmation code is not valid');
  const hash = await hashPassword(input.password, input.scryptParams);
  const iso = input.now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (input.force) {
      // The confirming code counts as used, so it cannot be replayed to log in.
      db.prepare(
        `INSERT INTO user (id, password_hash, totp_secret, totp_last_step, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, totp_secret = excluded.totp_secret,
           totp_last_step = excluded.totp_last_step, updated_at = excluded.updated_at`,
      ).run(hash, input.secret, step, iso, iso);
      deleteAllSessions(db);
      deleteAllDevices(db);
    } else {
      try {
        db.prepare(
          `INSERT INTO user (id, password_hash, totp_secret, totp_last_step, created_at, updated_at)
           VALUES (1, ?, ?, ?, ?, ?)`,
        ).run(hash, input.secret, step, iso, iso);
      } catch (err) {
        if (/UNIQUE|constraint/i.test(err instanceof Error ? err.message : '')) {
          throw new Error('a user already exists; re-run with --force to replace the credentials');
        }
        throw err;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Reads a line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error('setup needs an interactive terminal'));
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (fn: () => void): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      fn();
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('cancelled')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function run(args: string[], ctx: { config: Config; db: DatabaseSync }): Promise<void> {
  const unknown = args.filter((a) => a !== '--force');
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
  const force = args.includes('--force');
  const { db } = ctx;
  if (db.prepare('SELECT 1 AS x FROM user WHERE id = 1').get() && !force) {
    throw new Error('a user already exists; re-run with --force to replace the credentials (this deletes all sessions)');
  }
  const password = await readHidden(`New password (min ${MIN_PASSWORD_LENGTH} characters): `);
  if ([...password].length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if ([...password].length > MAX_PASSWORD_LENGTH) throw new Error(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  if (password !== (await readHidden('Repeat password: '))) throw new Error('passwords do not match');

  const secret = generateSecret();
  const uri = otpauthUri(secret);
  console.log('\nAdd this to your authenticator app (scan the QR code or enter the secret):\n');
  console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
  console.log(`URI:    ${uri}`);
  console.log(`Secret: ${secret}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ac = new AbortController();
  rl.on('SIGINT', () => ac.abort());
  rl.on('close', () => ac.abort());
  let code = '';
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        code = (await rl.question('Enter the current 6-digit code to confirm: ', { signal: ac.signal })).replace(/\s+/g, '');
      } catch {
        throw new Error('cancelled');
      }
      if (verifyTotp(secret, code, new Date(), 0) !== null) break;
      if (attempt >= 3) throw new Error('the confirmation code was not valid 3 times; nothing was saved');
      console.log('That code does not match. Check the clock on your phone and try again.');
    }
  } finally {
    rl.close();
  }
  await setupUser(db, { password, secret, code, force, now: new Date() });
  console.log(force ? 'Credentials replaced; all sessions and trusted devices deleted.' : 'User created.');
  console.log('Wait for the next code in your authenticator, then log in.');
  console.log('The secret is in your terminal scrollback: clear it now (e.g. `clear && printf "\\033[3J"`).');
}

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { base32Encode, totpAt } from '../../src/server/auth/totp.ts';
import { setupUser } from '../../src/server/cli/setup.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { openDb } from '../../src/server/db/open.ts';

// Log hygiene on the REAL server process (main.ts, logger on): buildApp's logger writes straight to
// stdout and cannot take a stream, so the test starts main.ts as a child, drives it over HTTP and reads
// what it printed. No network beyond 127.0.0.1; XO_LLM=fake.

const ROOT = resolve(import.meta.dirname, '../..');
const PASSWORD = 'correct horse battery';
const WRONG_PASSWORD = 'LEAKMARK-wrong-password-1';
const CAPTURE_TEXT = 'LEAKMARK-capture-text-2';
const SEARCH_TEXT = 'LEAKMARK-search-text-3';
const API_KEY = 'sk-or-LEAKMARK-api-key-4';
const PROJECT_TITLE = 'LEAKMARK-project-title-5';
const PROJECT_ALIAS = 'LEAKMARK-project-alias-6';
const PROJECT_DESC = 'LEAKMARK-project-description-7';
const PROJECT_RENAMED = 'LEAKMARK-project-renamed-8';
const PROJECT_SEARCH = 'LEAKMARK-project-search-9';
const UNKNOWN_PROJECT = 'LEAKMARK-unknown-project-10';
const FAIL_TEXT = `LEAKMARK-failing-capture-11 about ${PROJECT_TITLE} !!fail`;
const QA_NOTE = 'LEAKMARK-qa-note-12';
const QA_QUESTION = 'LEAKMARK-qa-question-13';
const QA_FAIL = 'LEAKMARK-qa-failing-question-14';
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

let child: ChildProcess | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (child && child.exitCode === null) {
    const c = child;
    const exited = new Promise((r) => c.once('exit', r));
    c.kill('SIGTERM');
    // Never hang teardown on a server that ignores SIGTERM.
    const timer = setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL'); }, 5000);
    await exited;
    clearTimeout(timer);
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  child = undefined;
  dir = undefined;
});

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => res(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

describe('server logs (real process)', () => {
  it('contain request lines, but never credentials, capture text, search text, project titles, cookies or the API key', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xo-logtest-'));
    const dbPath = join(dir, 'xo.db');
    const db = openDb(dbPath);
    migrate(db);
    const previous = new Date(Date.now() - 30_000);
    await setupUser(db, { password: PASSWORD, secret: SECRET, code: totpAt(SECRET, previous), now: previous, scryptParams: { N: 16, r: 8, p: 1 } });
    db.close();

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['src/server/main.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '', HOME: dir, XO_DB_PATH: dbPath, XO_HOST: '127.0.0.1', XO_PORT: String(port),
        XO_PUBLIC_ORIGIN: base, XO_COOKIE_INSECURE: 'true', XO_LLM: 'fake',
        OPENROUTER_API_KEY: API_KEY, OPENROUTER_KEY_FILE: join(dir, 'none'),
      },
    });
    let out = '';
    child.stdout!.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr!.on('data', (b: Buffer) => { out += b.toString(); });
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited early: ${out.slice(-500)}`);
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('server did not start');
      await new Promise((r) => setTimeout(r, 100));
    }

    const json = { 'content-type': 'application/json', origin: base };
    // A failed login (wrong password) and a good one.
    const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ password: WRONG_PASSWORD, totp: '000000' }) });
    expect(bad.status).toBe(401);
    const code = totpAt(SECRET, new Date());
    const good = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ password: PASSWORD, totp: code }) });
    expect(good.status).toBe(200);
    const { csrfToken } = (await good.json()) as { csrfToken: string };
    const cookies = good.headers.getSetCookie().map((c) => c.split(';', 1)[0]!);
    const sessionValue = cookies.find((c) => c.startsWith('xo_session='))!.split('=')[1]!;
    const cookie = cookies.join('; ');
    const authed = { ...json, cookie, 'x-xo-csrf': csrfToken };
    const bodyless = { origin: base, cookie, 'x-xo-csrf': csrfToken }; // no JSON content type: these POSTs carry no body
    expect((await fetch(`${base}/api/captures`, { method: 'POST', headers: authed, body: JSON.stringify({ text: `/note ${CAPTURE_TEXT}`, source: 'text' }) })).status).toBe(201);
    expect((await fetch(`${base}/api/search`, { method: 'POST', headers: authed, body: JSON.stringify({ q: SEARCH_TEXT }) })).status).toBe(200);
    expect((await fetch(`${base}/api/people?probe=${SEARCH_TEXT}`, { headers: { cookie } })).status).toBe(400); // query text must not be logged either
    // Projects: create, mention in a capture, search, rename, link, pin, open and delete. Their titles, aliases,
    // descriptions and the search text travel in bodies and the capture text; none may reach the log.
    const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: authed, body: JSON.stringify({ title: PROJECT_TITLE, aliases: [PROJECT_ALIAS], descriptionMd: PROJECT_DESC }) });
    expect(created.status).toBe(201);
    const projectId = ((await created.json()) as { id: number }).id;
    const mention = await fetch(`${base}/api/captures`, { method: 'POST', headers: authed, body: JSON.stringify({ text: `/note about #${PROJECT_TITLE}`, source: 'text' }) });
    expect(mention.status).toBe(201);
    expect(((await mention.json()) as { draft: { projectId: number | null } }).draft.projectId).toBe(projectId); // the title really went through the pipeline
    // An unprefixed capture naming the project whose classification fails (logs the failure class), and an unknown #name.
    const failing = await fetch(`${base}/api/captures`, { method: 'POST', headers: authed, body: JSON.stringify({ text: FAIL_TEXT, source: 'text' }) });
    expect(failing.status).toBe(201);
    expect(((await failing.json()) as { status: string }).status).toBe('pending');
    const unknown = await fetch(`${base}/api/captures`, { method: 'POST', headers: authed, body: JSON.stringify({ text: `/note see #${UNKNOWN_PROJECT}`, source: 'text' }) });
    expect(((await unknown.json()) as { question: { type: string } }).question.type).toBe('unknown_project');
    expect((await fetch(`${base}/api/search`, { method: 'POST', headers: authed, body: JSON.stringify({ q: PROJECT_SEARCH }) })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/${projectId}`, { method: 'PATCH', headers: authed, body: JSON.stringify({ title: PROJECT_RENAMED }) })).status).toBe(200);
    expect((await fetch(`${base}/api/nav/pins/project/${projectId}`, { method: 'PUT', headers: { origin: base, cookie, 'x-xo-csrf': csrfToken } })).status).toBe(204);
    expect((await fetch(`${base}/api/nav/recents`, { method: 'POST', headers: authed, body: JSON.stringify({ kind: 'project', id: projectId }) })).status).toBe(204);
    const nav = await (await fetch(`${base}/api/nav`, { headers: { cookie } })).json() as { pinned: { title: string }[] };
    expect(nav.pinned.map((n) => n.title)).toEqual([PROJECT_RENAMED]); // the title is really served, just never logged
    expect((await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE', headers: { origin: base, cookie, 'x-xo-csrf': csrfToken } })).status).toBe(204);
    // Question answering: a note, a question that is answered (excerpts and answer cross the process boundary of
    // the fake LLM), one that fails (logs the failure class), one with nothing found, and undo.
    expect((await fetch(`${base}/api/notes`, { method: 'POST', headers: authed, body: JSON.stringify({ title: QA_NOTE, bodyMd: `${QA_NOTE} body` }) })).status).toBe(201);
    const asked = await fetch(`${base}/api/captures`, { method: 'POST', headers: authed, body: JSON.stringify({ text: `/ask ${QA_QUESTION} ${QA_NOTE}?`, source: 'text' }) });
    const askedId = ((await asked.json()) as { id: number; status: string }).id;
    const answeredRes = await fetch(`${base}/api/captures/${askedId}/ask`, { method: 'POST', headers: bodyless });
    expect(answeredRes.status).toBe(200);
    const answeredBody = (await answeredRes.json()) as { status: string; answer: { text: string; sources: unknown[] } };
    expect(answeredBody.status).toBe('answered');
    expect(answeredBody.answer.text).toContain(QA_NOTE); // the answer really carried the data, so its absence in the log means something
    expect(answeredBody.answer.sources.length).toBeGreaterThan(0);
    const failing2 = await fetch(`${base}/api/captures`, { method: 'POST', headers: authed, body: JSON.stringify({ text: `/ask ${QA_FAIL} ${QA_NOTE} !!fail`, source: 'text' }) });
    const failId = ((await failing2.json()) as { id: number }).id;
    expect((await fetch(`${base}/api/captures/${failId}/ask`, { method: 'POST', headers: bodyless })).status).toBe(502);
    expect((await fetch(`${base}/api/captures/${askedId}/undo`, { method: 'POST', headers: bodyless })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300)); // let the logger flush

    // The capture is really there: these log lines exist, so the absence checks below mean something.
    expect(out).toContain('"msg":"login failed"');
    expect(out).toContain('"path":"/api/captures"');
    expect(out).toContain('"path":"/api/search"');
    expect(out).toContain('"path":"/api/people"'); // path logged without the query string
    // The project requests are in the log too (so the absence checks below cover them).
    expect(out).toContain('capture classifier failed'); // the failure line exists, so the scan below covers it
    expect(out).toContain('question answering failed: LlmError'); // the failure line exists, so the scan covers the Q&A path
    expect(out).toContain(`"path":"/api/captures/${askedId}/ask"`);
    expect(out).toContain('"path":"/api/projects"');
    expect(out).toContain(`"path":"/api/projects/${projectId}"`);
    expect(out).toContain(`"path":"/api/nav/pins/project/${projectId}"`);
    expect(out).toContain('"path":"/api/nav/recents"');

    for (const secret of [WRONG_PASSWORD, PASSWORD, CAPTURE_TEXT, SEARCH_TEXT, API_KEY, csrfToken, sessionValue, PROJECT_TITLE, PROJECT_ALIAS, PROJECT_DESC, PROJECT_RENAMED, PROJECT_SEARCH, UNKNOWN_PROJECT, FAIL_TEXT, QA_NOTE, QA_QUESTION, QA_FAIL, 'LEAKMARK']) {
      expect(out, `log must not contain ${secret.slice(0, 12)}...`).not.toContain(secret);
    }
    // A 6-digit TOTP code can occur by chance inside timestamps or durations, so match it only as a
    // standalone number, and check that no totp field is logged at all.
    expect(out).not.toMatch(new RegExp(`(?<!\\d)${code}(?!\\d)`));
    expect(out.toLowerCase()).not.toContain('"totp"');
  });
});

# XO — project guide for Claude

XO is a single-user "run my life" webapp for a CEO. It is a web app that looks
like a TUI. Text and voice typed into a chat interface are classified into
documents (notes, tasks, people, 1-1 meetings) or attached to a person. A core
use case is preparing and running many 1-1 meetings.

**Keep this file current.** It is how Claude keeps control of the project across
sessions. Update it when a decision changes, when a command or convention is
added, and — always — when a mistake is made (see "Lessons learned" below).

## Status

- v0.1 prototype in progress. Plan: `docs/plans/2026-11-15-xo-v0.1.md`
  (the source of truth for v0.1 scope, steps, and acceptance criteria; read
  section 6 "Amendments" — they override older text).
- **Done and reviewed (2026-11-15):** step 1 (foundation), 2 (auth: password +
  TOTP, sessions, trusted-device cookie), 3 (data layer, CRUD, search, 30-day
  purge), 4 (OpenRouter classifier/transcriber/voice route, ZDR opt-in),
  5 (client shell: TUI, keys, router, API client, login, session lock, drafts),
  6 (shared parsing and name matching).
- **Next:** wave C — steps 7 (capture pipeline), 8 and 9 (client views),
  10 (client voice), 11 (export, Docker, README); then step 12 (integration,
  Playwright, acceptance).
- Update this section as milestones land.

## Settled decisions (v0.1, interview of 2026-11-15)

| Area | Decision |
|---|---|
| Users / access | Single user. Hosted on a **public server** behind a login. Hosting target undecided → stay portable: one Node process + SQLite file, Dockerfile, behind an HTTPS reverse proxy (e.g. Caddy). Develop locally first. |
| Auth | Password + TOTP. Secure session cookie (HttpOnly, Secure, SameSite), rate-limited login, CSRF protection. |
| Doc types | Notes, tasks/actions, people, 1-1 meetings (agendas + meeting notes). Out of scope: journal, projects, decisions, goals. |
| Classification | LLM classifies chat input. **If unsure it must not guess** — it asks the user to classify (keyboard-selectable inline choice). Confident results are filed visibly with one-key undo/reclassify. Prefix commands (`/note`, `/todo`, `@person`…) force the type. |
| People | Known names/aliases link automatically; unknown names → ask before creating a person. |
| LLM | OpenRouter only (one key, server env var), Claude model, configurable. ZDR is **off by default for now** (user decision 2026-11-15): `XO_OPENROUTER_ZDR=true` turns on `provider: { zdr: true }` on every request, with no retry without it. Classifier sits behind an interface; tests use a fake. |
| Voice | Push-to-talk; browser records (MediaRecorder) → our server → OpenRouter `/api/v1/audio/transcriptions` (ZDR per `XO_OPENROUTER_ZDR`). Dictation + a small set of voice commands ("open Anna", "start 1-1 with Anna"). |
| 1-1 loop | Agenda items accumulate per person; "start 1-1" opens agenda + notes; check off items, unfinished carry over; follow-ups with owner (me/them); previous meeting's notes visible. No cadence/reminders yet. |
| TUI | Vim-style modal keys (j/k, g-prefixes, `/` search, `:` / Ctrl-K palette), box-drawing panes, monospace, neutral dark theme with one accent. Mouse/touch secondary. |
| Storage | One SQLite file **outside the repo** (default `~/.xo/xo.db`, env-configurable, Docker volume). Bodies stored as Markdown. Markdown export command for backup. |
| Calendar | None in v0.1. |
| Stack | pnpm, TypeScript strict, one package: `src/server`, `src/client`, `src/shared`. Fastify + built-in `node:sqlite`. Vite + Preact, hand-written TUI CSS. Vitest; one Playwright smoke test. |

Open question (relevant once ZDR is turned on): OpenRouter docs say ZDR applies to transcription, but routing
options (order/only/ignore) don't; confirm audio ZDR enforcement with OpenRouter
before relying on it for sensitive dictation. Verify the transcription request/
response shape against https://openrouter.ai/docs/guides/overview/multimodal/stt
when implementing.

## Commands

Keep this list accurate — every command here must work. Needs Node 26 and pnpm.

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Server (`node --watch`, port 3000) + Vite client (127.0.0.1:5173, strict port); open `http://localhost:5173`. Local `.env` needs `XO_COOKIE_INSECURE=true` and `XO_PUBLIC_ORIGIN=http://localhost:5173`. Use `XO_LLM=fake` until step 4 lands (the real OpenRouter factories are stubs and throw at startup). **Never run Vite with `--host` in this repo.** |
| `pnpm typecheck` | `tsc` for server/shared and for the client |
| `pnpm test` | Vitest (unit + API tests; no network, no API key needed) |
| `pnpm build` | `vite build` (client root `src/client`) into `dist/client` |
| `pnpm start` | Run the server (serves API + `dist/client`) with Node type stripping |
| `pnpm e2e` | Playwright smoke test — **available after step 12** (first time: `pnpm exec playwright install chromium`) |
| `pnpm xo setup [--force]` | Create the single user (password + TOTP) — **functional after step 2** |
| `pnpm xo export [--out <dir>]` | Markdown export — **functional after step 11** |
| `docker build -t xo .` | Container image — **available after step 11** |

There is no linter or formatter in v0.1; `pnpm typecheck` (strict) is the gate.

## Code conventions and contracts

Established in step 1. Every programmer brief must point at this section.

- **Server runs TypeScript directly** (Node 26 type stripping, no server build):
  use `.ts` import extensions and erasable-only syntax: no `enum`, `namespace`,
  or constructor parameter properties.
- **Route modules** are registered by `src/server/app.ts` inside one
  `/api`-prefixed scope, so route files declare relative paths
  (`/people/:id/agenda`, not `/api/people/...`). `/api/health` is registered in
  that same scope in `app.ts`. Never register an `/api` route outside it:
  a root `onRoute` tripwire in `buildApp` throws at startup if you do.
- **Auth guard:** `authGuard(api, { deps })` adds an `onRequest` hook to the
  `/api` scope, so every route in it requires a session. The only way to opt out
  is `config: { public: true }` on the route (health now, login in step 2),
  read via `req.routeOptions.config`. Never decide auth from the raw `req.url`.
  Unmatched `/api*` paths are handled by the root not-found handler using
  `isApiRequest` (decoded, case-folded; a decode failure counts as API).
  Test unmatched-path and no-store behaviour through `buildApp`, not
  `makeRouteApp`, which has no guard or fallback.
- **Validation:** Fastify's ajv runs with `removeAdditional: false` and
  `coerceTypes: false` (`serverOptions()` in `app.ts`). Unknown fields and wrong
  types are rejected with 400. Querystring/params values are strings (use a
  digit `pattern`) and are converted in the handler; nullable body fields
  declare e.g. `type: ['integer', 'null']`. Every route declares a
  body/params/query schema.
- **Secrets:** `loadConfig` returns `{ config, openRouterApiKey }`; `Config`
  has no key. Only `main.ts` hands the key to the OpenRouter factory.
- **Errors** use the shared error shape from `src/server/errors.ts`; 5xx
  responses never include internal messages.
- **CLI commands** (`src/server/cli/*.ts`) export
  `run(args: string[], ctx: { config: Config; db: DatabaseSync }): Promise<void>`;
  `cli/main.ts` handles config, DB open/migrate and close.
- **CSP** allows `style-src 'self'` only: no inline `<style>` or
  `style="..."` in the client (setting `el.style` from JS is fine).
- **Tests:** use `test/helpers.ts` (`makeTestDb`, `makeDeps`, `makeRouteApp`)
  and the fake classifier/transcriber.
- **Client keyboard and focus:** key layers (`useKeys`) and overlay focus
  register in `useLayoutEffect`, never `useEffect`. Overlays use the `modal`
  scope (only Esc and Ctrl-K pass through) and `components/Overlay.tsx`. Views
  that own the chat or search input consume focus requests with
  `useFocusRequest('chat' | 'search', ...)`. Async results check the session
  `epoch()` before writing shared signals.
- **Browser testing:** after `pnpm build`, restart any running XO server
  (it caches `index.html`). Scripts that log in must wait out the 30 s TOTP step
  or create a fresh user per run (`setupUser`, confirming with the previous
  step's code).
- **Local dev with a key before step 4 lands:** set `XO_LLM=fake`, otherwise
  startup fails on the "not implemented" OpenRouter stubs.

## Security rules (non-negotiable)

This app holds sensitive CEO data on a public server.

- Never commit secrets, API keys, `.env` files, or the database. Data and
  secrets live outside the repo.
- **OpenRouter key (local dev):** in `.openrouter-key` at the project root
  (one line, `chmod 600`, listed in `.gitignore`). Never `cat`, print, log,
  or copy it into code, tests, plans, or messages. The server reads the key from
  `OPENROUTER_API_KEY`, falling back to the file at `OPENROUTER_KEY_FILE`
  (default `./.openrouter-key`). In production, use an env var or a secrets
  file mounted into the container, never baked into the image.
  (`.dockerignore` must exclude it too.)
- Tests never call OpenRouter; they use the fake classifier/transcriber. Any
  live check against OpenRouter needs the user's OK first (it costs money and
  sends data out).
- Every API route except login requires an authenticated session.
- Treat all user input and all LLM output as untrusted (escape on render,
  validate on the server, parameterized SQL only).
- Do not log note contents, transcripts, or credentials.
- Auth, network calls to OpenRouter, storage, and file export are
  security-sensitive: changes to them get a `@security-reviewer` pass.

## Workflow

Follows the global plan → implement → review → fix loop (`~/.claude/CLAUDE.md`):
`@planner` → `@programmer` → `@reviewer` (+ `@security-reviewer` when
sensitive) → fixes via SendMessage to the same programmer. Programmers never
commit; commit only after a clean review and when the user asks.

Plans live in `docs/plans/YYYY-MM-DD-<slug>.md`.

## Git

- Remote: `origin` = `git@github.com:niclassodergard/xo.git`, default branch `main`.
- **Every time the user asks for a commit, also push it to `origin`** in the same
  step (`git push`, set upstream on first push). A commit isn't done until
  it's pushed.
- Before committing, check `git status` and make sure no secrets or data are
  staged (`.openrouter-key`, `.env*`, `*.db`).

## Lessons learned

Record every mistake here so it isn't repeated: what went wrong, and the rule
that prevents it. Add an entry as soon as a mistake is noticed — by Claude or
pointed out by the user.

- **2026-11-15 — Subagents can't interview the user.** The `@planner`
  subagent has no working `AskUserQuestion` in this environment and came back
  blocked. **Rule:** the coordinator (main session) runs the interview itself
  with AskUserQuestion, then briefs `@planner` with all answers to write the
  plan.
- **2026-11-15 — Messages to a finishing agent arrive late.** Updates sent to
  the planner while it was wrapping up landed after its report, so the first
  "final" plan missed them. **Rule:** after sending an agent mid-task updates,
  verify its output reflects them (grep the file) before presenting it as done.
- **2026-11-15 — zsh doesn't word-split variables.** A loop over command
  strings (`for c in "pnpm install" ...; do $c; done`) failed with "command
  not found". **Rule:** run checkpoint commands one by one, never via a loop
  over command strings.
- **2026-11-15 — Fastify strips unknown fields by default.** The default ajv
  `removeAdditional: true` silently drops properties that
  `additionalProperties: false` should reject. **Rule:** keep
  `removeAdditional: false` (see Code conventions).
- **2026-11-15 — Auth guard bypass via percent-encoding (caught in review).**
  The guard checked `req.url.startsWith('/api/')`, but the router decodes
  the path, so `/%61pi/people` reached `/api/people` unauthenticated.
  **Rule:** security decisions use the matched route
  (`req.routeOptions`), never the raw URL string; tests for access control
  always include encoded and mixed-case path variants.
- **2026-11-15 — Vite dev server exposed secrets.** With `root: '.'`, Vite
  served `.openrouter-key` and `*.db` files over HTTP (only `.env*` is denied by
  default). **Rule:** the client root is `src/client`, nothing secret lives
  under any served directory, Vite binds 127.0.0.1, and Vite never runs
  with `--host`.
- **2026-11-15 — Production checks keyed only on `NODE_ENV`.** A deployment
  without `NODE_ENV=production` would have run with insecure cookies.
  **Rule:** safety checks key on observable facts (origin host, bind address),
  with `NODE_ENV` as an extra gate only.
- **2026-11-15 — Test helpers must mirror the real app.** `makeRouteApp`
  lacked the cookie plugin that `app.ts` registers. **Rule:** test helpers
  register the same root-level plugins and prefixes as `buildApp`, and any hook
  a later step needs is installable via `buildApp` options.
- **2026-11-15 — Coordinator brief asked for a harmful side effect.** I asked
  for an existing DB directory to be chmod'ed to 0700, which would also tighten
  e.g. the user's home dir if the DB lived there. **Rule:** XO never changes
  permissions on files or directories it didn't create; it warns instead.
  Think through side effects on the user's machine before briefing a "fix".
- **2026-11-15 — Secrets don't belong in shared config.** The API key sat in
  `Config`, which reaches every route. **Rule:** loaders return secrets
  separately, and only the one consumer receives them.
- **2026-11-15 — A built-in parser's 400 can mask a 415.** A content-type
  rejection test sent `application/json` with a non-JSON body, so Fastify's JSON
  parser answered first. **Rule:** when testing content-type rejection, send a
  body that the built-in parser accepts (e.g. `{}`).
- **2026-11-15 — Wrapper plugins doubled the route prefix.** A test plugin
  forwarded its `opts` (which carry `prefix: '/api'`) to child plugins, so routes
  ended up at `/api/api/...`. **Rule:** forward only `{ deps }` to child
  plugins, never the outer `opts`.
- **2026-11-15 — SQLite `LIKE` only folds ASCII case.** "åsa" didn't find
  "Åsa", and the user writes Swedish. **Rule:** any case-insensitive text
  comparison in SQL goes through a Unicode-aware fold (NFC + `toLowerCase`),
  never plain `LIKE`/`lower()`.
- **2026-11-15 — Name matching missed Swedish forms.** Swedish ”…” quotes,
  hyphenated double names (Anna-Karin matched "Anna"), genitive "Annas" and
  decomposed (NFD) input all broke matching, and a first-name hit tied with an
  exact full-name hit. **Rule:** name handling is tested with Swedish forms
  (”…”/„…“ quotes, hyphenated names, genitive -s, NFD input), and exact
  full-name/alias matches beat first-name matches.
- **2026-11-15 — Client listener and signal pitfalls.** A `focusout`
  listener was registered twice (once anonymously, so it could never be
  removed), and a module-level `effect()` read signals declared later in the
  file (temporal dead zone, failing only under test). **Rule:** every
  `addEventListener` uses a named handler that its cleanup removes, and a
  module declares all its signals before any top-level `effect()`.
- **2026-11-15 — macOS sed is BSD sed.** `sed -i` without a suffix argument
  fails. **Rule:** use Edit or a short Python script for in-place edits.
- **2026-11-15 — Cross-entity links weren't owner-checked.** An agenda item
  could be resolved into another person's meeting. **Rule:** a foreign key
  linking two things that both belong to a person is checked for the *same
  owner*, not just existence.
- **2026-11-15 — One result kind crowded out the rest.** Search with many
  note hits returned no person. **Rule:** combined per-kind results under one
  limit get a fair share per kind.
- **2026-11-15 — Overlay focus raced the first keystrokes (found in a real
  browser, not in unit tests).** Focus in `useEffect` ran after paint, so the
  first typed keys ran as NORMAL commands (`u` triggered undo).
  **Rule:** inputs in overlays focus synchronously (`useLayoutEffect` or a
  ref callback), modals block lower key layers, and changes to keyboard
  handling get a real-browser check.
- **2026-11-15 — Global rate limits lock out the owner.** An anonymous
  global login cap lets anyone deny the owner access. **Rule:** throttles on
  public endpoints must not let strangers exhaust the owner's budget (XO uses
  a trusted-device bucket).
- **2026-11-15 — A released-on-close resource needs a deadline.** A stalled
  upload held a voice slot forever. **Rule:** anything held until the
  connection closes also gets a timeout, and the slot is freed explicitly where
  the connection is aborted (not via a later `close` event). Prove it with a
  follow-up request that would fail if the slot leaked.
- **2026-11-15 — Same-step TOTP reuse.** `setupUser` consumes the confirming
  step, so logging in right after with the same code fails. **Rule:**
  contracts that consume a TOTP step say so; tests confirm with the previous
  step's code.
- **2026-11-15 — Plan amendments must say what they override.** The ZDR
  amendment said it overrides text "above" it, but stale rules sat below it
  (tests, acceptance criteria). **Rule:** an amendment names every section it
  supersedes, and the stale text is edited in the same pass.
- **2026-11-15 — "Absent" tests that prove nothing.** A log test overrode
  the logger after the app was built, so it captured nothing and passed
  vacuously. **Rule:** every "X never appears" assertion is paired with a
  "the thing we captured is really there" assertion in the same test.
- **2026-11-15 — Behaviour changes break other steps' tests.** Step 2 made
  login public, which broke a step 1 test, and it reported "done" anyway.
  **Rule:** when a change alters behaviour that another file's test asserts,
  name that test in the hand-back and re-run the full suite.
- **2026-11-15 — A failed save looked saved.** `TextEdit` marked text as saved
  before `onSave` succeeded, so a draft kept across a 401 was never stored.
  **Rule:** save callbacks return a Promise; editors stay dirty until it
  resolves. A component that can send data from an unmount or timer path is
  gated on the session `epoch()` it was mounted in and clears its timers on
  unmount (an orphaned autosave once could save discarded text after
  re-login).
- **2026-11-15 — Hiding isn't removing.** The 401 lock first hid the app with
  CSS while its loaded data stayed in the DOM. **Rule:** when access ends,
  unmount or clear server-loaded data; keep only what the user typed.
- **2026-11-15 — An overlay opened underneath another.** Ctrl-K over the
  Prompt opened the palette behind it, so the user typed into a box they
  couldn't see. **Rule:** a global key that opens an overlay is a no-op while
  another overlay owns the keyboard.
- **2026-11-15 — `in` matched inherited keys in stored JSON.** A `filed`
  ref with kind `"toString"` passed `kind in KIND_TABLE`, threw, and would have
  stopped the daily purge forever. **Rule:** check keys from parsed or stored
  data with `Object.hasOwn` (or a `Map`/`Set`), and a background job treats a bad
  row as "skip this row", never as fatal.
- **2026-11-15 — Pattern guards checked only the first character.** The
  route tripwire caught `/*` and `/:x` but not `/ap*` or `/a:x`. **Rule:** a
  guard over route patterns tests the whole segment, with test cases for a
  wildcard or parameter at the start, middle and end.
- **2026-11-15 — "Erase" must cover every copy.** The 30-day purge deleted
  the note but left its text in `captures` (chat history), so it was never really
  erased. Purging also allowed ids to be reused. **Rule:** a deletion or retention
  rule lists every table and column holding that content, and is tested by
  scanning *all* tables afterwards; erased ids are never reused
  (`AUTOINCREMENT`); `secure_delete` is on.
- **2026-11-15 — CLAUDE.md contradicted the amended design.** After the review
  changed the guard design, the conventions section still described the old
  one, and step 2's brief would have pointed at it. **Rule:** whenever a review
  amends a design, grep CLAUDE.md, the plan and stub comments for the old rule
  and update them in the same pass.
  **Repeated 2026-11-15:** the step 3 contract note in the plan went stale
  after a later fix round ("last 20 meetings", "dangling refs") and was caught
  in review. **Strengthened rule:** after *every* fix round that changes a
  contract, rewrite the affected plan amendment before sending the step back to
  review — the amendment is part of the fix.

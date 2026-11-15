# XO — project guide for Claude

XO is a single-user "run my life" webapp for a CEO. It is a web app that looks
like a TUI. Text and voice typed into a chat interface are classified into
documents (notes, tasks, people, 1-1 meetings) or attached to a person. A core
use case is preparing and running many 1-1 meetings.

**Keep this file current.** It is how Claude keeps control of the project across
sessions. Update it when a decision changes, when a command or convention is
added, and — always — when a mistake is made (see "Lessons learned" below).

## Status

- v0.1 implemented (step 12 done; see below). Plan: `docs/plans/2026-11-15-xo-v0.1.md`
  (the source of truth for v0.1 scope, steps, and acceptance criteria; read
  section 6 "Amendments" — they override older text).
- **Done and reviewed (2026-11-15):** step 1 (foundation), 2 (auth: password +
  TOTP, sessions, trusted-device cookie), 3 (data layer, CRUD, search, 30-day
  purge), 4 (OpenRouter classifier/transcriber/voice route, ZDR opt-in),
  5 (client shell: TUI, keys, router, API client, login, session lock, drafts),
  6 (shared parsing and name matching).
- **Done and reviewed (2026-11-15, wave C):** step 7 (capture pipeline: classify, ask, file, undo, reclassify), 8 (chat, actions, notes, people, search views), 9 (person + 1-1 meeting views), 10 (voice: push-to-talk, dictation, commands), 11 (Markdown export, Dockerfile, Tailscale deploy docs, README).
- **Step 12 (2026-11-15): v0.1 is implemented and verified automatically**: `pnpm typecheck`, `pnpm test` (incl. the full-app integration test: route sweep with encoded/mixed-case paths, locked public route set, CSRF/Origin, cookie attributes, ZDR on/off through a fake fetch, no secrets in responses, capture/undo and 1-1 loops), `pnpm build`, `pnpm e2e` (keyboard-only Chromium flow incl. a 390px voice Send/Discard check with a fake mic). Acceptance criteria (section 8):
  1. all commands pass, no API key: pass
  2. setup, login, same error, rate limit: pass (interactive `pnpm xo setup` prompt not run by hand: manual)
  3. 401 / 403 / cookie attributes: pass
  4. prefixes file without an LLM call: pass
  5. LLM classify, undo, reclassify: pass
  6. unsure / failing / no key asks first: pass
  7. person linking, unknown and ambiguous names: pass
  8. 1-1 loop: pass
  9. keyboard reachability: pass (e2e, zero mouse events); mouse/touch use: manual, not automated
  10. push-to-talk and voice commands: unit and fake-mic e2e pass; real hold-Space transcription and real mic/Safari: manual
  11. ZDR on/off, key never leaks (responses, logs, client bundle): pass; Docker image: blocked (no Docker)
  12. one SQLite file, Markdown export: pass
  13. `docker build` and run, non-root, `/data`: blocked (Docker not installed)
  14. monospace, box-drawing, dark, one accent, phone width: pass at 390px in Chromium; use on a real phone: manual
- **Outstanding manual checks:** `docker build` and run (Docker was not installed; Dockerfile unverified), real OpenRouter classification and transcription (needs the user's OK), push-to-talk on real Chrome/Safari desktop and iOS (incl. the Send/Discard prompt on a real phone), real authenticator app, `tailscale serve` header behaviour (README checklist), audio ZDR enforcement at OpenRouter.
- Update this section as milestones land.

## Production (user's tailnet instance)

- Runs from a **separate git worktree** at a reviewed commit: `~/.xo/app`
  (never from this checkout — dev builds replace `dist/`). Config:
  `~/.xo/xo.env` (0600, outside the repo); DB: `~/.xo/xo.db`.
- Listens on `127.0.0.1:3100`; exposed tailnet-only via
  `tailscale serve --bg --https=8444 http://127.0.0.1:3100` →
  `https://mini.tail795763.ts.net:8444`. Other `serve` entries on this Mac
  (443, 8443, Funnel on 10000) belong to other apps — never touch them.
  Port 3000 is another app.
- Real OpenRouter, ZDR off (user decision). Forged-XFF check passed:
  `XO_TRUST_PROXY=1` is correct behind `tailscale serve`.
- **Deploy** (only after a clean review and a commit):
  `git -C ~/.xo/app checkout --detach <commit>`, then in `~/.xo/app`:
  `pnpm install --frozen-lockfile --offline && pnpm build`, restart the server
  (`node --env-file=$HOME/.xo/xo.env src/server/main.ts` from `~/.xo/app`),
  then verify the served page's JS asset returns 200 over the tailnet URL.
  Sessions live in the DB, so a restart doesn't log the user out.
- The server currently runs as a background process of the Claude session; it
  stops when the session ends (no launchd service yet).

## Settled decisions (v0.1, interview of 2026-11-15)

| Area | Decision |
|---|---|
| Users / access | Single user, password + TOTP login. **Reachable only over Tailscale** (user decision 2026-11-15, replaces "public server"): XO is not exposed to the internet; `tailscale serve` provides HTTPS on the tailnet (needed for the microphone). Stay portable: one Node process + SQLite file, Dockerfile. Login/auth hardening stays in place as defence in depth. |
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
| `pnpm dev` | Server (`node --watch`, port 3000) + Vite client (127.0.0.1:5173, strict port); open `http://localhost:5173`. Local `.env` needs `XO_COOKIE_INSECURE=true` and `XO_PUBLIC_ORIGIN=http://localhost:5173`. Use `XO_LLM=fake` for local dev (with `.openrouter-key` present the server otherwise calls OpenRouter for real, which needs the user's OK). Never run Vite with `--host`. |
| `pnpm typecheck` | `tsc` with `tsconfig.server.json` (server, shared, test, config files), `tsconfig.client.json` (client, JSX) and `tsconfig.e2e.json` (`e2e/`, `playwright.config.ts`). The root `tsconfig.json` is solution-style (references only) so editors pick the right config per file |
| `pnpm test` | Vitest (unit + API tests incl. `test/integration/app.test.ts`, the full-app route sweep; no network, no API key needed) |
| `pnpm build` | `vite build` (client root `src/client`) into `dist/client` |
| `pnpm start` | Run the server (serves API + `dist/client`) with Node type stripping |
| `pnpm e2e` | Playwright smoke test (keyboard-only, `e2e/smoke.spec.ts`). `e2e/global-setup.ts` runs `pnpm build`, creates a temp DB + user via `setupUser`, starts the real server on a free 127.0.0.1 port with `XO_LLM=fake` (no `.env`, no key), tears it down. First time (or when it warns that no browser was found): `pnpm exec playwright install chromium`. If the bundled browser is missing it uses the newest `chrome-headless-shell` in the Playwright cache (logs which one, warns on a version mismatch); override with `XO_E2E_CHROMIUM=/path/to/chrome`. `XO_E2E_SKIP_BUILD=1` skips the build step. Needs no other server on its port (picked at random) |
| `pnpm xo setup [--force]` | Create the single user (password + TOTP) |
| `pnpm xo export [--out <dir>]` | Markdown export (default `./xo-export-YYYYMMDD-HHmmss`; target must be new or empty; dir 0700, files 0600; skips soft-deleted rows) |
| `docker build -t xo .` | Container image (non-root, `/data` volume, no key inside; supply the key at run time). README has the `docker run` and `tailscale serve` setup (Caddy is an optional alternative). Not yet built locally: Docker was unavailable in step 11 |
| `docker exec -it xo node src/server/cli/main.ts setup` | Create the user inside a running container (no pnpm in the runtime image) |

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
- **Navigation:** when a view's Esc/back target is the entry just left, use
  `replace` (or `back()` if history holds it), so two views never ping-pong.
- **Browser testing:** rebuild and restart the server *immediately* before each
  browser run (parallel builds replace `dist/` and break a cached `index.html`);
  clear fields with `page.fill(sel, '')`. After `pnpm build`, restart any running XO server
  (it caches `index.html`). Scripts that log in must wait out the 30 s TOTP step
  or create a fresh user per run (`setupUser`, confirming with the previous
  step's code).
- **Local dev uses `XO_LLM=fake`:** with `.openrouter-key` present and `XO_LLM` unset, the server calls OpenRouter for real (costs money, sends data out) — that needs the user's OK.

## Security rules (non-negotiable)

This app holds sensitive CEO data. It is reachable only over Tailscale, but every
rule below still applies as defence in depth (treat any tailnet device as untrusted).

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
- **2026-11-15 — "Epoch-guarded on read" isn't "cleared on lock".** A
  module-level feed of landed captures was filtered by epoch when read but kept
  in memory through a 401 lock. **Rule:** module-level holders of server data
  clear on `session === null`, not only on logout.
- **2026-11-15 — Hiding isn't removing.** The 401 lock first hid the app with
  CSS while its loaded data stayed in the DOM. **Rule:** when access ends,
  unmount or clear server-loaded data; keep only what the user typed.
- **2026-11-15 — Write paths bypassed the redaction rule.** The list hid a
  deleted item's capture, but undo/reclassify still returned its text and
  reclassify brought it back for good. **Rule:** redaction and erasure rules are
  enforced on every read *and* write path on the server, never only in the
  client or one endpoint.
- **2026-11-15 — Async results stole focus mid-typing.** A chat submit that came
  back with a question blurred the input while the user kept typing, so their
  letters ran as commands (`d` discarded a capture). **Rule:** an async result
  never moves focus if the user has typed since the request started; a second
  submit is queued, never dropped.
- **2026-11-15 — User-typed text was silently dropped.** A per-key in-flight
  guard meant for toggles also swallowed a second distinct create. **Rule:**
  dedupe guards apply to repeated actions on one item, never to creates;
  user-typed text is never discarded without telling the user.
- **2026-11-15 — A visible "undo" offer didn't match the key.** Pressing `u`
  after an "undo" flash undid an unrelated chat capture. **Rule:** an action
  offered in a flash is reachable by keyboard, and doesn't collide with a global
  key of the same meaning.
- **2026-11-15 — Feature-level window listeners fought the key engine.** Voice's
  own Esc listener couldn't stop the global Esc, so cancelling a recording also
  navigated back. **Rule:** feature keys are bindings in the key engine with the
  right scope; test that the global binding doesn't also fire.
- **2026-11-15 — Production ran from the dev checkout and broke.** I started the
  user's tailnet XO from the repo itself; later `pnpm build`/`pnpm e2e` runs
  replaced `dist/client`, so the running server served a page whose script
  404'd. **Rule:** production runs from a separate git worktree at a reviewed
  commit (`~/.xo/app`), never from the working checkout. Deploy = update that
  worktree to the new commit, `pnpm install --frozen-lockfile --offline`,
  `pnpm build`, restart. Verify the served page's asset returns 200.
- **2026-11-15 — An advertised key did something else.** The voice prompt said
  "Send (Enter)", but with the chat input focused Enter submitted the chat draft
  instead. **Rule:** every field `onKeyDown` that acts on a key (Enter too, not
  only arrows) checks `modalOpen()` first, and any key a prompt advertises must
  work in every mode the prompt can appear in — test it from INSERT as well.
- **2026-11-15 — Roving focus turned Enter into a native click.** Focusing the
  highlighted answer button meant Enter/Space were handled by the browser, not
  the key engine, so Enter answered a question the user had moved away from.
  **Rule:** keyboard highlights in XO are visual plus a live-region
  announcement; actions go through the engine and re-check the target. Every
  overlay returns focus to the element that had it when it opened.
- **2026-11-15 — Field-level key handlers bypassed the modal check.** The chat
  input's own `onKeyDown` acted on arrows behind Help and during a voice
  recording, and a recall stash in component state lost typed text on remount.
  **Rule:** field handlers check that no modal layer is open; every overlay
  takes focus even without focusable children; any "never lose typed text"
  state lives in the store next to the draft.
- **2026-11-15 — Key choices must survive the user's OS.** I specified
  Ctrl-↑/↓ for chat history recall; macOS takes those for Mission Control, so it
  would never reach the browser. **Rule:** the user is on macOS — before
  assigning a shortcut, check it isn't taken by macOS or the browser (Ctrl-↑/↓/←/→,
  Cmd-anything, Ctrl-Space, Ctrl-Tab). Arrows typed in a text field never reach the
  key engine; field-level behaviour lives in the field's own `onKeyDown`.
- **2026-11-15 — A security sweep can pass vacuously.** The "every route needs
  auth" test checked the 401 response but not *which* route answered, so a probe
  path that missed its route passed via the not-found fallback, and a new root
  GET route would not have been noticed. **Rule:** access-control sweeps assert
  the answering route, and pin the full set of routes outside the guarded scope.
- **2026-11-15 — e2e assertions that don't match the UI model.** A textarea
  body was asserted with `toContainText`, keyboard-activated clicks were counted
  as mouse use, and keys were pressed before the view had loaded. **Rule:** assert
  editor contents with `toHaveValue`; filter `detail === 0` clicks when proving
  keyboard-only; wait for loaded content (e.g. a pane title), not just the URL,
  before the next key.
- **2026-11-15 — Port 3000 is taken on the dev Mac** by an unrelated
  `next-server`. **Rule:** local runs and browser scripts use another port
  (`XO_PORT`), or check `lsof -iTCP:3000` first.
- **2026-11-15 — Parallel programmers misattribute test failures.** A failure
  in another programmer's in-progress file was briefly blamed on the wrong
  change. **Rule:** in a shared checkout, re-run `pnpm test` before attributing a
  failure, and name the owning step. To check which tsconfig an editor uses for a
  file, use tsgo's `updateSnapshot({ openFiles })` + `getDefaultProjectForFile`
  (example in the step 12b report), not `--showConfig`.
- **2026-11-15 — "Is it done?" must follow the thing just answered.** Focus
  returned to the chat input only when *no* capture anywhere was pending, so older
  questions stayed live and stray typing answered them. **Rule:** decide focus
  from the item just acted on. Queues of user-typed text are module-level (survive
  a 401 remount) and wiped on logout; they remove entries by identity (never
  `shift()` after an await) and carry a generation that logout bumps. When a keyboard-focus rule changes, update
  or flag the browser scripts that assume the old rule in the same pass.
- **2026-11-15 — Re-resolving lost the user's explicit choice.** A fix that
  re-checked names against current people turned "create Lisa" into a silent
  link to "Lisa Berg", and an archived link into a guess. **Rule:** re-resolving
  stored state keeps the original question's strictness — only an exact match
  may replace an explicit choice; anything else asks.
- **2026-11-15 — Unattended capture of a sensitive resource.** A mic recording
  started by toggle and forgotten was auto-uploaded at the 2-minute limit.
  **Rule:** anything that records or holds a sensitive resource gets a discard
  path on tab hidden, `pagehide`, blur and session end, and only auto-sends while
  the user is demonstrably present (key held).
- **2026-11-15 — Destructive keys had a hidden fallback target.** `u`/`r`
  acted on "the newest filed capture" when the selection wasn't filed, so stray
  typing undid unrelated items. **Rule:** destructive shortcuts act only on the
  visible selection. Edit modes that hold drafts are derived from persisted
  `drafts` at load, not only from component state. A scrolling log plus a pinned
  input needs `min-height: 0` down the whole flex chain; check at phone width.
- **2026-11-15 — Sensitive output written in place.** A failed export left a
  partial plaintext directory that also blocked retries. **Rule:** write
  sensitive output to a private temp sibling and move it into place; clean up on
  failure.
- **2026-11-15 — Collision fallbacks must be checked too.** The export's
  `<slug>-<id>` fallback could equal another person's plain slug. **Rule:** a
  fallback name is itself checked for collisions.
- **2026-11-15 — Parallel steps coded against an unfinished contract.** The
  Chat view inferred "deleted" from blank fields while the server marked it
  differently, and a cast (`c as {deleted?: boolean}`) hid the mismatch from
  the compiler. **Rule:** when a parallel step depends on another's API, the
  coordinator relays the final contract as soon as it lands, and states are
  modelled by explicit fields; no casts that bypass shared types.
- **2026-11-15 — Optimistic UI before the in-flight guard.** A fast second
  key press would have flipped the UI with no request sent. **Rule:** check any
  in-flight or dedupe guard *before* applying an optimistic change.
- **2026-11-15 — View steps shipped without a browser check.** Unit tests of
  pure helpers cover none of the focus, mode or overlay behaviour. **Rule:**
  every client view step gets a scripted real-browser check of its key flows
  before (or as part of) review; briefs for view steps say so.
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

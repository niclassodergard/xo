# XO — project guide for Claude

XO is a single-user "run my life" webapp for a CEO. It is a web app that looks
like a TUI. Text and voice typed into a chat interface are classified into
documents (notes, tasks, people, 1-1 meetings) or attached to a person. A core
use case is preparing and running many 1-1 meetings.

**Keep this file current.** It is how Claude keeps control of the project across
sessions. Update it when a decision changes, when a command or convention is
added, and — always — when a mistake is made (see "Lessons learned" below).

## Status

- v0.1 prototype: being planned. Plan: `docs/plans/2026-11-15-xo-v0.1.md`
  (the source of truth for v0.1 scope, steps, and acceptance criteria).
- Update this section as milestones land.

## Settled decisions (v0.1, interview of 2026-11-15)

| Area | Decision |
|---|---|
| Users / access | Single user. Hosted on a **public server** behind a login. Hosting target undecided → stay portable: one Node process + SQLite file, Dockerfile, behind an HTTPS reverse proxy (e.g. Caddy). Develop locally first. |
| Auth | Password + TOTP. Secure session cookie (HttpOnly, Secure, SameSite), rate-limited login, CSRF protection. |
| Doc types | Notes, tasks/actions, people, 1-1 meetings (agendas + meeting notes). Out of scope: journal, projects, decisions, goals. |
| Classification | LLM classifies chat input. **If unsure it must not guess** — it asks the user to classify (keyboard-selectable inline choice). Confident results are filed visibly with one-key undo/reclassify. Prefix commands (`/note`, `/todo`, `@person`…) force the type. |
| People | Known names/aliases link automatically; unknown names → ask before creating a person. |
| LLM | OpenRouter only (one key, server env var), Claude model, configurable. Every request sends `provider: { zdr: true }`. Classifier sits behind an interface; tests use a fake. |
| Voice | Push-to-talk; browser records (MediaRecorder) → our server → OpenRouter `/api/v1/audio/transcriptions` with `zdr: true`. Dictation + a small set of voice commands ("open Anna", "start 1-1 with Anna"). |
| 1-1 loop | Agenda items accumulate per person; "start 1-1" opens agenda + notes; check off items, unfinished carry over; follow-ups with owner (me/them); previous meeting's notes visible. No cadence/reminders yet. |
| TUI | Vim-style modal keys (j/k, g-prefixes, `/` search, `:` / Ctrl-K palette), box-drawing panes, monospace, neutral dark theme with one accent. Mouse/touch secondary. |
| Storage | One SQLite file **outside the repo** (default `~/.xo/xo.db`, env-configurable, Docker volume). Bodies stored as Markdown. Markdown export command for backup. |
| Calendar | None in v0.1. |
| Stack | pnpm, TypeScript strict, one package: `src/server`, `src/client`, `src/shared`. Fastify + built-in `node:sqlite`. Vite + Preact, hand-written TUI CSS. Vitest; one Playwright smoke test. |

Open question: OpenRouter docs say ZDR applies to transcription, but routing
options (order/only/ignore) don't; confirm audio ZDR enforcement with OpenRouter
before relying on it for sensitive dictation. Verify the transcription request/
response shape against https://openrouter.ai/docs/guides/overview/multimodal/stt
when implementing.

## Commands

_To be filled in once the project is scaffolded (install, dev, test, build,
lint, export, docker)._ Keep this list accurate — every command here must work.

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

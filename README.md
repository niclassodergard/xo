# XO

A single-user "run my life" web app, meant to be reachable only over your Tailscale tailnet. A calm, Claude-desktop-style UI: a sidebar, one ongoing conversation and the opened document beside it, light or dark following your system. Type or dictate into the conversation; the text is filed as a note, an action, or a 1-1 agenda item, and can be linked to a person and to a project. Run 1-1 meetings from the accumulated agenda. One Node process, one SQLite file, keyboard and voice first.

Needs Node 26 and pnpm. The server runs TypeScript directly (no server build step).

## Local development

```sh
pnpm install
cp .env.example .env     # then set the values below; .env is git-ignored
pnpm dev                 # server on :3000 + Vite on 127.0.0.1:5173
```

Open **`http://localhost:5173`** (not `127.0.0.1`): the browser origin must match `XO_PUBLIC_ORIGIN` exactly, or every state-changing request is refused. A local `.env` needs at least:

```
XO_COOKIE_INSECURE=true
XO_PUBLIC_ORIGIN=http://localhost:5173
```

`XO_LLM=fake` runs without OpenRouter (deterministic fake classifier and transcriber). Other commands: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm start`, `pnpm e2e`. See `CLAUDE.md` for the full list. Never run Vite with `--host`.

## First-time setup (create the user)

There is no web sign-up. Create the single user on the server:

```sh
pnpm xo setup            # interactive: password (min 12 chars, asked twice), then TOTP
pnpm xo setup --force    # replace the credentials; deletes all sessions and trusted devices
```

The command prints an `otpauth://` URI, the base32 secret and a QR code. Add it to an authenticator app and enter one valid code to confirm; only then is the user written. In Docker:

```sh
docker exec -it xo node src/server/cli/main.ts setup
# or, before the container runs, against the same volume and environment:
docker run --rm -it -v xo-data:/data -e XO_PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net xo node src/server/cli/main.ts setup
```

There is no recovery path other than `setup --force` on the server.

## Configuration

All settings are environment variables (a `.env` file is loaded by `pnpm start`/`pnpm xo`; in Docker pass them with `-e`/`--env-file`). Defaults in parentheses.

| Variable | Meaning |
|---|---|
| `XO_DB_PATH` (`~/.xo/xo.db`; `/data/xo.db` in Docker) | SQLite file. Directory 0700, file 0600 when XO creates them. Keep it outside the repo |
| `XO_HOST` / `XO_PORT` (`127.0.0.1` / `3000`; Docker sets host `0.0.0.0`) | Listen address |
| `XO_PUBLIC_ORIGIN` | Exact origin the browser uses, e.g. `https://<host>.<tailnet>.ts.net`. Required in production, must be https there. Checked against the `Origin` header |
| `XO_TRUST_PROXY` (`false`) | `false`, a hop count (`1`) or a list of proxy IPs/CIDRs. `true` is rejected. Set it to `1` behind `tailscale serve` (or Caddy) so rate limiting sees the real client IP |
| `XO_COOKIE_INSECURE` (`false`) | Dev only; refused when `NODE_ENV=production` |
| `XO_SESSION_TTL_DAYS` / `XO_SESSION_IDLE_DAYS` (`30` / `7`) | Absolute and idle session lifetime |
| `OPENROUTER_API_KEY` | OpenRouter key. If unset, read from the file named by `OPENROUTER_KEY_FILE` |
| `OPENROUTER_KEY_FILE` (`./.openrouter-key`) | One-line key file |
| `XO_OPENROUTER_ZDR` (`false`) | Zero Data Retention, see below |
| `XO_LLM_MODEL` (`anthropic/claude-haiku-4.5`) | Classifier model |
| `XO_QA_MODEL` (`anthropic/claude-sonnet-5.5`) | Model that answers questions about your data, see [Asking questions](#asking-questions) |
| `XO_STT_MODEL` (`openai/whisper-1`) | Transcription model |
| `XO_CLASSIFY_THRESHOLD` (`0.8`) | Below this confidence XO asks you instead of filing |
| `XO_LLM` (`openrouter`) | `fake` for offline dev and tests |

Without a key, classification and voice are off: every unprefixed capture asks you for the kind, and typing still works.

### OpenRouter key

- Local: put it on one line in `.openrouter-key` at the project root (`chmod 600`; git-ignored and docker-ignored).
- Production, preferred: a key file mounted read-only, e.g. `-v /srv/xo/openrouter-key:/run/secrets/openrouter:ro -e OPENROUTER_KEY_FILE=/run/secrets/openrouter`. The container runs as uid 1000 (`node`), so on the host: `chown 1000:1000 /srv/xo/openrouter-key && chmod 600 /srv/xo/openrouter-key`.
- Alternative: `OPENROUTER_API_KEY` from a 0600 `--env-file` (`docker run --env-file /srv/xo/xo.env`, same `chown`/`chmod`). Avoid `-e OPENROUTER_API_KEY=...` on the command line: it lands in shell history and `docker inspect`.
- The key is never baked into the image, never logged and never part of the shared config.

### Data retention at OpenRouter: `XO_OPENROUTER_ZDR`

Default **`false`**. With `false`, XO sends no `zdr` field, so OpenRouter may route a request to any provider endpoint, and that provider may retain or train on what it receives: capture text, the names and aliases of your people and the titles and aliases of your active projects (sent for classification; done and deleted projects are not sent), and recorded audio for voice. Treat everything you type or dictate as potentially retained upstream.

With `true`, every request (chat and transcription) carries a forced `provider: { zdr: true }` and is never retried without it. If no Zero Data Retention endpoint is available for the model, the request fails: classification falls back to asking you, and transcription reports an error. Whether OpenRouter enforces ZDR for audio transcription is not confirmed; check with OpenRouter before relying on it for sensitive dictation.

## Deploying (Tailscale)

XO is meant to be reachable **only on your tailnet**, never from the public internet. Run the server on loopback and let `tailscale serve` provide HTTPS at `https://<host>.<tailnet>.ts.net`. HTTPS matters: browsers only allow the microphone (voice) on a secure origin.

Prerequisites (Tailscale admin console, DNS page): enable MagicDNS and HTTPS Certificates. Note that certificate names are published in public Certificate Transparency logs, so the machine name must not be sensitive.

**Option 1: Node directly**

Use a separate production env file (mode 0600), e.g. `/srv/xo/xo.env`, with `NODE_ENV=production`, `XO_PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net`, `XO_TRUST_PROXY=1`, `XO_DB_PATH`, and the key settings. **Do not run this option in a checkout that has a dev `.env`**: `pnpm start` and `pnpm xo` load `./.env`, so `XO_COOKIE_INSECURE` or `XO_LLM=fake` from the dev file could apply. Call node directly with the production file instead:

```sh
pnpm install --frozen-lockfile && pnpm build
node --env-file=/srv/xo/xo.env src/server/cli/main.ts setup     # once: create the user
node --env-file=/srv/xo/xo.env src/server/main.ts               # listens on 127.0.0.1:3000; blocks
# in another terminal, once:
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status         # shows the https URL; `tailscale serve --bg --https=443 http://127.0.0.1:3000 off` removes it
```

Keep the server running with systemd, launchd or tmux, or use Option 2.

**Option 2: Docker published on loopback**

```sh
docker build -t xo .
docker volume create xo-data
docker run -d --name xo --restart unless-stopped \
  -v xo-data:/data \
  -p 127.0.0.1:3000:3000 \
  -e XO_PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net \
  -e XO_TRUST_PROXY=1 \
  -v /srv/xo/openrouter-key:/run/secrets/openrouter:ro \
  -e OPENROUTER_KEY_FILE=/run/secrets/openrouter \
  xo
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

`tailscale serve` syntax documented from Tailscale's Serve docs (https://tailscale.com/kb/1242/tailscale-serve, last validated 2026-01-26; the CLI form changed at client 1.52, so use a newer client) and the HTTPS requirements from https://tailscale.com/kb/1153/enabling-https (validated 2025-12-10). Serve only accepts `http://127.0.0.1` targets. Re-check against `tailscale serve --help` on your version. Do **not** use `tailscale funnel`: that publishes XO to the internet.

- The image runs as the non-root `node` user (uid 1000), sets `NODE_ENV=production`, stores data in the `/data` volume and has a `HEALTHCHECK` on `GET /api/health`. It never contains the key, `.env*` or a database (`.dockerignore`). The base image is a floating tag for now; pin it by digest after the first real build.
- A bind-mounted `/data` (instead of a named volume) must be owned by uid 1000: `chown 1000:1000 /srv/xo/data && chmod 700 /srv/xo/data`.
- **Publish the Node port on loopback only** (`127.0.0.1:3000`, or an internal Docker network). With `XO_TRUST_PROXY=1` XO believes `X-Forwarded-For`; if Node were reachable directly, anyone could spoof the client IP used by login rate limiting. The Tailscale docs do not state that Serve sets `X-Forwarded-For`; if it does not, all clients share the proxy's loopback IP and the per-IP limit becomes one shared bucket (still safe, see below). Check it once, from another tailnet device, in both directions:
  - If Serve does not set `X-Forwarded-For`, the server log shows `127.0.0.1` for failed logins (shared bucket, still safe).
  - If Serve passes a client-supplied header through, a tailnet device could choose its own rate-limit key. Send a failed login with a forged header (`curl -i -X POST https://<host>.<tailnet>.ts.net/api/auth/login -H 'Origin: https://<host>.<tailnet>.ts.net' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.9' -d '{"password":"x","totp":"000000"}'`) and confirm the server log shows the real tailnet IP (100.x.y.z), not `203.0.113.9`. If it shows the forged address, set `XO_TRUST_PROXY=false`.
- `XO_PUBLIC_ORIGIN` must be exactly the `https://<host>.<tailnet>.ts.net` origin you type in the browser.
- `docker exec` and `docker run` for CLI commands use the container environment, so `XO_PUBLIC_ORIGIN` must be set there too.
- `Caddyfile.example` is an optional alternative (Caddy bound to the Tailscale interface instead of `tailscale serve`). Its access log excludes request bodies, redacts `Cookie`/`Authorization` unless `log_credentials` is set (do not set it), and deletes the `X-XO-CSRF` header via a log filter.

### Login lockout and trusted devices

Login is rate limited in memory as defence in depth: 5 failed attempts per IP per 15 minutes and 20 globally for anonymous callers. After a successful login the browser gets a `__Host-xo_device` trusted-device cookie (valid 365 days, rotated on each login; only its hash is stored). A trusted browser has its own login bucket, so failed logins from elsewhere cannot lock you out of it.

Residual risk: a browser **without** that cookie (first login after setup, a new device, cleared cookies, or right after logout, which revokes the device) falls under the anonymous limits. Anyone who can reach XO can exhaust them and lock you out of such browsers for the window. Since XO is only reachable from devices on your tailnet, that means a device you or a tailnet member controls, not the internet. Recovery: wait out the 15-minute window, or restart the server, which clears the in-memory limiter. Advice: when away from home, do not log out on your only trusted device. Revoke devices by logging out in that browser, or `pnpm xo setup --force` (revokes all). Tailscale ACLs can further limit which tailnet devices may reach XO; a proxy-level limit is not needed on this path.

## Backup and export

All data is in the one SQLite file, which runs in WAL mode. **Do not just copy `xo.db` while the server runs**: recent writes live in `xo.db-wal`, and a copy of the main file alone can be stale or inconsistent. Either:

- stop the server and copy `xo.db` together with `xo.db-wal` and `xo.db-shm` if they exist (a clean shutdown checkpoints the WAL); or
- take a consistent online snapshot: `(umask 077; sqlite3 /path/to/xo.db "VACUUM INTO '/backup/xo-$(date +%F).db'")` (or `.backup`). The `umask 077` keeps the copy private; alternatively write into a 0700 directory.

In Docker, snapshot from the volume (e.g. `docker stop xo`, copy `xo.db` and any `-wal`/`-shm` out of the volume with `docker cp` or a throwaway container, `docker start xo`), and set the copy to 0600. Backup files hold everything in plaintext, including the password hash and TOTP secret: protect them like the database (0600, encrypted storage).

Markdown export for a readable, portable copy:

```sh
pnpm xo export                 # ./xo-export-YYYYMMDD-HHmmss
pnpm xo export --out ~/xo-md   # must be new or empty
```

It writes `projects/<slug>.md` (status, aliases, description, linked people, open and done actions, note titles), `people/<slug>.md` (notes, open agenda and actions, agenda items resolved outside meetings, each meeting with notes, resolved items and follow-ups), `notes/<date>-<slug>-<id>.md` (with a "Project:" line) and `actions.md` (action lines name their project). All times are UTC (also in file names and the default directory name). User Markdown (note and meeting bodies) is embedded as blockquotes so its headings cannot change the outline of the exported file. Soft-deleted items are not exported, and **captures still pending classification are not exported** (only what they filed). Everything is read in one consistent snapshot and written to a temporary sibling directory, then moved into place, so a failure leaves no partial plaintext behind. The target must be new, or an empty directory owned by you and not group/other-writable (otherwise it refuses); the parent directory must exist; directories are 0700 and files 0600; symlinks are never followed. The export is plaintext: keep it private (`xo-export-*` is git-ignored and docker-ignored). The export preserves links and HTML from your own Markdown as written, so do not treat a rendered export of untrusted content as safe.

In Docker, export inside the container, copy it out and delete it. Do not write into `/data`, which would leave plaintext in the volume:

```sh
docker exec xo node src/server/cli/main.ts export --out /tmp/xo-export
(umask 077; docker cp xo:/tmp/xo-export ./xo-export-$(date -u +%Y%m%d-%H%M%S))
docker exec xo rm -rf /tmp/xo-export
```

### Deletion and retention

- Deleting a note, action, agenda item or project is a soft delete; after 30 days a daily job (also run at startup) hard-deletes it and every copy of its content (including chat history). SQLite `secure_delete` is on and ids are never reused.
- **Deleting a project** hides it everywhere at once. Its actions and notes are kept, without a project; its people links, pins and recents are removed; a pending question is rebuilt from the remaining candidates, and dropped only when none remain (the capture then files without a project). After 30 days the purge removes the project row (title, aliases, description) and any pin or recents row left over. Text you typed yourself (for example `#apollo` in a note or in the conversation history) is your content and lives as long as that note or capture.
- **Backups and exports taken before a purge still contain the purged data.** Rotate and delete old backups accordingly.
- Person notes and meeting notes have no delete path in v0.1 (people are archived, not deleted).
- Migration 003 (ids never reused) **fails closed** if the database already has dangling foreign keys: the schema version stays unchanged and data is left intact. Fix or remove the dangling rows (take a backup first), then restart.

## Using XO

**Layout.** On a wide window: the sidebar on the left (`+ New`, `Search`, `Actions`, `Notes`, `People`, `Projects`, then **Pinned** and **Recents**, `Shortcuts` and `Log out` at the bottom), the conversation in the middle (centred while nothing is open) and the opened document in a panel on the right. The panel has Back, Expand (the document takes the whole width and the conversation is hidden) and Close. On a phone or a narrow window (under 900 px) the sidebar is a slide-in drawer and only one thing is shown at a time: the conversation or the document, with a Back button on the document. Pinned (people and projects) and Recents (the last 15 opened people, projects, 1-1s and notes) are stored on the server, so every device shows the same lists. Opening a document by typing its address does not add it to Recents; opening it from a link, the sidebar or the palette does. The theme follows the system (light or dark) and switches live.

There are no modes: typing always types, and there are no single-letter commands. A printable key pressed while nothing is focused goes to the composer. Everything is also reachable by mouse and touch: clicking a row runs its first action, and chips are real buttons.

### Keyboard

The list below matches `src/client/lib/keymap.ts` (the `Shortcuts` item and the Help overlay show that list).

| Key | Action |
|---|---|
| `Cmd-K` (`Ctrl-K`) | Search and commands (the palette) |
| `Cmd-J` (`Ctrl-J`) | New capture: focus the composer (on a phone, goes to the conversation first) |
| `Cmd-N` (`Ctrl-N`) | Same as `Cmd-J`, only where the browser delivers it. A normal Chrome or Safari tab keeps `Cmd-N` for a new window, so use `Cmd-J` |
| `Cmd-B` (`Ctrl-B`) | Show or hide the sidebar (the drawer on a phone) |
| `Esc` | Close the top dialog; else cancel a recording; else leave a text field (it saves); else close the document and focus the composer; else focus the composer |
| `Tab` / `Shift-Tab` | Move between lists, fields and buttons |
| any letter | Typing outside a field goes to the composer |
| `↑` / `↓` | Pick a row in a list or the conversation (not while a text field has focus) |
| `←` / `→` | Pick one of the highlighted row's action chips (for example Open, Undo, Reclassify) |
| `Enter` | Run the highlighted chip; with none highlighted, the row's first action. A destructive action always asks first. A question in the conversation has no default: highlight an answer first |
| Composer: `Enter` / `Shift-Enter` | Send / new line |
| Composer: `↑` in an empty composer | Move into the conversation at the newest item (`↓` past the newest returns) |
| Composer: `Option-↑` / `Option-↓` | Recall earlier or later texts; what you had typed is kept and comes back |
| `Option-Space` (hold) | Push-to-talk anywhere (see Voice) |
| `Space` (hold) | Push-to-talk when focus is not in a text field or on a button |

macOS and the browsers claim some keys, so XO uses none of `Cmd-T/W/Q/H/M/L/R`, `Cmd-digits`, `Cmd-arrows`, `Ctrl-arrows` (Mission Control), `Ctrl-Space` or `Ctrl-Tab`, and no `Option-letter`. Launcher apps (Raycast, ChatGPT, ...) can claim `Option-Space` system-wide; then use the mic button.

**Search and commands (`Cmd-K`).** One input. Type to filter the commands (go to each list, "New person", "New project", "Start 1-1 with…", "Toggle sidebar", "Expand or collapse the document", "Close the document", "Dictate (start/stop microphone)", "Pin current" / "Unpin current" while a person or project is open, "Shortcuts", "Log out"), to find people and projects by name, and (from two characters, after a short pause) to search all your notes, actions, agenda items, people, projects and meeting notes on the server. `↑`/`↓` move across the groups, `Enter` opens or runs, `Esc` closes. The search text is sent in a POST body and never appears in the address bar or the server log.

There is no global "undo": Undo and Reclassify are chips on a filed capture in the conversation, so a destructive key only ever acts on what you can see highlighted.

### Install as an app (optional)

XO ships a web app manifest, so the browser can open it as its own window: Chrome's "Install" (the install icon in the address bar, or the menu), or Safari "File", "Add to Dock" (on iPhone: Share, "Add to Home Screen"). Nothing is cached offline; it is still the same site and the same login. Whether an installed window delivers `Cmd-N` is not verified. `Cmd-J` is the documented shortcut either way.

### The conversation

Every capture shows your text and XO's reply, with names as links that open the document in the panel. A filed capture offers **Open · Undo · Reclassify**. Use `↑` in an empty composer to enter the conversation, `↑`/`↓` to pick a capture, `←`/`→` to pick a chip and `Enter` to run it. After you act on an item, focus returns to the composer.

**Questions.** XO never guesses. When it is unsure of the kind, or a person or project is unknown or ambiguous, the capture waits and shows its question as chips (for example: Note, Action, Waiting for, Agenda item, Discard; "Create person" / "Pick existing person" / "Skip" for an unknown `@name`; "Create project" / "Pick existing project" / "Skip (no project)" for an unknown `#name`; the candidates for an ambiguous one). The composer keeps focus while a question is open, so typing more text never answers it: move into the conversation, highlight a chip and press `Enter`. "Pick existing…" opens a picker. If every project a question offered was deleted meanwhile, the capture shows "Ready to file" with File and Discard.

### Asking questions

Ask XO about your own data in the conversation: `/ask what did I promise Anna?` (or `/q …`). A message without a prefix that the classifier recognises as a question with confidence at or above `XO_CLASSIFY_THRESHOLD` is **answered automatically**, which sends excerpts of your data to the model (see below). To avoid that, start the message with a prefix such as `/note` or `/todo`, which skips the classifier. When the classifier is unsure, nothing is sent: the kind question gains an **Answer it** chip next to Note, Action and Agenda item.

- XO shows "Looking through your data…", then the answer as plain text (never formatted or executed) and, under **Sources**, one chip per document it used. `←`/`→` pick a chip, `Enter` opens the document in the panel; `Enter` on an answer with no chip picked opens its first source. Actions open the Actions list, and agenda items open the People list.
- **Nothing matches:** when nothing in your data fits the question, XO says "Nothing in your data matches that." and sends nothing to the model.
- **If the answer fails** (the model is unavailable or too slow, you asked too many questions in a minute, or answering is not configured) the question stays in the conversation with a plain message and the chips **Retry**, **File instead** (it becomes a normal capture and asks for the kind) and **Discard**. A question is only sent after you send it or press Answer / Retry: reloading the page never asks anything by itself.
- **Delete answer** removes an answer. An answer is a copy of what it used: if any note, action, agenda item or project it used is deleted, the answer is blanked on the next read ("This answer was removed because something it used has been deleted"), and the 30-day purge erases it. Answers are not part of the Markdown export.
- Answering needs an OpenRouter key (without one XO says answering is not set up); `XO_QA_MODEL` picks the model. At most 20 questions a minute.

**What leaves the machine.** To answer, the server first searches your data locally (no model involved) and picks the most relevant excerpts: up to 24 items, each cut to about 600 characters and 12 000 characters in all, from your notes, actions, agenda items, people, projects and meeting notes (deleted items are never included). Your question and those excerpts, with the item titles, are sent to OpenRouter and the model you set in `XO_QA_MODEL`. Nothing else is sent, and nothing is sent when no excerpt matches. The answer model always uses low-effort reasoning, `max_tokens` 3000 and a 45 second deadline. With `XO_OPENROUTER_ZDR=false` (the default) the provider may retain what it receives, see [Data retention at OpenRouter](#data-retention-at-openrouter-xo_openrouter_zdr); with `true` the request goes only to Zero Data Retention endpoints and fails otherwise. The question, the excerpts and the answer are never written to the server log. The answer text and its sources are stored in the database next to the capture.

### Prefix commands (composer)

| Prefix | Result |
|---|---|
| `/note` (`/n`) | Note |
| `/todo` (`/t`, `/action`) | Action owned by me |
| `/wait` (`/w`) | Action owned by them |
| `/agenda` (`/a`) | 1-1 agenda item (needs a person) |
| `/ask` (`/q`) | A question about your own data: XO answers it in the conversation (see [Asking questions](#asking-questions)); the classifier is not called |
| `@name` or `@"Full Name"` | Link a person (the first mention is used; the `@` is dropped from the text). Unknown names ask before creating a person |
| `#name` or `#"Full title"` | Link a project (the first mention is used; the `#` is dropped from the text). Not after a letter or digit, and the first character must be a letter, so `#42`, `issue #42` and `# heading` are plain text. Unknown names ask before creating a project. A hyphen or space is the same: `#board-deck` matches "Board deck". Agenda items carry no project |

A prefix skips the classifier for the kind. Without one, the classifier decides; when it is unsure, fails or no key is set, XO asks and files nothing until you answer. Known names and aliases in the text link a person automatically (in free text a name must start with an uppercase letter). A project named in free text is linked silently only when its multi-word title or alias matches exactly; a single-word match, or a project the classifier suggests, is only offered as a question. Done projects are never matched.

### Documents

Lists and the rows inside documents all work the same way: `↑`/`↓` pick a row, `←`/`→` pick a chip, `Enter` runs it, and `↓` past the last row goes to the add field (`↑` in an empty add field returns to the list).

| Document | What it does |
|---|---|
| Actions | Open actions grouped by project (active projects by title, then on hold, then "No project"); inside a group, mine first, then waiting-for. Filter by person ("Person: any"), "Show done". Row chips: Done / Reopen, Edit, Project…, Person…, Mark waiting / Mark mine, Delete. An add field per group creates an action in that project |
| Notes | Newest first with previews and person and project labels; add a note; Open, Delete |
| Note | Title and body (autosaved), person and project pickers, Delete |
| People | Add a person; Open or Start 1-1 |
| Person | Name and aliases, Pin, Start or Resume 1-1, archive; sections for the agenda (add field; Done, Drop, Delete), open actions (mine and theirs, with their project), notes, past meetings and the person's own notes |
| 1-1 meeting | Agenda with check-off; follow-ups for me or for them (owner toggle on the add field); meeting notes (autosaved, and saved on `Esc`); the person's other open actions across projects, grouped by project; the previous 1-1's notes, resolved items and follow-ups; End meeting (asks first). An ended meeting is read-only. Unchecked agenda items stay open and appear in the next 1-1 |
| Projects | Grouped Active, On hold, Done with open-action counts; add a project |
| Project | Rename, status (active / on hold / done), aliases, description (autosaved), Pin, linked people (add, remove), actions (with an add field), done actions (collapsed), notes (with add), Delete project (its actions and notes are kept, without a project) |

### Voice

Push-to-talk needs a microphone and, in a browser, a secure origin (`https://` or localhost). **Dictated audio leaves your machine**: it is uploaded to the server and sent to OpenRouter for transcription. Whether the provider may retain it depends on `XO_OPENROUTER_ZDR`, see [Data retention at OpenRouter](#data-retention-at-openrouter-xo_openrouter_zdr).

- **Hold `Option-Space`** (anywhere) or **`Space`** (when focus is not in a text field or on a button) to record; release to transcribe. A held-key recording is sent automatically at 120 seconds, and only while the key is demonstrably still held.
- The **mic button** in the composer (large on a phone) and the palette command "Dictate" toggle recording instead (the way to talk on a phone). Such a recording that reaches the 2-minute limit is **not** sent automatically: a **status bar at the top of the screen** (shown in every layout, also with an expanded document or on a phone) asks **Send / Discard (Esc)**. `Enter` sends the recording only while that bar is on screen and you have not typed for 1.5 seconds, so a draft you are writing is never sent by mistake; until then use the Send button. The audio is discarded after 60 seconds without a choice, when the tab is hidden or loses focus, and when the session ends.
- `Esc` while recording or transcribing cancels, and does not also close the open document. Recordings shorter than about 300 ms are ignored.
- A transcript that matches a command runs it. Anything else is appended to the composer text; check it and press `Enter` to file it (such captures are stored with source `voice`).

Commands (case-insensitive, trailing punctuation and "please" ignored; a person or project must match exactly one known name, otherwise the text is dictation):

| Say | Does |
|---|---|
| "open Anna", "show Anna" | Open the person |
| "open Apollo", "show Apollo" | Open the project (a person with the same name wins; several matches mean dictation) |
| "start 1-1 with Anna" (also "one on one", "1:1", "meeting") | Start (or resume) a 1-1 |
| "go to chat / actions / notes / people / projects" (also "open ...") | Open that list ("chat" returns to the conversation) |

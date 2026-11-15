# XO

A single-user "run my life" web app, meant to be reachable only over your Tailscale tailnet, that looks like a terminal UI. Type or dictate into a chat; the text is filed as a note, an action, or a 1-1 agenda item (linked to a person). Run 1-1 meetings from the accumulated agenda. One Node process, one SQLite file, keyboard and voice first.

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

Default **`false`**. With `false`, XO sends no `zdr` field, so OpenRouter may route a request to any provider endpoint, and that provider may retain or train on what it receives: capture text, the names and aliases of your people (sent for classification), and recorded audio for voice. Treat everything you type or dictate as potentially retained upstream.

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

It writes `people/<slug>.md` (notes, open agenda and actions, agenda items resolved outside meetings, each meeting with notes, resolved items and follow-ups), `notes/<date>-<slug>-<id>.md` and `actions.md`. All times are UTC (also in file names and the default directory name). User Markdown (note and meeting bodies) is embedded as blockquotes so its headings cannot change the outline of the exported file. Soft-deleted items are not exported, and **captures still pending classification are not exported** (only what they filed). Everything is read in one consistent snapshot and written to a temporary sibling directory, then moved into place, so a failure leaves no partial plaintext behind. The target must be new, or an empty directory owned by you and not group/other-writable (otherwise it refuses); the parent directory must exist; directories are 0700 and files 0600; symlinks are never followed. The export is plaintext: keep it private (`xo-export-*` is git-ignored and docker-ignored). The export preserves links and HTML from your own Markdown as written, so do not treat a rendered export of untrusted content as safe.

In Docker, export inside the container, copy it out and delete it. Do not write into `/data`, which would leave plaintext in the volume:

```sh
docker exec xo node src/server/cli/main.ts export --out /tmp/xo-export
(umask 077; docker cp xo:/tmp/xo-export ./xo-export-$(date -u +%Y%m%d-%H%M%S))
docker exec xo rm -rf /tmp/xo-export
```

### Deletion and retention

- Deleting a note, action or agenda item is a soft delete; after 30 days a daily job (also run at startup) hard-deletes it and every copy of its content (including chat history). SQLite `secure_delete` is on and ids are never reused.
- **Backups and exports taken before a purge still contain the purged data.** Rotate and delete old backups accordingly.
- Person notes and meeting notes have no delete path in v0.1 (people are archived, not deleted).
- Migration 003 (ids never reused) **fails closed** if the database already has dangling foreign keys: the schema version stays unchanged and data is left intact. Fix or remove the dangling rows (take a backup first), then restart.

## Using XO

Press `?` for the help overlay, which lists the bindings of the current view (it is generated from the registered bindings and is authoritative). Modes, shown at the left of the status line:

- **NORMAL**: keys are commands.
- **INSERT**: you are typing in an input; only `Esc`, `Ctrl-K` and `Alt+Space` act as commands. `Esc` returns to NORMAL. The one exception is the chat input's own keys (`Enter` sends, `↑` in an empty input leaves it, `Alt-↑` / `Alt-↓` recall), which are not in the `?` overlay's generated lists (the overlay shows them in a fixed "Chat input" section).
- **COMMAND**: the palette or another overlay is open.

Everything is reachable by keyboard; the same actions also work by mouse or touch (list rows and buttons).

### Global key bindings (NORMAL mode unless noted)

| Key | Action |
|---|---|
| `g c` / `g a` / `g n` / `g p` | Go to chat / actions / notes / people |
| `←` / `→` | Previous / next view in the order Chat, Actions, Notes, People (wraps; a note counts as Notes, a person or 1-1 as People). Person and 1-1 use them for panes instead, and Chat uses them for answer options while a question is live (see below) |
| `i` | Go to chat and focus the input |
| `/` | Search |
| `:` | Command palette |
| `Ctrl-K` (any mode) | Command palette |
| `?` | Help overlay |
| `u` | Not global. Chat: undo the selected, filed capture. Person: undo the last done/drop shown by its undo offer. Elsewhere it does nothing. The palette command "Undo last capture" undoes the most recent filed capture from any view |
| `j` / `k` or `↑` / `↓`, `g g`, `Shift+G`, `Enter` | In lists: move, top, bottom, open |
| `Esc` | Close overlay, leave the input (to NORMAL), or go back |
| hold `Space` | Push-to-talk (see Voice) |
| `Alt+Space` (any mode) | Push-to-talk |

The palette (`:`) also has: go to each view, "Start 1-1 with…" (person picker), "New person", "Undo last capture", "Dictate (start/stop microphone)", "Help" and "Log out". Type to filter, `Enter` runs, `Esc` closes.

### Chat

Chat is the home view and always opens with the input focused (INSERT). `Enter` sends, `Alt-↑` / `Alt-↓` (Option on macOS; Ctrl-↑/↓ is taken by Mission Control) recall earlier texts (empty or not). Text you had typed is kept aside and comes back when you step down past the newest, after you send a recalled line, or after leaving and re-entering Chat (clearing the input does not drop it). Edits you make to a *recalled* line are not protected: it is a copy of an earlier text, and the next recall may replace it. `Esc` leaves the input. Plain `↑` in an **empty** input also leaves it and selects the newest capture (NORMAL mode); in a non-empty input `↑`/`↓` move the caret as usual.

**Focus rule for questions.** When XO asks a question (what kind is this, unknown person, which person, which person for an agenda item), the input keeps focus so typing is never swallowed. To answer, press `Esc` first (NORMAL mode), then the option key shown on the question (`n` note, `t` action, `a` agenda, `d` discard, `c` create person, `p` pick a person, `s` skip, `1`..`9` for candidates). After an answer, focus returns to the input, unless the same capture asks a follow-up question. Pressing option keys while still in the input just types them.

| Key | Action |
|---|---|
| `j` / `k` (or `↓` / `↑`), `g g`, `Shift+G` | Select a capture / first / newest. `↓` on the newest capture returns to the input |
| `←` / `→` | While the selected capture has a live question: highlight (`>` marker; the status line reads it out) the previous / next answer option (candidates first, then options); `Enter` answers. Otherwise they switch view |
| `Enter` | Answer with the highlighted option, or else open the filed item (note, person, or the actions list) |
| `u` / `r` | Undo / reclassify the selected, filed capture |
| `o` | Load older captures (when offered) |

### Other views

| View | Keys |
|---|---|
| Actions (mine / waiting for) | `x` done, `e` edit, `d d` delete, `a` add (mine), `Shift+A` add (waiting for), `t` show or hide done, `Enter` open the person, `o` load more |
| Notes | `Enter` open, `a` new note, `d d` delete, `o` load more |
| Note | `e` edit body, `t` edit title, `Esc` save and leave the field, `Ctrl-Enter` save, `p` open the person, `d d` delete, `q` back |
| People | `Enter` open, `a` add person, `s` start 1-1 |
| Search | The input is focused on entry; type at least 2 characters, `Enter` searches and moves to the results, then `j`/`k` and `Enter` open a hit; `Esc` leaves the input |
| Person | `Tab` / `Shift+Tab` or `←` / `→` panes, `a` add agenda item, `x` done / `Shift+X` drop an agenda item (undo with `u`), `x` complete an action (in the actions pane), `s` start or resume a 1-1, `e` edit name and aliases, `n` edit person notes, `m` load older notes or meetings, `d d` delete an agenda item, `Enter` open a note or past meeting |
| 1-1 meeting | `j` / `k` move, `x` check or uncheck an agenda item or follow-up, `a` add agenda item, `t` follow-up for me, `Shift+T` follow-up for them, `n` edit the meeting notes (autosaved every few seconds, and on `Esc` or blur), `Tab` / `Shift+Tab` or `←` / `→` panes, `d d` delete, `Shift+E` end the meeting (confirm with `y`, cancel with `n` or `Esc`), `Esc` back to the person. An ended meeting is read-only. |

Unchecked agenda items stay open and appear in the next 1-1 together with the previous meeting's notes, resolved items and follow-ups.

### Prefix commands (chat)

| Prefix | Result |
|---|---|
| `/note` (`/n`) | Note |
| `/todo` (`/t`, `/action`) | Action owned by me |
| `/wait` (`/w`) | Action owned by them |
| `/agenda` (`/a`) | 1-1 agenda item (needs a person) |
| `@name` or `@"Full Name"` | Link a person (the first mention is used; the `@` is dropped from the text). Unknown names ask before creating a person |

A prefix skips the classifier. Without one, the classifier decides; when it is unsure, fails or no key is set, XO asks you with a keyboard-selectable question and files nothing until you answer. Known names and aliases in the text link automatically (in free text a name must start with an uppercase letter). `u` undoes, `r` reclassifies.

### Voice

Push-to-talk needs a microphone and, in a browser, a secure origin (`https://` or localhost). **Dictated audio leaves your machine**: it is uploaded to the server and sent to OpenRouter for transcription. Whether the provider may retain it depends on `XO_OPENROUTER_ZDR`, see [Data retention at OpenRouter](#data-retention-at-openrouter-xo_openrouter_zdr).

- **Hold `Space`** (NORMAL mode) or **`Alt+Space`** (any mode) to record; release to transcribe. A held-key recording is sent automatically at 120 seconds.
- The **mic button** in the status line and the palette command "Dictate" toggle recording instead (the way to talk on a phone). Such a recording that reaches the 2-minute limit is **not** sent automatically: the status line asks **Send (Enter) / Discard (Esc)**, and discards the audio after 60 seconds without a choice, or when the tab is hidden or loses focus.
- `Esc` while recording or transcribing cancels. Recordings shorter than about 300 ms are ignored.
- A transcript that matches a command runs it. Anything else is appended to the chat input; check it and press `Enter` to file it (such captures are stored with source `voice`).

Commands (case-insensitive, trailing punctuation and "please" ignored; the person must match exactly one known person, otherwise the text is dictation):

| Say | Does |
|---|---|
| "open Anna", "show Anna" | Open the person |
| "start 1-1 with Anna" (also "one on one", "1:1", "meeting") | Start (or resume) a 1-1 |
| "go to chat / actions / notes / people" (also "open ...") | Switch view |

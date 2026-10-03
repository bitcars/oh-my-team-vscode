# Oh My Team — Dashboard

A local web dashboard for monitoring and controlling hub sessions. Served
by the router at `http://localhost:8800/dashboard`.

## Opening it

```bash
omt dashboard        # hub must already be running
```

`omt hub start` also opens the dashboard automatically in your default
browser. To suppress the auto-open (e.g. over SSH or in scripts):

```bash
omt hub start --no-browser
# or
OMT_NO_BROWSER=1 omt hub start
```

The CLI detects SSH sessions and headless Linux automatically — no flag
needed in those environments.

## What's in it

### Sessions sidebar
Every registered project session with a live status dot:
- **green pulsing** — currently working on a tool call
- **teal solid** — idle, waiting for input
- **dim** — stopped (tmux killed, registry preserved)

Click any session to select it.

### Top bar
Platform badge (Telegram / Slack) and router health dot. The router chip
polls `/health` every 5 seconds so a dead router surfaces without a
refresh.

### Activity tab
Live tool feed per session. Completed actions show with `✓`, the current
action with `⏳`. Same data the status hooks push to Telegram, without
the throttling — localhost can handle every event.

### Terminal tab
Interactive xterm.js attached to `tmux attach-session -t omt-<name>`.
Full keyboard input, ANSI colors, copy/paste, resize. Behaves exactly
like `omt hub attach <name>` — but in the browser.

Terminal is connected only while the tab is visible; switching away
tears down the PTY so inactive sessions don't accumulate.

### Logs tab
Tails `router.log` with a 2-second poll. Auto-scrolls while you're at
the bottom; preserves position if you scroll up.

### Info tab
Static session metadata: thread ID, bridge port, full path, started-at.

### Restart / Stop buttons
Buttons in the session header call the REST API:
- **Stop** — kills tmux only; registry stays (session can be restored
  with `omt hub start` or the Restart button)
- **Restart** — stops then `omt hub add <path> --continue`

The `hub` session itself is locked — use `omt hub stop` / `omt hub start`
for it.

## API reference

| Route | Description |
|---|---|
| `GET /dashboard` | Serve the dashboard HTML |
| `GET /dashboard/assets/*` | Vite build assets (JS, CSS) |
| `GET /api/config` | Platform, router port, hub dir |
| `GET /api/logs?tail=N` | Recent router log lines (capped at 1000) |
| `POST /api/sessions/:name/stop` | Kill tmux, keep registry |
| `POST /api/sessions/:name/restart` | Stop + restart with `--continue` |
| `WS /ws/events` | Live events (see below) |
| `WS /ws/tmux/:name` | PTY bridge for interactive terminal |
| `POST /ask` | A session asks the user to pick one of 2–4 options |
| `POST /ask-answer` | Answer an open ask from a non-platform client (`{token, idx}`; 410 if already closed) |
| `POST /team-message` | One session's agent messages another's |
| `POST /escalate` | A session posts a blocker to its own topic |

### Event stream

`/ws/events` broadcasts JSON messages:

```jsonc
{ "type": "session.registered", "name": "my-app", "path": "...", "threadId": "...", "bridgePort": 8802, "threadDisplayName": "my-app", "startedAt": "2026-04-16T..." }
{ "type": "session.removed", "name": "my-app" }
{ "type": "session.status", "name": "my-app", "current": "Running npm test", "done": ["Read package.json"], "elapsedMs": 12000 }
{ "type": "session.status.cleared", "name": "my-app" }
{ "type": "session.reply", "name": "my-app", "text": "...", "kind": "reply", "files": [], "ts": "2026-04-16T...", "seq": 7 }
{ "type": "session.permission", "name": "my-app", "requestId": "abcde", "toolName": "Bash", "description": "...", "inputPreview": "...", "ts": "2026-04-16T..." }
{ "type": "session.permission.resolved", "requestId": "abcde" }
{ "type": "session.ask", "name": "my-app", "token": "1a2b3c4d", "question": "...", "options": ["...", "..."], "ts": "2026-04-16T..." }
{ "type": "session.ask.resolved", "name": "my-app", "token": "1a2b3c4d", "choice": "..." }
```

`seq` counts up per session from 1 and resets when the router restarts.
`GET /history?session=<name>&since=<seq>` returns the replies after
`since` (last 200 per session), for catching up after a disconnect.

Client reconnects with exponential backoff (500ms → 10s cap) so a
`omt hub stop` → `start` cycle recovers without a page refresh.

An ask is posted to the session's topic as a numbered text card. It closes
once: a typed option number or option text in the topic, or `POST
/ask-answer`. Text sent from the panel never answers it, and `POST
/admin/inject` refuses the senders `decision` and `team:*`, which only the
router sets. An ask is also closed unanswered when a newer ask replaces it,
when other text is typed in the topic, or after 6 hours; `session.ask.resolved` then carries `choice`
`"(superseded)"`, `"(dismissed)"` or `"(expired)"`. Asks are kept in memory
and lost when the router restarts. Team messages are mirrored as
`session.reply` with `kind: "team"` and escalations with `kind: "escalate"`.

Known limitations of asks, team messages and escalations:

- `session.ask.resolved` clears whatever prompt the VS Code panel holds for
  that session, so a dismissed or expired ask can clear a later permission
  card ([bitcars/omt-vscode-ext#1](https://github.com/bitcars/omt-vscode-ext/issues/1)).
- `/ask` posts to the platform first: if that fails the ask is not shown in
  the panel either, and the agent gets an error (fork parity).
- Tests check that delivery, `session.ask.resolved` and the topic follow-up
  all happen, not their order (except that the clear goes out first).
- There are no Telegram buttons; answer by typing the number or option
  text ([bitcars/oh-my-team-vscode#3](https://github.com/bitcars/oh-my-team-vscode/issues/3)).
- Escalations don't @mention the operator; that needs a configured
  operator id (`credentials.escalationUserId`), not implemented yet.
- Two asks sent at the same moment by one session may register out of
  order if the first platform post is slower.
- A typed reply matches option text before option numbers, so with options
  that are themselves numbers, "1" picks the option labelled 1 (fork parity).
- Team text is neutralized only for exact `<team-message` / `<ask-answer`
  tags; lookalikes such as `< /team-message>` pass through. The bridge
  trusts the channel sender, not the tags, so this is not an injection path.

## Access

Localhost only (bind to `127.0.0.1`). No auth. Every `/ws/*` connection
and every request other than GET/HEAD is refused with 403 when it carries
an `Origin` that isn't `localhost` or `127.0.0.1`; requests with no
`Origin` (curl, bridges, hooks) are allowed. So open the dashboard as
`http://localhost:<port>`: through a LAN IP, `0.0.0.0` or a reverse proxy
hostname, the live stream and terminals won't connect. For remote access,
use an SSH tunnel:

```bash
ssh -L 8800:localhost:8800 user@host
```

Then open `http://localhost:8800/dashboard` on your local machine.

## Build artifact

`channel/dashboard/dist/` is a build artifact that ships inside the npm
tarball. Run `npm run build:dashboard` after modifying the dashboard source.

## Requirements

- `tmux` (same as the rest of the hub)
- `bun` (same as the rest of the hub)
- `node-pty` native binary — installed automatically by `bun install`
  inside `~/.oh-my-team/channel/` on first `omt hub start`. Prebuilt
  binaries exist for macOS arm64 / x64, Linux x64 / arm64, Windows x64.
  If the binary fails to load on your platform, the terminal tab shows
  an error; everything else in the dashboard still works.

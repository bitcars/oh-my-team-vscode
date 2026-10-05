# Running a second hub beside the first (`--profile`)

`bin/omt --profile NAME …` (or `OMT_HOME=<dir> bin/omt …`) runs a second,
independent hub from this checkout next to an existing one. The usual name is
`omtv`. Use this checkout's `bin/omt`, or the profile's own `~/.omtv/bin/omt`.
An `omt` installed by the default hub doesn't know about profiles: even with
`OMT_HOME` set, it acts on the default hub.
The second hub shares nothing with the default hub (`~/.oh-my-team`, router on
port 8800): not its files, ports, tmux sessions, MCP wiring or bot.

| | Default hub | Profile `omtv` |
|---|---|---|
| Config and state | `~/.oh-my-team` | `~/.omtv` |
| Router / hub bridge / project bridges | 8800 / 8801 / 8802+ | 9800 / 9801 / 9802+ |
| tmux | default server | its own server: `tmux -L omtv` |
| Hub session's folder | `$HOME` | `~/.omtv/hub` |
| MCP wiring | `~/.mcp.json`, project `.mcp.json` | one file per session in `~/.omtv/mcp/`, loaded with `--strict-mcp-config` |
| Plugin | `~/.oh-my-team` | this checkout, through `~/.omtv/plugin` (a view without `.mcp.json`) |
| Bot | its own | a second bot and forum group |

The ports can be changed in `~/.omtv/profile.env`
(`ROUTER_PORT=`, `HUB_BRIDGE_PORT=`, `BRIDGE_PORT_BASE=`).

## Set up

1. Create a second Telegram bot with @BotFather. In Bot Settings, turn
   **Group Privacy OFF**.
2. Create a new group, enable **Topics**, add the bot and make it **admin**.
   Send any message in it.
3. Configure the profile. Run it without flags; it asks for the token and
   detects the chat, so the token stays out of your shell history:
   ```
   bin/omt --profile omtv hub init
   ```
   The flag form (`hub init --telegram --token <t> --chat-id <id>`) works too,
   but leaves the token in your shell history.
4. Trust the hub's folder once (Claude would otherwise hang on its trust
   prompt): `mkdir -p ~/.omtv/hub && cd ~/.omtv/hub && claude`, accept, exit.
   Do the same once for every project folder you add.

## Use

```
bin/omt --profile omtv hub start        # router + hub (no browser window)
bin/omt --profile omtv hub add <dir>    # a project session
bin/omt --profile omtv hub status
bin/omt --profile omtv hub attach       # Ctrl+B, D to detach
bin/omt --profile omtv hub stop
bin/omt --profile omtv dashboard        # opens the dashboard
```

`~/.omtv/bin/omt` is the profile's CLI. It always acts on `~/.omtv`, from any
shell, so `~/.omtv/bin/omt hub stop` is safe to type anywhere. Inside omtv
sessions it is `$OMT_CLI`, and the hub agent uses it.

Inside omtv sessions `PATH` starts with `~/.omtv/bin`, and in the live check
a bare `omt` in the hub agent's Bash tool resolved to `~/.omtv/bin/omt`. A
shell startup file that put another dir holding an `omt` ahead of it would
change that, which is why the hub agent always runs `$OMT_CLI`.

## What omtv sessions don't load, and how to opt back in

omtv sessions start with `--setting-sources project,local`, so your user
settings (`~/.claude/settings.json`) do not apply. By default they lose:

- user hooks, including notifiers such as ccgram (they read the default hub's
  registry, so they would mislabel omtv events);
- the statusline;
- user permissions, `env` and `enabledPlugins`;
- user-level MCP servers (for example librarian).

To opt back in:

- **Settings:** copy the blocks you want into `~/.omtv/settings.json`; it is
  passed with `--settings`. Don't copy hooks that read `~/.oh-my-team` unless
  you point them at `~/.omtv`.
- **MCP servers:** list them in `~/.omtv/mcp-extra.json` as
  `{"mcpServers": {"librarian": {…}}}`. They are merged into each session's
  MCP file. An entry named `omt-bridge` or `omtv-bridge`, or one that runs
  `~/.oh-my-team/channel/bridge.ts`, is dropped.

## Context and quota reporting

Every omtv project session reports its model, context size, rate-limit quota
and subagent counts to the omtv router, through a Claude Code mod in this
plugin (`hooks/ctx-mod.js`). The router serves the latest report as `ctx` on
`GET /sessions` and broadcasts it as a `session.ctx` event, for the VS Code
panel. The wire format is section 1 of the WO-022 plan (also posted on fork
issue #16).

- **When it posts:** after each model request, at the end of each turn, after
  a real compaction of the main conversation (tokens null until the next
  request), on `/clear` (tokens 0) and on `/resume` (tokens null). An
  unchanged report isn't re-sent.
- **Who posts:** a process with `SESSION_NAME` and a local `ROUTER_URL` in its
  env, and no `CLAUDE_CODE_TEAMMATE`. Agent-team teammates don't post.
- **It adds at most 150 ms to a step:** each report waits at most 150 ms for
  Claude Code, the POST is never awaited, and at most 4 POSTs are open at
  once. A report that finishes after a newer one has gone out is dropped.
- **The mod reads no transcript** and sends no cost and no context percentage
  (the router computes the percentage).
- **A report is all-or-nothing:** the router refuses the whole report (400)
  when any field is invalid, for example a `resetsAt` that isn't ISO 8601 with
  a zone, or an `at` more than 60 s ahead of the router's clock. The mod logs
  the first refusal in the session (`ctx-mod: router answered 400`). A 404
  (the session isn't registered yet) is expected at startup and not logged.

The plugin view copies `hooks/` and `.claude-plugin/` instead of linking them,
because Claude Code refuses a hooks module that resolves outside the plugin
dir. So every file under `hooks/` (the mod, `status-hook.sh`, `hooks.json`)
and `.claude-plugin/` stays as it was when the hub last started. After pulling
or editing one, restart the hub:

```
~/.omtv/bin/omt hub stop && ~/.omtv/bin/omt hub start
```

`hub add` and interactive mode print a yellow warning when the view's
`hooks/` or `plugin.json` no longer match the checkout's, or when `hooks/` is
still a link from a view built before this change. A view rebuild while project sessions run swaps their mod file, and
Claude Code reloads it.

Known limits:

- A fresh session reads `ctx: null` until its first prompt: Claude Code's
  startup report fires before the session registers, and nothing else fires
  until a prompt. After a router restart, an idle session reads null until
  something changes.
- `agents` is as of the last event in the session's process. A Task
  subagent's own steps refresh it while the lead is idle; a teammate in its
  own pane refreshes only on the lead's events, and a teammate pane that
  died keeps its last status.
- A `claude` started from inside a session (for example from its Bash tool)
  inherits `SESSION_NAME` and `ROUTER_URL` and would report as that session.
  It shows up as an alternating `sid`. For dev runs against this checkout:

  ```
  env -u SESSION_NAME -u ROUTER_URL claude --plugin-dir <checkout>
  ```

- This repo's default (non-profile) launcher sets the same two variables, so
  this plugin, if loaded there, posts to that `ROUTER_URL` as well. The live
  default hub runs a different checkout and router, which have no `/ctx` route.
- If a Claude Code call the mod makes (the agent list, usage) never returns,
  each event leaves one report waiting in the background. The turn itself
  goes on after 150 ms.
- After `/clear`, a background subagent that is still running can report the
  lead's context as unknown (null) until the lead's next request.
- Agent teams are off in omtv sessions unless `~/.omtv/settings.json` has
  `{"env": {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"}}` (user settings
  aren't read).
- Don't run `/model` in an omtv session: Claude Code saves the choice to the
  shared `~/.claude/settings.json` (fork issue #17). Set `hubModel` or a
  registry `model` instead (see Model, below).

## Model

- **The hub:** `hubModel` in `~/.omtv/hub-config.json`, for example
  `"hubModel": "fable"`. `hub start` launches the hub with `--model <value>`.
  `hub init` writes `"fable"` into a new config, adds it to a config that has
  no `hubModel`, and keeps any value already there. Absent, `null` or `""`
  means no flag, and the hub then runs the model in `agents/hub.md` (sonnet).
  `null` is the lasting opt-out, because init keeps it. Init rewrites the
  file: it ends up mode 600, a symlinked config is replaced by a regular
  file, and a config init can't parse counts as having no `hubModel`, so it
  gets `fable`.
- To set it on an existing profile, edit the file with the hub stopped (it
  holds the bot token, so keep it mode 600), or re-run `hub init`. A change
  applies at the next `hub stop && hub start`; a running hub is left alone.
- **A project session:** the `model` field of its entry in
  `~/.omtv/hub-registry.json`, read when `hub start` restores the session.
  Set it with the hub stopped: the router loads the registry once and saves
  it from memory. `hub add` sets none, and `hub stop --clean` and
  `hub remove` drop the entry with its `model`. The hub's own registry entry
  is never read for a model.
- Values may use letters, digits, `.`, `_`, `:`, `@`, `/`, `[`, `]` and `-`,
  1-100 characters (the router's rule for reported models). An id Claude
  Code doesn't know is passed through; claude then reports the error.
- `model` in `~/.omtv/settings.json` is not the way: it also reaches
  interactive omtv runs, and every session gets it through `--settings`.

## Guards

Every profile command checks the dir and ports first, before it calls
anything or creates anything. It refuses to run (exit 3) when:

- its dir is `~/.oh-my-team`, inside it, contains it, or is `$HOME`;
- a port in `profile.env` isn't a plain decimal number (no leading zero).
  This blocks every command, `hub stop` included, so fix the file first;
- a port is in 8800-8899, a bridge base would reach that band, or two of its
  ports are equal.

`hub start` and `hub add` also refuse (exit 3) when:

- the router or hub bridge port, or a session's bridge port, is held by
  another process, or `lsof` (which checks that) isn't installed;
- its bot token, bot id (the part before `:`), app token, or chat/channel id
  equals the default hub's, or the default hub's `hub-config.json` exists but
  can't be read. The comparison runs in-process and never prints the values.
  `hub init` checks before its first Telegram or Slack call.

`hub start` also refuses (exit 3), before it starts anything, when
`hubModel` isn't a model id (see Model). It checks this even when the hub
is already running, so a bad value also blocks a `hub start` run only to
bring back crashed project sessions. The message never prints the value. A
project session whose registry `model` isn't a model id is skipped, and the
others still start.

The profile dir is made owner-only (mode 700): it holds the bot token. In
profile mode, project dir names may use letters, digits, `.`, `-`, `_` and
spaces, and project paths may not contain a quote (exit 2).

The router repeats the dir, port and credential checks when started for a
profile (exit 2). Other exit codes: 2 bad usage, 4 a folder Claude hasn't
trusted yet.

## Limits

- Keep project folders disjoint between the two hubs. Claude keeps trust and
  MCP approvals per path in `~/.claude.json`, which both hubs share.
- The dashboard's restart button doesn't bring a still-registered session
  back (`hub add` refuses an existing name). This is pre-existing and affects
  the default hub too.
- `--dangerously-load-development-channels server:omtv-bridge` resolving a
  server from `--mcp-config` is undocumented Claude Code behaviour.
- The dashboard isn't built automatically in profile mode:
  `cd channel/dashboard && bun install && bun run build`.
- Maintenance cost: the profile's `hub start/add/remove/stop/attach/status`
  are a separate implementation in `bin/omt-profile.sh`, not branches inside
  `bin/omt`'s `hub_*`. That keeps the default mode byte-identical, but a fix
  to a default `hub_*` command must be ported to `bin/omt-profile.sh` by hand.
  (`hub init`, `list` and `logs` are shared.)
- The first `hub start` installs the channel's dependencies into this
  checkout's `channel/node_modules` (gitignored), as the default mode does.
  That is the one write outside `~/.omtv`, apart from the tmux socket.
- The tmux server is named after the profile dir's base name. Two profile
  dirs with the same base name (say `~/.omtv` and `/data/.omtv`) would share
  one tmux server, so give each profile a distinct name.
- Inside omtv sessions, `OMT_HOME` is set to the profile dir. Scripts from the
  default hub's install that read `OMT_HOME` (with `~/.oh-my-team` as their
  fallback) would act on `~/.omtv` there.

## Tests

```
bun test test/                                              # profile tests, harness controls, mutation control
cd channel && bun test router-guard.test.ts                 # router guard
OMTV_ACCEPTANCE=1 bun test test/omtv-isolation.test.ts      # beside a live default hub (opt-in)
```

Every test that runs `bin/omt` goes through `test/omt-harness.ts`. The harness
uses a `/tmp` sandbox, an allowlisted env, and fake `tmux`/`curl`/`claude`
commands. Those refuse the default tmux server, ports 8800-8899 and the
network. No test starts a real `claude` session or opens a window.

The one real `claude` the tests run is `claude plugin test` and
`claude plugin validate` for the ctx mod (`test/ctx-mod.test.ts` and its
removal control). Both go through `runClaudePluginSandboxed` in the harness:
`env -i`, a temp `HOME` and `CLAUDE_CONFIG_DIR`, no auto-update, and a check
that the real `~/.claude.json` and `~/.claude/projects` never mention the temp
dirs. They need a local `claude` 2.1.289 or newer and fail without one.

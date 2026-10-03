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
network. No test runs the real `claude` or opens a window.

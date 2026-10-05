# shellcheck shell=bash
# Profile mode for bin/omt (WO-021, bitcars/oh-my-team-vscode#9).
#
# Sourced by bin/omt only when `--profile NAME` or OMT_HOME is set. A profile
# is a second, isolated hub: its own config dir ($OMT_HOME), its own ports
# (9800/9801/9802+ by default), its own tmux server (`tmux -L <name>`), and
# its own MCP wiring (a per-session --mcp-config file), so it can run next to
# the default hub (~/.oh-my-team, :8800) without touching any of its files,
# ports, tmux sessions or bot. See docs/omtv.md.
#
# Every tmux call goes through omt_tmux (defined in bin/omt). Nothing here
# writes outside $OMT_HOME except the tmux socket.

# ── Small helpers ───────────────────────────────────────────────────────

_realpath() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

# _inside CHILD PARENT: CHILD is PARENT or below it (after resolving symlinks).
_inside() {
    local c p
    c="$(_realpath "$1")"; p="$(_realpath "$2")"
    [ "$c" = "$p" ] || [[ "$c" == "$p"/* ]]
}

_gfail() { echo -e "${RED}omt: refusing to run: $*${RESET}" >&2; }

port_in_band() { [ "$1" -ge 8800 ] && [ "$1" -le 8899 ]; }
# Session names and project paths go into pane commands and file names.
valid_name() { [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]]; }
safe_path() { case "$1" in *"'"*|*$'\n'*) return 1 ;; esac; return 0; }
# Model ids go into pane commands too. valid_model accepts exactly the set of
# the router's CTX_MODEL_RE (channel/router.ts); T19e sweeps the two against
# each other. LC_ALL=C keeps A-Z ASCII-only on systems whose locale ranges
# differ; on macOS bash 3.2 the result is the same without it.
valid_model() { local LC_ALL=C re='^[][A-Za-z0-9._:@/-]{1,100}$'; [[ $1 =~ $re ]]; }
# model_from_json RAW: RAW is a value printed by python's json.dumps, or "-"
# or "" for no key. Prints the model (nothing for none) and returns 0, or
# returns 1 when RAW isn't a JSON string holding a valid model id. A JSON
# escape always brings a backslash, which valid_model refuses.
model_from_json() {
    case "$1" in
        ""|-|null|'""') return 0 ;;
        \"*\") local v="${1#\"}"; v="${v%\"}"; valid_model "$v" || return 1; printf '%s' "$v" ;;
        *) return 1 ;;
    esac
}
# Without lsof every port looks free: refuse rather than guess.
need_lsof() { command -v lsof >/dev/null 2>&1 || { _gfail "lsof not found, so ports in use can't be checked"; return 3; }; }
port_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

# Exact-match tmux targets in profile mode (tmux otherwise prefix-matches,
# so `-t omt-app` can hit omt-app2; the default-mode fix is #10).
tgt() { echo "=$1"; }
tgt_pane() { echo "=$1:"; }

# ── Test seams (plan §5) ────────────────────────────────────────────────
# Honoured only when OMT_TEST_SANDBOX names a dir under /tmp or
# /private/var/folders AND the seam path is inside it. Anything else is
# ignored (with a note), so a stray export can't switch off a guard.

profile_seam() {
    local name="$1" v="${!1}"
    [ -n "$v" ] || return 1
    if [ -z "$_SEAM_ROOT" ]; then
        echo "omt: ignoring $name (test seam without an OMT_TEST_SANDBOX gate)" >&2
        return 1
    fi
    if [ "$name" = "OMT_TMUX_SOCKET" ]; then
        case "$v" in omtv-test-*) echo "$v"; return 0 ;; esac
        echo "omt: ignoring $name (must start with omtv-test-)" >&2
        return 1
    fi
    if _inside "$v" "$_SEAM_ROOT"; then echo "$v"; return 0; fi
    echo "omt: ignoring $name (outside OMT_TEST_SANDBOX)" >&2
    return 1
}

# Parse ROUTER_PORT / HUB_BRIDGE_PORT / BRIDGE_PORT_BASE. Never `source`:
# the file is data, not code. A value must be plain decimal with no leading
# zero: bash reads 08790 as (bad) octal, and an arithmetic error skips the
# rest of a check instead of failing it. Anything else is refused.
profile_read_ports() {
    local f="$1" k v
    [ -f "$f" ] || return 0
    while IFS='=' read -r k v || [ -n "$k" ]; do
        case "$k" in
            ROUTER_PORT|HUB_BRIDGE_PORT|BRIDGE_PORT_BASE)
                if [[ "$v" =~ ^[1-9][0-9]{0,4}$ ]]; then
                    printf -v "$k" '%s' "$v"
                else
                    _gfail "$f: $k is not a port number (plain decimal, no leading zero)"; return 3
                fi ;;
        esac
    done < "$f"
}

profile_init() {
    OMT_PROFILE=1
    _SEAM_ROOT=""
    if [ -n "$OMT_TEST_SANDBOX" ]; then
        local r
        r="$(_realpath "$OMT_TEST_SANDBOX")"
        case "$r" in
            /tmp/?*|/private/tmp/?*|/private/var/folders/?*)
                # Must be our own dir that nobody else can write into.
                if [ -d "$r" ] && [ -O "$r" ] && [ -z "$(find "$r" -maxdepth 0 -perm -0020 2>/dev/null)" ] \
                    && [ -z "$(find "$r" -maxdepth 0 -perm -0002 2>/dev/null)" ]; then
                    _SEAM_ROOT="$r"
                else
                    echo "omt: ignoring OMT_TEST_SANDBOX (not a dir owned by you and writable only by you)" >&2
                fi ;;
            *) echo "omt: ignoring OMT_TEST_SANDBOX (not under /tmp or /private/var/folders)" >&2 ;;
        esac
    fi

    OMT_HOME="${OMT_HOME%/}"
    # Relative to where omt runs, made absolute once: the panes cd elsewhere.
    case "$OMT_HOME" in /*) ;; *) OMT_HOME="$PWD/$OMT_HOME" ;; esac
    # The checkout this bin/omt lives in. Never ~/.oh-my-team.
    PLUGIN_DIR="$(dirname "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")")"
    OMT_DIR="$OMT_HOME"
    CHANNEL_DIR="$PLUGIN_DIR/channel"
    # Both go into single-quoted pane commands.
    if ! safe_path "$OMT_DIR" || ! safe_path "$PLUGIN_DIR"; then
        echo -e "${RED}omt: the profile dir and this checkout's path must not contain a quote or a newline${RESET}" >&2
        exit 2
    fi
    CONFIG_PATH="$OMT_DIR/hub-config.json"
    NEXT_BRIDGE_PORT_FILE="$OMT_DIR/.next-bridge-port"
    # Fixed defaults, never ${ROUTER_PORT:-…}: a fleet pane exports ROUTER_PORT=8800.
    ROUTER_PORT=9800
    HUB_BRIDGE_PORT=9801
    BRIDGE_PORT_BASE=9802
    profile_read_ports "$OMT_DIR/profile.env" || exit 3

    local s
    TMUX_SOCKET="$(basename "$OMT_HOME")"
    TMUX_SOCKET="${TMUX_SOCKET#.}"
    s="$(profile_seam OMT_TMUX_SOCKET)" && TMUX_SOCKET="$s"
    if ! [[ "$TMUX_SOCKET" =~ ^[a-z0-9][a-z0-9-]*$ ]] || [ "$TMUX_SOCKET" = "default" ]; then
        echo -e "${RED}omt: the profile dir name '$(basename "$OMT_HOME")' can't be used as a socket name (use [a-z0-9-])${RESET}" >&2
        exit 2
    fi
    TMUX_PREFIX="omt"          # the socket isolates; router-side code expects omt-*
    MCP_NAME="omtv-bridge"
    PLUGIN_ARG="$OMT_DIR/plugin"
    OMT_CLI="$OMT_DIR/bin/omt"
    OMT_CMD="$OMT_CLI"   # the CLI named in shared hints
    HUB_CWD="$OMT_DIR/hub"

    local pwhome
    pwhome="$(python3 -c 'import os,pwd; print(pwd.getpwuid(os.getuid()).pw_dir)')"
    FLEET_DIR="$pwhome/.oh-my-team"
    s="$(profile_seam OMT_FLEET_DIR)" && FLEET_DIR="$s"
    CLAUDE_JSON="$HOME/.claude.json"
    s="$(profile_seam OMT_CLAUDE_JSON)" && CLAUDE_JSON="$s"
    TMUX_CONF=""
    s="$(profile_seam OMT_TMUX_CONF)" && TMUX_CONF="$s"
    ROUTER_PRELOAD=""
    s="$(profile_seam OMT_ROUTER_PRELOAD)" && ROUTER_PRELOAD="$s"

    # Plan §1.7: the dir and port checks run before EVERY profile command,
    # not just start/add. `hub remove`, `status` or `attach` on a profile
    # whose dir is the default hub's, or whose router port is 8800, must not
    # reach that hub, or create anything inside its dir. No side effects:
    # nothing is created until a command needs it.
    profile_check_dirs || exit 3
    profile_guard_ports || exit 3
    return 0
}

# ── Guards (plan §1.7) ──────────────────────────────────────────────────

# Checks run on resolved paths (python's realpath works on paths that don't
# exist yet), so nothing is created until they pass.
profile_check_dirs() {
    [ -n "$OMT_DIR" ] || { _gfail "empty profile dir"; return 3; }
    if [ "$(_realpath "$OMT_DIR")" = "$(_realpath "$HOME")" ]; then
        _gfail "the profile dir is \$HOME"; return 3
    fi
    if [ -e "$FLEET_DIR" ]; then
        if _inside "$OMT_DIR" "$FLEET_DIR"; then
            _gfail "the profile dir is the default hub's dir ($FLEET_DIR) or inside it"; return 3
        fi
        if _inside "$FLEET_DIR" "$OMT_DIR"; then
            _gfail "the profile dir contains the default hub's dir ($FLEET_DIR)"; return 3
        fi
    fi
    return 0
}

# The checks, then create the dir. It holds the bot token: owner only.
profile_guard_dirs() {
    profile_check_dirs || return 3
    mkdir -p "$OMT_DIR" || { _gfail "can't create $OMT_DIR"; return 3; }
    chmod 700 "$OMT_DIR" || { _gfail "can't restrict $OMT_DIR to its owner"; return 3; }
    write_profile_shim
}

# $OMT_CLI pins its profile: run from any shell, it must act on this
# profile, never fall back to the default hub (plan §1.4). Written as soon
# as the dir exists, so every hint that names it is runnable.
write_profile_shim() {
    mkdir -p "$OMT_DIR/bin" || return 3
    # Written aside, then moved: a session may be running the old one.
    printf '#!/bin/bash\nOMT_HOME=%q exec %q "$@"\n' "$OMT_DIR" "$PLUGIN_DIR/bin/omt" > "$OMT_CLI.$$" \
        && chmod 755 "$OMT_CLI.$$" && mv -f "$OMT_CLI.$$" "$OMT_CLI" || { rm -f "$OMT_CLI.$$"; return 3; }
}

profile_guard_ports() {
    local p
    for p in "$ROUTER_PORT" "$HUB_BRIDGE_PORT" "$BRIDGE_PORT_BASE"; do
        if ! [[ "$p" =~ ^[0-9]+$ ]] || [ "$p" -lt 1024 ] || [ "$p" -gt 65435 ]; then
            _gfail "port '$p' is outside 1024-65435"; return 3
        fi
        if port_in_band "$p"; then
            _gfail "port $p is in the default hub's band 8800-8899"; return 3
        fi
    done
    if [ "$BRIDGE_PORT_BASE" -lt 8800 ] && [ $((BRIDGE_PORT_BASE + 99)) -ge 8800 ]; then
        _gfail "bridge ports from $BRIDGE_PORT_BASE would reach the default hub's band 8800-8899"; return 3
    fi
    if [ "$ROUTER_PORT" = "$HUB_BRIDGE_PORT" ] || [ "$ROUTER_PORT" = "$BRIDGE_PORT_BASE" ] || [ "$HUB_BRIDGE_PORT" = "$BRIDGE_PORT_BASE" ]; then
        _gfail "the router, hub bridge and bridge base ports must all differ"; return 3
    fi
    return 0
}

# profile_guard_creds [TOKEN APP_TOKEN CHAT_ID]
# Compares credentials with the default hub's hub-config.json in-process.
# With no arguments it reads this profile's own hub-config.json. Values go
# to python through the environment, never argv, and are never printed.
profile_guard_creds() {
    local why
    why="$(_creds_check "$@")" || { _gfail "$why"; return 3; }
    return 0
}

# The python lives in its own function, not inside $( ): bash 3.2 misparses
# a heredoc inside $( ) once its body holds an odd number of quotes.
_creds_check() {
    OMT_G_FLEET="$FLEET_DIR/hub-config.json" OMT_G_MINE="$CONFIG_PATH" OMT_G_ARGC="$#" \
        OMT_G_TOKEN="${1:-}" OMT_G_APP="${2:-}" OMT_G_CHAT="${3:-}" python3 - <<'PY'
import json, os, sys

def load(p, who):
    # No file: nothing to compare. A file that cannot be read: refuse,
    # since it might hold the very credentials this check is about.
    if not os.path.exists(p):
        return {}
    try:
        with open(p) as f:
            c = (json.load(f) or {}).get("credentials") or {}
        if not isinstance(c, dict):
            raise ValueError("credentials is not an object")
        return c
    except Exception:
        print(f"the {who} hub-config.json cannot be read, so credentials cannot be compared")
        sys.exit(3)

def val(d, k):
    x = d.get(k)
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        x = str(x)
    return x.strip() if isinstance(x, str) else ""

fleet = load(os.environ["OMT_G_FLEET"], "default hub")
if os.environ["OMT_G_ARGC"] == "0":
    mine = load(os.environ["OMT_G_MINE"], "profile")
else:
    chat = os.environ.get("OMT_G_CHAT", "")
    mine = {"botToken": os.environ.get("OMT_G_TOKEN", ""), "appToken": os.environ.get("OMT_G_APP", ""),
            "chatId": chat, "channelId": chat}

for k in ("botToken", "appToken"):
    a, b = val(mine, k), val(fleet, k)
    if a and a == b:
        print(f"this profile uses the default hub's {k}")
        sys.exit(3)

def bot_id(t):
    return t.split(":", 1)[0] if ":" in t else ""

a, b = bot_id(val(mine, "botToken")), bot_id(val(fleet, "botToken"))
if a and a == b:
    print("this profile uses the default hub's bot (same bot id)")
    sys.exit(3)

fleet_chats = {val(fleet, "chatId"), val(fleet, "channelId")} - {""}
for k in ("chatId", "channelId"):
    a = val(mine, k)
    if a and a in fleet_chats:
        print(f"this profile uses the default hub's group/channel ({k})")
        sys.exit(3)
sys.exit(0)
PY
}

# Ports for the router and hub bridge: refuse a port another process holds.
profile_guard_inuse() {
    need_lsof || return 3
    if port_listening "$ROUTER_PORT" && ! omt_tmux has-session -t "$(tgt omt-router)" 2>/dev/null; then
        _gfail "port $ROUTER_PORT is in use by another process"; return 3
    fi
    if port_listening "$HUB_BRIDGE_PORT" && ! omt_tmux has-session -t "$(tgt omt-hub)" 2>/dev/null; then
        _gfail "port $HUB_BRIDGE_PORT is in use by another process"; return 3
    fi
    return 0
}

profile_guard() {
    profile_guard_dirs || return 3
    profile_guard_ports || return 3
    [ -f "$CONFIG_PATH" ] && { profile_guard_creds || return 3; }
    return 0
}

# ── Bridge port allocation (plan §1.8) ──────────────────────────────────
# Every allocation, including restore, refuses the fleet band and skips
# ports that are in use or belong to the router or hub bridge.
alloc_port() {
    local port tries=0
    need_lsof || return 3
    port="$(cat "$NEXT_BRIDGE_PORT_FILE" 2>/dev/null)"
    [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] || port="$BRIDGE_PORT_BASE"
    while :; do
        tries=$((tries + 1))
        if [ $tries -gt 100 ]; then
            _gfail "no free bridge port in 100 tries from $BRIDGE_PORT_BASE"; return 3
        fi
        if port_in_band "$port" || [ "$port" -gt 65535 ]; then
            _gfail "bridge port $port is outside the profile's range"; return 3
        fi
        if [ "$port" = "$ROUTER_PORT" ] || [ "$port" = "$HUB_BRIDGE_PORT" ] || port_listening "$port"; then
            port=$((port + 1))
            continue
        fi
        break
    done
    echo $((port + 1)) > "$NEXT_BRIDGE_PORT_FILE"
    echo "$port"
}

# ── Trust (#45, plan §1.9): read-only ───────────────────────────────────

trust_check() {
    if OMT_T_JSON="$CLAUDE_JSON" OMT_T_PATH="$1" python3 -c '
import json, os, sys
try:
    with open(os.environ["OMT_T_JSON"]) as f:
        d = json.load(f)
except Exception:
    sys.exit(1)
p = (d.get("projects") or {}).get(os.environ["OMT_T_PATH"]) or {}
sys.exit(0 if p.get("hasTrustDialogAccepted") is True else 1)'; then
        return 0
    fi
    echo -e "${YELLOW}Claude hasn't trusted $1 yet; a session there would hang on the trust prompt.${RESET}" >&2
    echo -e "  Open it once: ${CYAN}cd '$1' && claude${RESET}, accept the trust prompt, exit. Then retry." >&2
    return 4
}

# ── Profile dirs, plugin view, MCP files (plan §1.4-1.5) ────────────────

# The plugin view: the checkout's plugin content WITHOUT its .mcp.json (that
# file declares the plugin server omt-bridge, which would start a second
# bridge). Rebuilt from scratch by hub start. hooks/ and .claude-plugin/ are
# COPIES, the rest links: Claude Code refuses a hooks module that resolves
# outside the plugin dir ("hooks path escapes plugin directory"), and it
# writes generated types under .claude-plugin/. So everything under hooks/
# stays as it was at the last rebuild; warn_stale_view says when it drifted.
build_plugin_view() {
    [ -n "$PLUGIN_ARG" ] && [[ "$PLUGIN_ARG" == "$OMT_DIR"/* ]] || { _gfail "bad plugin view path"; return 3; }
    rm -rf "$PLUGIN_ARG"
    mkdir -p "$PLUGIN_ARG"
    local e
    for e in agents hooks skills .claude-plugin settings.json CLAUDE.md channel bin; do
        [ -e "$PLUGIN_DIR/$e" ] || continue
        case "$e" in
            hooks|.claude-plugin) cp -R "$PLUGIN_DIR/$e" "$PLUGIN_ARG/$e" ;;
            *) ln -s "$PLUGIN_DIR/$e" "$PLUGIN_ARG/$e" ;;
        esac
    done
    return 0
}

# warn_stale_view: say when the view's hooks/ no longer match the checkout
# (a hooks or plugin.json change since the last hub start, or a view built
# before hooks/ was copied). Only a hub restart rebuilds the view.
warn_stale_view() {
    [ -e "$PLUGIN_ARG/hooks" ] || [ -L "$PLUGIN_ARG/hooks" ] || return 0
    if [ -L "$PLUGIN_ARG/hooks" ] \
        || ! diff -rq "$PLUGIN_DIR/hooks" "$PLUGIN_ARG/hooks" >/dev/null 2>&1 \
        || ! cmp -s "$PLUGIN_DIR/.claude-plugin/plugin.json" "$PLUGIN_ARG/.claude-plugin/plugin.json"; then
        echo -e "${YELLOW}The plugin view's hooks differ from the checkout's. Restart the hub to load the checkout's: $OMT_CLI hub stop && $OMT_CLI hub start${RESET}" >&2
    fi
    return 0
}

# ensure_profile_dirs: create the profile dirs and the `omt` shim. The plugin
# view is rebuilt only while no hub session is using it (or if it's missing).
ensure_profile_dirs() {
    mkdir -p "$OMT_DIR/mcp" "$OMT_DIR/tmp" "$OMT_DIR/bin" "$HUB_CWD"
    chmod 700 "$OMT_DIR/mcp"
    if [ ! -d "$PLUGIN_ARG" ] || ! omt_tmux has-session -t "$(tgt omt-hub)" 2>/dev/null; then
        build_plugin_view || return 3
    else
        warn_stale_view
    fi
    write_profile_shim
}

# write_session_mcp NAME [--no-bridge]
# $OMT_DIR/mcp/NAME.json = the clone's bridge as omtv-bridge, plus the
# operator's $OMT_DIR/mcp-extra.json servers, minus anything that would run
# the default hub's bridge.
write_session_mcp() {
    local name="$1" bridge=1
    valid_name "$name" || { _gfail "bad session name '$name' (use letters, digits, '-' and '_')"; return 3; }
    [ "$2" = "--no-bridge" ] && bridge=0
    mkdir -p "$OMT_DIR/mcp"
    OMT_M_OUT="$OMT_DIR/mcp/$name.json" OMT_M_EXTRA="$OMT_DIR/mcp-extra.json" OMT_M_NAME="$MCP_NAME" \
    OMT_M_BRIDGE="$PLUGIN_DIR/channel/bridge.ts" OMT_M_FLEET="$FLEET_DIR" OMT_M_WITH_BRIDGE="$bridge" python3 - <<'PY'
import json, os, sys

out = os.environ["OMT_M_OUT"]
servers = {}
if os.environ["OMT_M_WITH_BRIDGE"] == "1":
    servers[os.environ["OMT_M_NAME"]] = {"command": "bun", "args": ["run", os.environ["OMT_M_BRIDGE"]]}

extra_path = os.environ["OMT_M_EXTRA"]
fleet_bridge = os.path.join(os.environ["OMT_M_FLEET"], "channel", "bridge.ts")
if os.path.exists(extra_path):
    try:
        with open(extra_path) as f:
            extra = (json.load(f) or {}).get("mcpServers") or {}
        if not isinstance(extra, dict):
            raise ValueError("mcpServers is not an object")
    except Exception as e:
        print(f"omt: ignoring mcp-extra.json ({e})", file=sys.stderr)
        extra = {}
    for key, entry in extra.items():
        if key in ("omt-bridge", "omtv-bridge"):
            print(f"omt: mcp-extra.json: dropped '{key}' (reserved bridge name)", file=sys.stderr)
            continue
        blob = json.dumps(entry)
        if "/.oh-my-team/channel/bridge.ts" in blob or fleet_bridge in blob:
            print(f"omt: mcp-extra.json: dropped '{key}' (runs the default hub's bridge)", file=sys.stderr)
            continue
        servers[key] = entry

fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"mcpServers": servers}, f, indent=2)
os.chmod(out, 0o600)
PY
}

# ── Models (WO-025, fork #22) ────────────────────────────────────────────
# The hub's model is hubModel in this profile's hub-config.json; a project
# session's is the `model` of its registry entry. Nothing here reads or
# writes ~/.claude/settings.json.

# _hub_model_raw: prints json.dumps(hubModel), or nothing when the key is
# absent. Returns 1 when the config can't be read as a JSON object.
_hub_model_raw() {
    OMT_M_FILE="$CONFIG_PATH" python3 - <<'PY'
import json, os, sys
try:
    with open(os.environ["OMT_M_FILE"]) as f:
        d = json.load(f)
    if not isinstance(d, dict):
        raise ValueError("not an object")
    if "hubModel" in d:
        print(json.dumps(d["hubModel"]))
except Exception:
    sys.exit(1)
PY
}

# hub init (profile mode) rewrites hub-config.json with `cat >`, which would
# drop hubModel. The snapshot, taken before, holds the old value's JSON, or
# is empty when the old config had no key or couldn't be read (absent and
# null differ: null is the opt-out). keep, run after the write, puts the
# value back, or writes "fable" when there was none.
profile_hub_model_snapshot() {
    _HUB_MODEL_SNAP=$(_hub_model_raw) || _HUB_MODEL_SNAP=""
}

profile_hub_model_keep() {
    if ! _hub_model_keep; then
        echo -e "${RED}omt: hubModel could not be set in $CONFIG_PATH; set it by hand (docs/omtv.md, Model).${RESET}" >&2
        return 3
    fi
}

# On failure it prints only the error's type and message (a JSON error names
# a line and column, a decode error at most one byte), so the token in the
# file isn't shown.
_hub_model_keep() {
    OMT_M_FILE="$CONFIG_PATH" OMT_M_SNAP="${_HUB_MODEL_SNAP:-}" python3 - <<'PY'
import json, os, sys, tempfile
try:
    p = os.environ["OMT_M_FILE"]
    snap = os.environ.get("OMT_M_SNAP", "")
    with open(p) as f:
        d = json.load(f)
    d["hubModel"] = json.loads(snap) if snap else "fable"
    fd, t = tempfile.mkstemp(dir=os.path.dirname(p), prefix=".hub-config.")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(d, indent=2, allow_nan=False) + "\n")
        os.chmod(t, 0o600)
        os.replace(t, p)
    except BaseException:
        os.unlink(t)
        raise
except Exception as e:
    print(f"omt: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
PY
}

# session_cmd NAME CWD PORT AGENT CONT [MODEL] → the pane command for a
# session. MODEL must already have passed valid_model. The tmux argument is a
# bash double-quoted string; the single quotes around MODEL are for the pane
# shell, so a bracketed id like opus[1m] is never globbed.
session_cmd() {
    local name="$1" cwd="$2" port="$3" agent="$4" cont="$5" smodel="${6:-}" settings="" mflag=""
    [ -f "$OMT_DIR/settings.json" ] && settings="--settings '$OMT_DIR/settings.json' "
    [ -n "$smodel" ] && mflag="--model '$smodel' "
    printf '%s' "cd '$cwd' && OMT_HUB_DIR='$OMT_DIR' BRIDGE_PORT=$port ROUTER_URL=http://localhost:$ROUTER_PORT ROUTER_PORT=$ROUTER_PORT SESSION_NAME=$name OMT_PLUGIN_DIR='$PLUGIN_DIR' claude --plugin-dir '$PLUGIN_ARG' --agent $agent ${mflag}--dangerously-skip-permissions --setting-sources project,local ${settings}--strict-mcp-config --mcp-config '$OMT_DIR/mcp/$name.json' --dangerously-load-development-channels server:$MCP_NAME $cont; rc=\$?; echo \"\$(date -u +%FT%TZ) $name: claude exited \$rc\" >> '$OMT_DIR/sessions.log'; echo 'Session ended. Press any key...'; read -n1"
}

# Wait for a bridge's /health, nudging first-run prompts with Enter.
_wait_bridge() {
    local port="$1" target="$2" max="$3" every="$4" retries=0
    while ! curl -s "http://localhost:$port/health" > /dev/null 2>&1; do
        sleep 1
        retries=$((retries + 1))
        [ $retries -gt "$max" ] && return 1
        [ $((retries % every)) -eq 0 ] && omt_tmux send-keys -t "$(tgt_pane "$target")" Enter 2>/dev/null
    done
    return 0
}

# ── Commands ────────────────────────────────────────────────────────────

profile_hub_start() {
    local CONTINUE_FLAG=""
    while [ $# -gt 0 ]; do
        case "$1" in
            -c|--continue) CONTINUE_FLAG="--continue"; shift ;;
            --no-browser)  shift ;;
            *)             break ;;
        esac
    done

    profile_guard || return $?
    require_bun
    require_config
    # The hub's model: hubModel only, checked before anything starts. The
    # raw value is never printed (it may hold a payload or terminal escapes).
    local hub_model hub_model_raw
    if ! hub_model_raw=$(_hub_model_raw); then
        _gfail "$CONFIG_PATH can't be read as a JSON object"; return 3
    fi
    if ! hub_model=$(model_from_json "$hub_model_raw"); then
        _gfail "$CONFIG_PATH: hubModel isn't a model id (letters, digits, . _ : @ / [ ] -, 1-100 chars)"; return 3
    fi
    profile_guard_creds || return 3
    profile_guard_inuse || return 3

    if [ -z "$CONTINUE_FLAG" ] && [ -f "$OMT_DIR/.hub-initialized" ]; then
        CONTINUE_FLAG="--continue"
        echo -e "${DIM}Resuming previous hub session...${RESET}"
    fi

    ensure_profile_dirs || return 3
    trust_check "$HUB_CWD" || return 4

    if [ ! -d "$CHANNEL_DIR/node_modules" ]; then
        echo -e "${YELLOW}Installing channel dependencies...${RESET}"
        (cd "$CHANNEL_DIR" && bun install --no-save --no-summary 2>&1)
    fi
    if [ -f "$CHANNEL_DIR/dashboard/package.json" ] && [ ! -f "$CHANNEL_DIR/dashboard/dist/index.html" ]; then
        echo -e "${DIM}Dashboard not built; run: cd '$CHANNEL_DIR/dashboard' && bun install && bun run build${RESET}"
    fi

    # Router. The pane closes when the router exits, so a refused start
    # doesn't leave a stale "omt-router" behind.
    if omt_tmux has-session -t "$(tgt omt-router)" 2>/dev/null \
        && curl -s "http://localhost:$ROUTER_PORT/health" > /dev/null 2>&1; then
        echo -e "${YELLOW}Router already running.${RESET}"
    else
        omt_tmux kill-session -t "$(tgt omt-router)" 2>/dev/null
        echo -e "${GREEN}Starting router on port $ROUTER_PORT...${RESET}"
        local seam_env="" preload=""
        [ -n "$_SEAM_ROOT" ] && seam_env="OMT_TEST_SANDBOX='$_SEAM_ROOT' OMT_FLEET_DIR='$FLEET_DIR' "
        [ -n "$ROUTER_PRELOAD" ] && preload="--preload '$ROUTER_PRELOAD' "
        omt_tmux new-session -d -s omt-router \
            "cd '$CHANNEL_DIR' && ${seam_env}OMT_PROFILE=1 OMT_HUB_DIR='$OMT_DIR' ROUTER_PORT=$ROUTER_PORT bun run ${preload}router.ts 2>&1 | tee '$OMT_DIR/router.log'"
        local retries=0
        while ! curl -s "http://localhost:$ROUTER_PORT/health" > /dev/null 2>&1; do
            sleep 0.5
            retries=$((retries + 1))
            if [ $retries -gt 20 ]; then
                omt_tmux kill-session -t "$(tgt omt-router)" 2>/dev/null
                echo -e "${RED}Router failed to start. Last log lines:${RESET}" >&2
                tail -15 "$OMT_DIR/router.log" >&2 2>/dev/null
                return 1
            fi
        done
        echo -e "${GREEN}Router ready.${RESET}"
    fi

    # Hub session: runs in $OMT_DIR/hub, never $HOME.
    if omt_tmux has-session -t "$(tgt omt-hub)" 2>/dev/null; then
        echo -e "${YELLOW}Hub session already running.${RESET}"
    else
        if port_listening "$HUB_BRIDGE_PORT"; then
            _gfail "port $HUB_BRIDGE_PORT answers before the hub session exists (a foreign bridge)"; return 3
        fi
        echo -e "${GREEN}Starting hub session (bridge on port $HUB_BRIDGE_PORT)...${RESET}"
        echo "$BRIDGE_PORT_BASE" > "$NEXT_BRIDGE_PORT_FILE"
        write_session_mcp hub || return 3
        omt_tmux new-session -d -s omt-hub \
            "$(session_cmd hub "$HUB_CWD" "$HUB_BRIDGE_PORT" hub "$CONTINUE_FLAG" "$hub_model")"
        sleep 3
        omt_tmux send-keys -t "$(tgt_pane omt-hub)" Enter 2>/dev/null
        sleep 2
        omt_tmux send-keys -t "$(tgt_pane omt-hub)" Enter 2>/dev/null
        echo -e "  ${DIM}Waiting for hub bridge...${RESET}"
        if ! _wait_bridge "$HUB_BRIDGE_PORT" omt-hub 60 10; then
            echo -e "${YELLOW}Hub bridge not ready yet. You may need to accept prompts:${RESET}"
            echo -e "  ${CYAN}$OMT_CLI hub attach${RESET}  (then Ctrl+B, D to detach)"
        else
            local reg_retries=0 reg_result registered=0
            while [ $reg_retries -lt 5 ]; do
                reg_result=$(curl -s -X POST "http://localhost:$ROUTER_PORT/sessions" \
                    -H "Content-Type: application/json" \
                    -d "{\"name\": \"hub\", \"path\": \"$HUB_CWD\", \"bridgePort\": $HUB_BRIDGE_PORT, \"isHub\": true}")
                if echo "$reg_result" | grep -q '"threadId"' 2>/dev/null; then registered=1; break; fi
                reg_retries=$((reg_retries + 1))
                sleep 1
            done
            if [ $registered = 1 ]; then
                echo -e "${GREEN}Hub registered.${RESET}"
                # Only now: a later start resumes (--continue) only a hub that really ran.
                touch "$OMT_DIR/.hub-initialized"
            else
                echo -e "${YELLOW}The hub's bridge is up but the router didn't register it. Check: $OMT_CLI hub logs${RESET}" >&2
            fi
        fi
    fi

    echo ""
    echo -e "${GREEN}${BOLD}Oh My Team hub (profile: $TMUX_SOCKET) is running.${RESET}"
    echo ""
    echo -e "  ${DIM}Router:${RESET}    http://localhost:$ROUTER_PORT"
    echo -e "  ${DIM}Hub:${RESET}       http://localhost:$HUB_BRIDGE_PORT"
    echo -e "  ${DIM}Attach:${RESET}    $OMT_CLI hub attach   (socket: $TMUX_SOCKET)"
    echo -e "  ${DIM}Dashboard:${RESET} $OMT_CLI dashboard"
    echo ""

    profile_hub_restore
}

profile_hub_restore() {
    local REGISTRY_FILE="$OMT_DIR/hub-registry.json"
    [ -f "$REGISTRY_FILE" ] || return 0
    local restore_list
    restore_list=$(OMT_R_FILE="$REGISTRY_FILE" python3 -c '
import json, os, sys
try:
    with open(os.environ["OMT_R_FILE"]) as f:
        data = json.load(f)
    for name, info in data.get("sessions", {}).items():
        if name == "hub":
            continue
        p = info.get("path", "")
        if p and os.path.isdir(p):
            # The path goes last so a tab in it stays in it; "-" (never JSON)
            # marks no model, so an empty column never shifts the others.
            # (read still trims a tab at either end of the path, and an empty
            # name or one holding a tab shifts the columns; every column is
            # still checked.)
            m = json.dumps(info["model"]) if "model" in info else "-"
            print(f"{name}\t{m}\t{p}")
except Exception as e:
    print(f"Error reading registry: {e}", file=sys.stderr)
' 2>/dev/null)
    [ -n "$restore_list" ] || return 0

    echo ""
    echo -e "${CYAN}Restoring previous sessions...${RESET}"
    local name rawmodel proj_path PORT model
    while IFS=$'\t' read -r name rawmodel proj_path; do
        if ! valid_name "$name" || ! safe_path "$proj_path"; then
            echo -e "  ${YELLOW}Skipping a registry entry with an unsafe name or path.${RESET}" >&2
            continue
        fi
        if ! model=$(model_from_json "$rawmodel"); then
            echo -e "  ${YELLOW}Skipping $name: its registry model isn't a model id.${RESET}" >&2
            continue
        fi
        echo -e "  ${DIM}Restoring $name ($proj_path)...${RESET}"
        if omt_tmux has-session -t "$(tgt "omt-$name")" 2>/dev/null; then
            echo -e "  ${YELLOW}$name is already running.${RESET}"
            continue
        fi
        trust_check "$proj_path" || continue
        PORT=$(alloc_port) || continue
        write_session_mcp "$name" || continue
        omt_tmux new-session -d -s "omt-$name" \
            "$(session_cmd "$name" "$proj_path" "$PORT" sisyphus --continue "$model")"
        sleep 2
        omt_tmux send-keys -t "$(tgt_pane "omt-$name")" Enter 2>/dev/null
        sleep 1
        omt_tmux send-keys -t "$(tgt_pane "omt-$name")" Enter 2>/dev/null
        (
            if _wait_bridge "$PORT" "omt-$name" 60 10; then
                local result
                result=$(curl -s -X POST "http://localhost:$ROUTER_PORT/sessions" \
                    -H "Content-Type: application/json" \
                    -d "{\"name\": \"$name\", \"path\": \"$proj_path\", \"bridgePort\": $PORT}")
                if echo "$result" | grep -q '"error"' 2>/dev/null; then
                    echo -e "  ${RED}Registration failed for '$name'.${RESET}" >&2
                else
                    echo -e "  ${GREEN}Restored: $name (port $PORT)${RESET}"
                fi
            else
                echo -e "  ${RED}Failed to restore '$name' — bridge timeout.${RESET}" >&2
            fi
        ) &
    done <<< "$restore_list"
    wait
}

profile_hub_add() {
    local CONTINUE_FLAG="" PROJECT_DIR="" arg
    for arg in "$@"; do
        case "$arg" in
            -c|--continue) CONTINUE_FLAG="--continue" ;;
            *)             [ -z "$PROJECT_DIR" ] && PROJECT_DIR="$arg" ;;
        esac
    done
    if [ -z "$PROJECT_DIR" ]; then
        echo -e "${RED}Usage: $OMT_CLI hub add <project-directory> [-c]${RESET}"
        return 1
    fi

    profile_guard || return $?
    require_router

    local GIVEN_DIR="$PROJECT_DIR"
    PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd)" || {
        echo -e "${RED}Directory not found: $GIVEN_DIR${RESET}"
        return 1
    }
    local NAME PORT existing result
    NAME=$(session_name_from_path "$PROJECT_DIR")
    if ! valid_name "$NAME" || ! safe_path "$PROJECT_DIR"; then
        echo -e "${RED}omt: profile mode needs a project dir whose name uses only letters, digits, '.', '-', '_' or spaces, and whose path has no quote: $PROJECT_DIR${RESET}" >&2
        return 2
    fi

    existing=$(curl -s "http://localhost:$ROUTER_PORT/sessions/$NAME" 2>/dev/null)
    if echo "$existing" | grep -q '"name"' 2>/dev/null; then
        echo -e "${YELLOW}Session '$NAME' already exists.${RESET}"
        return 1
    fi

    trust_check "$PROJECT_DIR" || return 4
    if [ -d "$PLUGIN_ARG" ] && [ -x "$OMT_CLI" ]; then
        warn_stale_view
    else
        ensure_profile_dirs || return 3
    fi
    PORT=$(alloc_port) || return 3
    if port_listening "$PORT"; then
        _gfail "port $PORT answers before the session exists (a foreign bridge)"; return 3
    fi
    write_session_mcp "$NAME" || return 3

    echo -e "${GREEN}Starting session '$NAME' (port $PORT)...${RESET}"
    omt_tmux new-session -d -s "omt-$NAME" \
        "$(session_cmd "$NAME" "$PROJECT_DIR" "$PORT" sisyphus "$CONTINUE_FLAG")"
    sleep 2
    omt_tmux send-keys -t "$(tgt_pane "omt-$NAME")" Enter 2>/dev/null
    sleep 1
    omt_tmux send-keys -t "$(tgt_pane "omt-$NAME")" Enter 2>/dev/null
    sleep 1
    omt_tmux send-keys -t "$(tgt_pane "omt-$NAME")" Enter 2>/dev/null

    if ! _wait_bridge "$PORT" "omt-$NAME" 45 5; then
        echo -e "${RED}Bridge failed to start for '$NAME'. Check: $OMT_CLI hub attach $NAME${RESET}"
        return 1
    fi

    result=$(curl -s -X POST "http://localhost:$ROUTER_PORT/sessions" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"$NAME\", \"path\": \"$PROJECT_DIR\", \"bridgePort\": $PORT}")
    if echo "$result" | grep -q '"error"' 2>/dev/null; then
        echo -e "${RED}Registration failed: $(echo "$result" | grep -o '"error":"[^"]*"')${RESET}"
        return 1
    fi

    echo -e "${GREEN}${BOLD}Session '$NAME' started.${RESET}"
    echo -e "  ${DIM}Project:${RESET} $PROJECT_DIR"
    echo -e "  ${DIM}Bridge:${RESET}  http://localhost:$PORT"
    echo -e "  ${DIM}Attach:${RESET}  $OMT_CLI hub attach $NAME"
}

profile_hub_remove() {
    local NAME="$1"
    if [ -z "$NAME" ]; then
        echo -e "${RED}Usage: $OMT_CLI hub remove <session-name>${RESET}"
        return 1
    fi
    valid_name "$NAME" || { echo -e "${RED}omt: bad session name '$NAME'${RESET}" >&2; return 2; }
    profile_guard_dirs || return 3
    require_router
    curl -s -X DELETE "http://localhost:$ROUTER_PORT/sessions/$NAME" > /dev/null 2>&1
    if omt_tmux has-session -t "$(tgt "omt-$NAME")" 2>/dev/null; then
        omt_tmux kill-session -t "$(tgt "omt-$NAME")"
    fi
    rm -f "$OMT_DIR/mcp/$NAME.json"
    echo -e "${GREEN}Stopped: $NAME${RESET}"
}

profile_hub_stop() {
    local CLEAN=false
    if [ "$1" = "--clean" ] || [ "$1" = "--force" ]; then
        CLEAN=true
    fi
    profile_guard_dirs || return 3
    echo -e "${YELLOW}Stopping all sessions (profile: $TMUX_SOCKET)...${RESET}"
    local sessions s name
    sessions=$(omt_tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^omt-" | grep -vx "omt-hub" | grep -vx "omt-router")
    if [ -n "$sessions" ]; then
        while IFS= read -r s; do
            name="${s#omt-}"
            if [ "$CLEAN" = true ]; then
                curl -s -X DELETE "http://localhost:$ROUTER_PORT/sessions/$name" > /dev/null 2>&1
            fi
            omt_tmux kill-session -t "$(tgt "$s")" 2>/dev/null
            echo -e "  ${GREEN}Stopped: $name${RESET}"
        done <<< "$sessions"
    fi
    if omt_tmux has-session -t "$(tgt omt-hub)" 2>/dev/null; then
        omt_tmux kill-session -t "$(tgt omt-hub)"
        echo -e "  ${GREEN}Stopped: hub${RESET}"
    fi
    if omt_tmux has-session -t "$(tgt omt-router)" 2>/dev/null; then
        omt_tmux kill-session -t "$(tgt omt-router)"
        echo -e "  ${GREEN}Stopped: router${RESET}"
    fi
    if [ "$CLEAN" = true ]; then
        rm -f "$OMT_DIR/hub-registry.json" "$OMT_DIR/.hub-initialized" 2>/dev/null
        echo -e "${GREEN}${BOLD}Hub shut down and cleaned. Next start will be fresh.${RESET}"
    else
        echo -e "${GREEN}${BOLD}Hub shut down. Sessions preserved — run '$OMT_CLI hub start' to resume.${RESET}"
    fi
}

profile_hub_attach() {
    local NAME="${1:-hub}" target
    case "$NAME" in
        hub)    target="omt-hub" ;;
        router) target="omt-router" ;;
        *)      target="omt-$NAME" ;;
    esac
    omt_tmux has-session -t "$(tgt "$target")" 2>/dev/null || { echo -e "${RED}'$NAME' is not running.${RESET}"; return 1; }
    omt_tmux attach-session -t "$(tgt "$target")"
}

profile_hub_status() {
    echo -e "${BOLD}Oh My Team hub (profile: $TMUX_SOCKET, $OMT_DIR)${RESET}"
    echo ""
    local health
    health=$(curl -s "http://localhost:$ROUTER_PORT/health" 2>/dev/null)
    if [ -n "$health" ]; then
        echo -e "  Router:   ${GREEN}running${RESET} (port $ROUTER_PORT)"
    else
        echo -e "  Router:   ${RED}stopped${RESET}"
    fi
    if omt_tmux has-session -t "$(tgt omt-hub)" 2>/dev/null; then
        echo -e "  Hub:      ${GREEN}running${RESET}"
    else
        echo -e "  Hub:      ${RED}stopped${RESET}"
    fi
    echo ""
    hub_list 2>/dev/null
}

profile_hub_cmd() {
    case "${1:-status}" in
        start)      shift; profile_hub_start "$@" ;;
        add)        shift; profile_hub_add "$@" ;;
        remove|rm)  shift; profile_hub_remove "$@" ;;
        stop)       shift; profile_hub_stop "$@" ;;
        attach|a)   shift; profile_hub_attach "$@" ;;
        status)     profile_hub_status ;;
        # The shared implementations, which are profile-aware.
        init)       shift; hub_init "$@" ;;
        list|ls)    hub_list ;;
        logs)       hub_logs ;;
        # Never fall through to a default-mode hub_*: those write the
        # project's .mcp.json and .omt-env and use the default hub's dirs.
        *)          echo -e "${RED}Unknown hub command: $1${RESET}"; echo "Run: $OMT_CLI help"; return 1 ;;
    esac
}

# Interactive `omt --profile NAME` (no subcommand): one Claude in the
# profile's tmux server, no bridge, no status posts (plan §1.10).
profile_interactive() {
    if ! command -v tmux &>/dev/null; then
        echo -e "${RED}omt: profile mode needs the terminal multiplexer (not found by: command -v tmux).${RESET}" >&2
        exit 2
    fi
    profile_guard_dirs || exit 3
    ensure_profile_dirs || exit 3
    trust_check "$PWD" || exit 4
    # Drop the MCP files of interactive sessions that have ended. A file
    # under a minute old may belong to a launch whose session isn't up yet.
    local f old
    for f in "$OMT_DIR"/mcp/interactive-*.json; do
        [ -e "$f" ] || continue
        [ -n "$(find "$f" -mmin +1 2>/dev/null)" ] || continue
        old="${f##*/interactive-}"; old="${old%.json}"
        omt_tmux has-session -t "$(tgt "omt-$old")" 2>/dev/null || rm -f "$f"
    done
    write_session_mcp "interactive-$$" --no-bridge || exit 3
    local settings="" inner a
    [ -f "$OMT_DIR/settings.json" ] && settings="--settings '$OMT_DIR/settings.json' "
    inner="OMT_NO_STATUS=1 claude --plugin-dir '$PLUGIN_ARG' --agent sisyphus --setting-sources project,local ${settings}--strict-mcp-config --mcp-config '$OMT_DIR/mcp/interactive-$$.json'"
    for a in "$@"; do
        case "$a" in -d|--danger) a="--dangerously-skip-permissions" ;; esac
        inner="$inner $(printf '%q' "$a")"
    done
    if [ "$PROFILE_PRINT_ONLY" = "1" ]; then
        echo "$inner"
        exit 0
    fi
    omt_tmux new-session -s "omt-$$" -c "$PWD" "$inner; echo 'Press any key to exit...'; read -n1"
    exit $?
}

profile_help() {
    echo "omt profile '$TMUX_SOCKET' ($OMT_DIR). Its CLI: $OMT_CLI"
    echo ""
    echo "  $OMT_CLI                     Interactive session (-d: auto-approve, -c: continue)"
    echo "  $OMT_CLI hub init            Configure (asks for the bot token)"
    echo "  $OMT_CLI hub start [-c]      Router + hub"
    echo "  $OMT_CLI hub add <dir> [-c]  A project session"
    echo "  $OMT_CLI hub remove <name>   Stop a project session"
    echo "  $OMT_CLI hub list | status | logs"
    echo "  $OMT_CLI hub attach [name]   Attach (Ctrl+B, D to detach)"
    echo "  $OMT_CLI hub stop [--clean]  Stop the hub (--clean also closes threads)"
    echo "  $OMT_CLI dashboard           Open the dashboard"
    echo ""
    echo "Guide: $PLUGIN_DIR/docs/omtv.md"
}

profile_print_env() {
    local v
    for v in OMT_PROFILE PLUGIN_DIR PLUGIN_ARG OMT_DIR CHANNEL_DIR CONFIG_PATH NEXT_BRIDGE_PORT_FILE \
             ROUTER_PORT HUB_BRIDGE_PORT BRIDGE_PORT_BASE TMUX_SOCKET TMUX_PREFIX MCP_NAME OMT_CLI HUB_CWD \
             FLEET_DIR CLAUDE_JSON; do
        echo "$v=${!v}"
    done
    echo "SESSION_CMD=$(session_cmd sample /p 1234 sisyphus "" sample-model)"
}

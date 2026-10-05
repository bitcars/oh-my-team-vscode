/**
 * Removal control for the profile-mode tests (WO-021 plan v2 §7).
 *
 * A green suite proves something only if it goes red when the behaviour is
 * gone. Each mutant TEXTUALLY patches a file in a temp copy of the checkout,
 * runs the tests it names there (JUnit report), and asserts the mustFail
 * tests fail and the mustPass tests still pass, so the mutant is caught by
 * the test meant to catch it, not by a crash.
 *
 * Every spawned bin/omt still goes through test/omt-harness.ts in the copy,
 * so a mutant can't reach the default hub either.
 *
 * "HARNESS BROKEN" means the control is not measuring anything: an unmutated
 * run failed, a patch didn't apply exactly once, a named test doesn't exist,
 * or no report was written. Fix the harness or the table; never delete a
 * mutant to go green.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

setDefaultTimeout(900_000);

const REPO = path.resolve(import.meta.dir, "..");
const ROOT = mkdtempSync(path.join(realpathSync("/tmp"), "omt-profile-control-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const OLD_OMT = path.join(ROOT, "omt-c5ae60b");
{
  const r = Bun.spawnSync(["git", "-C", REPO, "show", "c5ae60b:bin/omt"]);
  if (r.exitCode !== 0) throw new Error("HARNESS BROKEN: can't read c5ae60b:bin/omt");
  writeFileSync(OLD_OMT, r.stdout);
}

const PROFILE = "test/omt-profile.test.ts";
const GUARD = "channel/router-guard.test.ts";

interface Mutant {
  name: string;
  file: string;
  suite: string;
  patches: [find: string, replace: string][];
  mustFail: string[];
  mustPass: string[];
}

const T1F = "T1 old and new bin/omt make identical calls and writes (fleet agents dir: false)";
const T2 = "T2 profile values ignore an inherited fleet env and live under OMT_HOME";
const T3REAL = "T3 bin/omt and bin/omt-profile.sh call tmux only through omt_tmux";
const T3LINT = "T3 the lint flags all 15 ways to call tmux";
const T4DIRS = "T4 profile dirs: the fleet dir, inside it, $HOME or a link to it are refused; a sibling is allowed";
const T4PORTS = "T4 ports: 8800 and 8899 refused, 8799 and 8900 allowed, for each port";
const T4CREDS = "T4 credentials: same token, bot id, app token or chat refused; near misses allowed; never printed";
const T5A = "T5a flags: the fleet token is refused before getMe (0 curl calls)";
const T5B = "T5b no flags: the bash flow runs (0 node calls) and refuses the typed fleet token";
const T5C = "T5c slack: the fleet app token is refused before apps.connections.open";
const T6 = "T6 mcp-extra servers are added; any bridge named or pathed like the fleet's is dropped";
const T7 = "T7 a session started from a polluted env sees only the profile's values";
const T7MD = "T7 agents/hub.md never tells the hub to run a bare `omt hub`";
const T8 = "T8 start, add, stop, restore, stop write nothing outside the profile";
const T9 = "T9 an untrusted project is refused before any session starts; a trusted one starts";
const T10 = "T10 the session env wins over a cwd .omt-env; the file is the fallback";
const T11 = "T11 the plugin view copies hooks/ and .claude-plugin/, links the rest, has no .mcp.json, and replaces stale content";
const T12 = "T12 interactive mode posts no status even with a fleet .omt-env in cwd, and uses the plugin view";
const T13 = "T13 a bridge port held by another process is skipped, never registered";
const T14 = "T14 seams without the OMT_TEST_SANDBOX gate, or with a gate outside temp, are ignored";
const T17 = "T17 a hub start whose bridge never comes up doesn't mark the hub initialized";
const T18 = "T18 hub add and interactive mode warn when the view's hooks or manifest differ from the checkout's, or hooks/ is still a link";
// added after the review gate
const T2REL = "T2 a relative OMT_HOME is made absolute against the cwd";
const T2SHIM = "T2 the profile's omt shim acts on its own profile when run from a plain shell";
const T4EVERY = "T4 every profile command refuses a bad dir or port before any call or write";
const T4UNREAD = "T4 credentials: a default hub config that can't be read is refused; a missing one is allowed";
const T13B = "T13 a foreign bridge that takes the chosen port before the session is refused (exit 3), never registered";
const T17B = "T17 a hub whose bridge comes up but never registers isn't marked initialized";
const G_CONTAINS = "refuses a hub dir that contains the default hub's dir";
const G_UNREAD = "refuses when the default hub's config exists but can't be read; allows when there is none";
const G_SEAM = "honours the OMT_FLEET_DIR seam only under a private temp gate";
const T1CMDS = "T1 default-mode status, list, logs, attach, dashboard, help and interactive runs are unchanged";
const T4INUSE = "T4 ports in use: a foreign listener on the router or hub bridge port refuses hub start, no session";
const T9HUB = "T9 an untrusted hub dir is refused (exit 4) before any session starts";
const T4OCTAL = "T4 ports: a port written with a leading zero is refused, not read as octal";
const T4LSOF = "T4 without lsof, hub start refuses (exit 3) instead of treating every port as free";
const G_DIR = "refuses the default hub's dir and anything inside it";
const G_PORTS = "refuses ports 8800 and 8899, allows 8799 and 8900";
const G_TOKEN = "refuses the default hub's token, bot id and app token; allows near misses";
const G_CHAT = "refuses the default hub's chat; allows another";
const G_UNGATED = "without OMT_PROFILE the router is unchanged: the default dir on a non-8800 port starts";

const GUARD_BLOCK = `if (process.env.OMT_PROFILE === "1") {
  const refusal = profileStartupRefusal(config, OMT_HUB_DIR, ROUTER_PORT);
  if (refusal) {
    process.stderr.write(\`omt-router: refusing to start: \${refusal}\\n\`);
    process.exit(2);
  }
}
`;
const ADAPTER_LINE = "const adapter = await loadAdapter(config.platform);\n";

const P = "bin/omt-profile.sh";
const MUTANTS: Mutant[] = [
  // ── T1: default mode unchanged ──
  {
    name: "skip-guard-inverted: profile dispatch runs in default mode",
    file: "bin/omt", suite: PROFILE,
    patches: [['    if [ -n "$OMT_PROFILE" ]; then\n        profile_hub_cmd "$@"', '    if [ -z "$OMT_PROFILE" ]; then\n        profile_hub_cmd "$@"']],
    mustFail: [T1F], mustPass: [T2],
  },
  {
    name: "default-gets-socket: the default mode's tmux gets a socket",
    file: "bin/omt", suite: PROFILE,
    patches: [['    else\n        tmux "$@"\n    fi', '    else\n        tmux -L omt "$@"\n    fi']],
    mustFail: [T1F], mustPass: [T2],
  },
  // ── T2: resolution ──
  {
    name: "profile-inherits-port: the router port comes from the inherited env",
    file: P, suite: PROFILE,
    patches: [["    ROUTER_PORT=9800\n", '    ROUTER_PORT="${ROUTER_PORT:-9800}"\n']],
    mustFail: [T2], mustPass: [T3LINT],
  },
  {
    name: "next-port-file-fleet: the next-port file lives outside the profile",
    file: P, suite: PROFILE,
    patches: [['    NEXT_BRIDGE_PORT_FILE="$OMT_DIR/.next-bridge-port"', '    NEXT_BRIDGE_PORT_FILE="$FLEET_DIR/.next-bridge-port"']],
    mustFail: [T2], mustPass: [T3LINT],
  },
  // ── T3: lint ──
  {
    name: "bare-tmux: one call bypasses omt_tmux",
    file: "bin/omt", suite: PROFILE,
    patches: [['    # Start the router\n    if omt_tmux has-session -t "omt-router" 2>/dev/null; then', '    # Start the router\n    if tmux has-session -t "omt-router" 2>/dev/null; then']],
    mustFail: [T3REAL], mustPass: [T3LINT],
  },
  // ── T4: guard ──
  {
    name: "band-starts-8801: port 8800 slips through",
    file: P, suite: PROFILE,
    patches: [['port_in_band() { [ "$1" -ge 8800 ]', 'port_in_band() { [ "$1" -ge 8801 ]']],
    mustFail: [T4PORTS], mustPass: [T4CREDS],
  },
  {
    name: "band-ends-8898: port 8899 slips through",
    file: P, suite: PROFILE,
    patches: [['[ "$1" -le 8899 ]; }', '[ "$1" -le 8898 ]; }']],
    mustFail: [T4PORTS], mustPass: [T4CREDS],
  },
  {
    name: "no-containment: a dir inside the fleet dir is allowed",
    file: P, suite: PROFILE,
    patches: [['        if _inside "$OMT_DIR" "$FLEET_DIR"; then', '        if [ "$(_realpath "$OMT_DIR")" = "$(_realpath "$FLEET_DIR")" ]; then']],
    mustFail: [T4DIRS], mustPass: [T4PORTS],
  },
  {
    name: "no-botid: a regenerated token for the fleet's bot is allowed",
    file: P, suite: PROFILE,
    patches: [['a, b = bot_id(val(mine, "botToken")), bot_id(val(fleet, "botToken"))\nif a and a == b:', 'a, b = bot_id(val(mine, "botToken")), bot_id(val(fleet, "botToken"))\nif False:']],
    mustFail: [T4CREDS], mustPass: [T4PORTS],
  },
  {
    name: "no-chatid: the fleet's group is allowed",
    file: P, suite: PROFILE,
    patches: [["    if a and a in fleet_chats:", "    if False:"]],
    mustFail: [T4CREDS], mustPass: [T4PORTS],
  },
  {
    name: "no-token-guard: the fleet's app token is allowed",
    file: P, suite: PROFILE,
    patches: [['    if a and a == b:\n        print(f"this profile uses the default hub\'s {k}")', '    if False:\n        print(f"this profile uses the default hub\'s {k}")']],
    mustFail: [T4CREDS], mustPass: [T4PORTS],
  },
  // ── T5: init ──
  {
    name: "guard-after-getme: the token reaches getMe before the guard",
    file: "bin/omt", suite: PROFILE,
    patches: [['        if [ -n "$OMT_PROFILE" ]; then profile_guard_creds "$TOKEN" "" "$CHAT_ID" || exit 3; fi\n\n        # Verify token', "\n        # Verify token"]],
    mustFail: [T5A], mustPass: [T5C],
  },
  {
    name: "profile-uses-mjs: profile init runs the unguarded node flow",
    file: "bin/omt", suite: PROFILE,
    patches: [['command -v node &>/dev/null && [ -z "$OMT_PROFILE" ]; then', "command -v node &>/dev/null; then"]],
    mustFail: [T5B], mustPass: [T5A],
  },
  // ── T6: MCP file ──
  {
    name: "no-name-filter: an extra entry named omt-bridge is kept",
    file: P, suite: PROFILE,
    patches: [['        if key in ("omt-bridge", "omtv-bridge"):', "        if False:"]],
    mustFail: [T6], mustPass: [T2],
  },
  {
    name: "no-path-filter: an extra entry running the fleet's bridge is kept",
    file: P, suite: PROFILE,
    patches: [['        if "/.oh-my-team/channel/bridge.ts" in blob or fleet_bridge in blob:', "        if False:"]],
    mustFail: [T6], mustPass: [T2],
  },
  // ── T7: env ──
  {
    name: "wrapper-no-env-i: the profile's tmux inherits the caller's env",
    file: "bin/omt", suite: PROFILE,
    patches: [['        env -i HOME="$HOME"', '        env HOME="$HOME"']],
    mustFail: [T7], mustPass: [T7MD],
  },
  {
    name: "no-omt-cli: sessions don't get OMT_CLI",
    file: "bin/omt", suite: PROFILE,
    patches: [['OMT_HOME="$OMT_DIR" OMT_CLI="$OMT_CLI" "${pass[@]}"', 'OMT_HOME="$OMT_DIR" "${pass[@]}"']],
    mustFail: [T7], mustPass: [T7MD],
  },
  {
    name: "tmpdir-inherited: sessions get the caller's TMPDIR",
    file: "bin/omt", suite: PROFILE,
    patches: [['TMPDIR="$OMT_DIR/tmp" OMT_HOME=', 'TMPDIR="$TMPDIR" OMT_HOME=']],
    mustFail: [T7], mustPass: [T7MD],
  },
  // ── T8: writes across the lifecycle ──
  {
    name: "profile-merges-user-mcp: start writes ~/.mcp.json",
    file: P, suite: PROFILE,
    patches: [["        write_session_mcp hub || return 3\n", "        write_session_mcp hub || return 3\n        echo '{}' > \"$HOME/.mcp.json\"\n"]],
    mustFail: [T8], mustPass: [T6],
  },
  {
    name: "stop-deletes-home-omt-env: stop removes ~/.omt-env",
    file: P, suite: PROFILE,
    patches: [['    profile_guard_dirs || return 3\n    echo -e "${YELLOW}Stopping all sessions', '    profile_guard_dirs || return 3\n    rm -f "$HOME/.omt-env"\n    echo -e "${YELLOW}Stopping all sessions']],
    mustFail: [T8], mustPass: [T6],
  },
  {
    name: "profile-writes-project-env: add writes .omt-env into the project",
    file: P, suite: PROFILE,
    patches: [['    write_session_mcp "$NAME" || return 3\n', '    write_session_mcp "$NAME" || return 3\n    echo x > "$PROJECT_DIR/.omt-env"\n']],
    mustFail: [T8], mustPass: [T6],
  },
  {
    name: "profile-rewrites-settings: start rewrites the checkout's settings.json",
    file: P, suite: PROFILE,
    patches: [['    ensure_profile_dirs || return 3\n    trust_check "$HUB_CWD" || return 4', '    ensure_profile_dirs || return 3\n    echo \'{"agent":"x"}\' > "$PLUGIN_DIR/settings.json"\n    trust_check "$HUB_CWD" || return 4']],
    mustFail: [T8], mustPass: [T6],
  },
  {
    name: "profile-opens-browser: start opens the dashboard",
    file: P, suite: PROFILE,
    patches: [['    echo ""\n\n    profile_hub_restore\n}', '    echo ""\n    open_browser "http://localhost:$ROUTER_PORT/dashboard"\n\n    profile_hub_restore\n}']],
    mustFail: [T8], mustPass: [T6],
  },
  {
    name: "restore-writes-project-mcp: restore writes .mcp.json into the project",
    file: P, suite: PROFILE,
    patches: [['        PORT=$(alloc_port) || continue\n        write_session_mcp "$name"', '        PORT=$(alloc_port) || continue\n        echo \'{}\' > "$proj_path/.mcp.json"\n        write_session_mcp "$name"']],
    mustFail: [T8], mustPass: [T6],
  },
  {
    name: "restore-writes-project-env: restore writes .omt-env into the project",
    file: P, suite: PROFILE,
    patches: [['        PORT=$(alloc_port) || continue\n        write_session_mcp "$name"', '        PORT=$(alloc_port) || continue\n        echo x > "$proj_path/.omt-env"\n        write_session_mcp "$name"']],
    mustFail: [T8], mustPass: [T6],
  },
  {
    name: "restore-launch-default-string: restore launches with the default-hub command",
    file: P, suite: PROFILE,
    patches: [['            "$(session_cmd "$name" "$proj_path" "$PORT" sisyphus --continue)"', `            "cd '$proj_path' && BRIDGE_PORT=$PORT ROUTER_URL=http://localhost:$ROUTER_PORT SESSION_NAME=$name OMT_PLUGIN_DIR='$PLUGIN_DIR' claude --plugin-dir '$PLUGIN_DIR' --agent sisyphus --dangerously-skip-permissions --dangerously-load-development-channels server:omt-bridge --continue"`]],
    mustFail: [T8], mustPass: [T6],
  },
  // ── T9: trust ──
  {
    name: "no-trust-check: an untrusted project starts anyway",
    file: P, suite: PROFILE,
    patches: [['    trust_check "$PROJECT_DIR" || return 4', "    true"]],
    mustFail: [T9], mustPass: [T6],
  },
  // ── T10: hook ──
  {
    name: "hook-file-first: the cwd .omt-env overrides the session env",
    file: "hooks/status-hook.sh", suite: PROFILE,
    patches: [['[ -z "$ROUTER_URL" ] && [ -z "$OMT_HOME" ] && [ -n "$CWD" ] && [ -f "$CWD/.omt-env" ] && source "$CWD/.omt-env"', '[ -n "$CWD" ] && [ -f "$CWD/.omt-env" ] && source "$CWD/.omt-env"']],
    mustFail: [T10], mustPass: [T12],
  },
  // ── T11: view ──
  {
    name: "view-links-mcp: the plugin view carries .mcp.json",
    file: P, suite: PROFILE,
    patches: [["    for e in agents hooks skills .claude-plugin settings.json CLAUDE.md channel bin; do", "    for e in agents hooks skills .claude-plugin settings.json CLAUDE.md channel bin .mcp.json; do"]],
    mustFail: [T11], mustPass: [T6],
  },
  // ── WO-022: hooks/ and .claude-plugin/ are copies; the staleness warning ──
  {
    name: "view-links-hooks: hooks/ is a link again",
    file: P, suite: PROFILE,
    patches: [["            hooks|.claude-plugin) cp -R", "            .claude-plugin) cp -R"]],
    mustFail: [T11], mustPass: [T6],
  },
  {
    name: "view-links-claude-plugin: .claude-plugin/ is a link again",
    file: P, suite: PROFILE,
    patches: [["            hooks|.claude-plugin) cp -R", "            hooks) cp -R"]],
    mustFail: [T11], mustPass: [T6],
  },
  {
    name: "view-keeps-stale: the view is not emptied before a rebuild",
    file: P, suite: PROFILE,
    patches: [['    rm -rf "$PLUGIN_ARG"\n    mkdir -p "$PLUGIN_ARG"\n', '    mkdir -p "$PLUGIN_ARG"\n']],
    mustFail: [T11], mustPass: [T6],
  },
  {
    name: "no-stale-warning: a drifted view is not reported",
    file: P, suite: PROFILE,
    patches: [["        echo -e \"${YELLOW}The plugin view's hooks differ from the checkout's.", "        : echo -e \"${YELLOW}The plugin view's hooks differ from the checkout's."]],
    mustFail: [T18], mustPass: [T11],
  },
  {
    name: "stale-warning-ignores-link: a view that still links hooks/ is not reported",
    file: P, suite: PROFILE,
    patches: [['    if [ -L "$PLUGIN_ARG/hooks" ] \\\n        || ! diff -rq', '    if ! diff -rq']],
    mustFail: [T18], mustPass: [T11],
  },
  {
    name: "add-skips-stale-check: hub add never checks the view",
    file: P, suite: PROFILE,
    patches: [["    if [ -d \"$PLUGIN_ARG\" ] && [ -x \"$OMT_CLI\" ]; then\n        warn_stale_view\n", "    if [ -d \"$PLUGIN_ARG\" ] && [ -x \"$OMT_CLI\" ]; then\n        :\n"]],
    mustFail: [T18], mustPass: [T11],
  },
  {
    name: "stale-warning-ignores-plugin-json: a drifted manifest is not reported",
    file: P, suite: PROFILE,
    patches: [[" \\\n        || ! cmp -s \"$PLUGIN_DIR/.claude-plugin/plugin.json\" \"$PLUGIN_ARG/.claude-plugin/plugin.json\"; then", "; then"]],
    mustFail: [T18], mustPass: [T11],
  },
  {
    name: "ensure-skips-stale-check: interactive mode never checks the view",
    file: P, suite: PROFILE,
    patches: [["        build_plugin_view || return 3\n    else\n        warn_stale_view\n", "        build_plugin_view || return 3\n    else\n        :\n"]],
    mustFail: [T18], mustPass: [T11],
  },
  // ── T12: interactive ──
  {
    name: "interactive-no-nostatus: interactive mode posts status",
    file: P, suite: PROFILE,
    patches: [['    inner="OMT_NO_STATUS=1 claude --plugin-dir', '    inner="claude --plugin-dir']],
    mustFail: [T12], mustPass: [T10],
  },
  // ── T13: allocation ──
  {
    name: "alloc-no-inuse: allocation hands out a port another process holds",
    file: P, suite: PROFILE,
    patches: [['        if [ "$port" = "$ROUTER_PORT" ] || [ "$port" = "$HUB_BRIDGE_PORT" ] || port_listening "$port"; then', '        if [ "$port" = "$ROUTER_PORT" ] || [ "$port" = "$HUB_BRIDGE_PORT" ]; then']],
    mustFail: [T13], mustPass: [T6],
  },
  // ── T14: seams ──
  {
    name: "seams-ungated: test seams work without the sandbox gate",
    file: P, suite: PROFILE,
    patches: [['    if [ -z "$_SEAM_ROOT" ]; then\n        echo "omt: ignoring $name (test seam without an OMT_TEST_SANDBOX gate)" >&2\n        return 1\n    fi\n', ""]],
    mustFail: [T14], mustPass: [T2],
  },
  // ── T17: found in V0 ──
  {
    name: "init-flag-on-failure: a hub that never came up is marked initialized",
    file: P, suite: PROFILE,
    patches: [
      ['                touch "$OMT_DIR/.hub-initialized"\n            else\n', "            else\n"],
      ['            fi\n        fi\n    fi\n\n    echo ""\n', '            fi\n        fi\n    fi\n    touch "$OMT_DIR/.hub-initialized"\n\n    echo ""\n'],
    ],
    mustFail: [T17], mustPass: [T6],
  },
  // ── T16: router.ts ──
  {
    name: "router-guard-ungated: the router guard runs without OMT_PROFILE",
    file: "channel/router.ts", suite: GUARD,
    patches: [['if (process.env.OMT_PROFILE === "1") {', "if (true) {"]],
    mustFail: [G_UNGATED], mustPass: [G_PORTS],
  },
  {
    name: "no-router-token-guard: the router allows the fleet's app token",
    file: "channel/router.ts", suite: GUARD,
    patches: [["    if (a && a === credential(fleet, k)) return `this hub uses the default hub's ${k}`;\n", ""]],
    mustFail: [G_TOKEN], mustPass: [G_CHAT],
  },
  {
    name: "no-router-chatid: the router allows the fleet's chat",
    file: "channel/router.ts", suite: GUARD,
    patches: [["    if (c && fleetChats.has(c)) return", "    if (false) return"]],
    mustFail: [G_CHAT], mustPass: [G_PORTS],
  },
  {
    name: "router-guard-after-adapter: the guard runs after the adapter loads",
    file: "channel/router.ts", suite: GUARD,
    patches: [[GUARD_BLOCK, ""], [ADAPTER_LINE, ADAPTER_LINE + GUARD_BLOCK]],
    mustFail: [G_DIR], mustPass: [G_UNGATED],
  },
  // ── added after the review gate ──
  {
    name: "init-skips-port-check: hub remove/status/list reach a band port",
    file: P, suite: PROFILE,
    patches: [["    profile_guard_ports || exit 3\n    return 0\n}", "    return 0\n}"]],
    mustFail: [T4EVERY], mustPass: [T4PORTS],
  },
  {
    name: "init-skips-dir-check: status/attach create dirs inside the fleet dir",
    file: P, suite: PROFILE,
    patches: [["    profile_check_dirs || exit 3\n    profile_guard_ports || exit 3\n", "    profile_guard_ports || exit 3\n"]],
    mustFail: [T4EVERY], mustPass: [T4DIRS],
  },
  {
    name: "shim-no-home: the profile's omt shim runs the default hub",
    file: P, suite: PROFILE,
    patches: [
      ['OMT_HOME=%q exec %q "$@"', 'exec %q "$@"'],
      ['"$OMT_DIR" "$PLUGIN_DIR/bin/omt" > "$OMT_CLI.$$"', '"$PLUGIN_DIR/bin/omt" > "$OMT_CLI.$$"'],
    ],
    mustFail: [T2SHIM], mustPass: [T2],
  },
  {
    name: "relative-home-kept: a relative OMT_HOME stays relative",
    file: P, suite: PROFILE,
    patches: [['    case "$OMT_HOME" in /*) ;; *) OMT_HOME="$PWD/$OMT_HOME" ;; esac\n', ""]],
    mustFail: [T2REL], mustPass: [T2],
  },
  {
    name: "creds-fail-open: an unreadable default hub config passes the guard",
    file: P, suite: PROFILE,
    patches: [['        print(f"the {who} hub-config.json cannot be read, so credentials cannot be compared")\n        sys.exit(3)\n', "        return {}\n"]],
    mustFail: [T4UNREAD], mustPass: [T4CREDS],
  },
  {
    name: "hook-fallback-in-profile: a profile session sources the cwd .omt-env",
    file: "hooks/status-hook.sh", suite: PROFILE,
    patches: [['[ -z "$ROUTER_URL" ] && [ -z "$OMT_HOME" ] && ', '[ -z "$ROUTER_URL" ] && ']],
    mustFail: [T10], mustPass: [T12],
  },
  {
    name: "no-foreign-bridge-check: a port taken after allocation gets registered",
    file: P, suite: PROFILE,
    patches: [['    PORT=$(alloc_port) || return 3\n    if port_listening "$PORT"; then\n        _gfail "port $PORT answers before the session exists (a foreign bridge)"; return 3\n    fi\n', "    PORT=$(alloc_port) || return 3\n"]],
    mustFail: [T13B], mustPass: [T13],
  },
  {
    name: "init-flag-on-reg-failure: a hub the router never registered is marked initialized",
    file: P, suite: PROFILE,
    patches: [["            if [ $registered = 1 ]; then\n", "            if true; then\n"]],
    mustFail: [T17B], mustPass: [T17],
  },
  {
    name: "no-name-check: names and paths go into pane commands unchecked",
    file: P, suite: PROFILE,
    patches: [
      ['valid_name() { [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]]; }', "valid_name() { true; }"],
      ["safe_path() { case \"$1\" in *\"'\"*|*$'\\n'*) return 1 ;; esac; return 0; }", "safe_path() { true; }"],
    ],
    mustFail: [T9], mustPass: [T6],
  },
  {
    name: "seam-gate-no-owner-check: a sandbox others can write into opens the seams",
    file: P, suite: PROFILE,
    patches: [['                if [ -d "$r" ]', '                if true; then _SEAM_ROOT="$r"; elif [ -d "$r" ]']],
    mustFail: [T14], mustPass: [T2],
  },
  {
    name: "profile-dir-world-readable: the profile dir keeps the umask's mode",
    file: P, suite: PROFILE,
    patches: [["    chmod 700 \"$OMT_DIR\" || { _gfail \"can't restrict $OMT_DIR to its owner\"; return 3; }\n", ""]],
    mustFail: [T8], mustPass: [T6],
  },
  {
    name: "router-creds-fail-open: the router passes an unreadable default hub config",
    file: "channel/router.ts", suite: GUARD,
    patches: [["      return \"the default hub's hub-config.json can't be read, so its credentials can't be compared\";\n", "      fleet = {};\n"]],
    mustFail: [G_UNREAD], mustPass: [G_TOKEN],
  },
  {
    name: "router-no-contains-check: the router allows a hub dir containing the fleet's",
    file: "channel/router.ts", suite: GUARD,
    patches: [['  if (fleetDir.startsWith(dir + "/")) return "the hub dir contains the default hub\'s dir";\n', ""]],
    mustFail: [G_CONTAINS], mustPass: [G_DIR],
  },
  // ── promoted from the QA reviewer's probes ──
  {
    name: "default-hint-changed: a default-mode hint names another CLI",
    file: "bin/omt", suite: PROFILE,
    patches: [['OMT_CMD="omt"   #', 'OMT_CMD="omtx"   #']],
    mustFail: [T1CMDS], mustPass: [T2],
  },
  {
    name: "no-fleet-contains-check: a profile dir containing the fleet dir is allowed",
    file: P, suite: PROFILE,
    patches: [["        if _inside \"$FLEET_DIR\" \"$OMT_DIR\"; then\n            _gfail \"the profile dir contains the default hub's dir ($FLEET_DIR)\"; return 3\n        fi\n", ""]],
    mustFail: [T4DIRS], mustPass: [T4PORTS],
  },
  {
    name: "no-inuse-guard: hub start runs on ports another process holds",
    file: P, suite: PROFILE,
    patches: [["    profile_guard_inuse || return 3\n", ""]],
    mustFail: [T4INUSE], mustPass: [T4PORTS],
  },
  {
    name: "hub-untrusted-starts: the hub starts in a dir Claude hasn't trusted",
    file: P, suite: PROFILE,
    patches: [['    trust_check "$HUB_CWD" || return 4\n', ""]],
    mustFail: [T9HUB], mustPass: [T2],
  },
  {
    name: "router-seam-ungated: the router honours OMT_FLEET_DIR under any gate",
    file: "channel/router.ts", suite: GUARD,
    patches: [["    if (inTemp && ownedPrivateDir(root) && (p === root", "    if ((p === root"]],
    mustFail: [G_SEAM], mustPass: [G_DIR],
  },
  {
    name: "router-seam-no-owner-check: the router honours a gate others can write into",
    file: "channel/router.ts", suite: GUARD,
    patches: [["inTemp && ownedPrivateDir(root) && ", "inTemp && "]],
    mustFail: [G_SEAM], mustPass: [G_DIR],
  },
  // ── from the wave-2 challenger ──
  {
    name: "octal-port-accepted: a leading-zero port is parsed and breaks the checks",
    file: P, suite: PROFILE,
    patches: [['if [[ "$v" =~ ^[1-9][0-9]{0,4}$ ]]; then', 'if [[ "$v" =~ ^[0-9]{1,5}$ ]]; then']],
    mustFail: [T4OCTAL], mustPass: [T4PORTS],
  },
  {
    name: "lsof-missing-fails-open: without lsof every port looks free",
    file: P, suite: PROFILE,
    patches: [["need_lsof() { command -v lsof >/dev/null 2>&1 || { _gfail \"lsof not found, so ports in use can't be checked\"; return 3; }; }", "need_lsof() { return 0; }"]],
    mustFail: [T4LSOF], mustPass: [T4PORTS],
  },
];

// ── Runner ────────────────────────────────────────────────────────────────

const COPY = ["bin", "agents", "hooks", "skills", ".claude-plugin", "settings.json", "CLAUDE.md", ".mcp.json", "test", "channel"];

function count(h: string, n: string): number {
  let c = 0;
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) c++;
  return c;
}

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let copyN = 0;
function freshCopy(): string {
  const dir = path.join(ROOT, `copy-${++copyN}`);
  mkdirSync(dir);
  for (const e of COPY) {
    const src = path.join(REPO, e);
    if (!existsSync(src)) continue;
    cpSync(src, path.join(dir, e), {
      recursive: true,
      filter: (s) => !/[\\/]node_modules([\\/]|$)/.test(s) && !/[\\/]dashboard[\\/]dist([\\/]|$)/.test(s),
    });
  }
  symlinkSync(path.join(REPO, "channel", "node_modules"), path.join(dir, "channel", "node_modules"));
  return dir;
}

interface Result {
  passed: string[];
  failed: string[];
  skipped: string[];
  output: string;
}

function run(m: { file?: string; suite: string; patches: [string, string][]; only?: string[] }): Result {
  const dir = freshCopy();
  if (m.file) {
    const target = path.join(dir, m.file);
    let src = readFileSync(target, "utf-8");
    for (const [find, replace] of m.patches) {
      const n = count(src, find);
      if (n !== 1) throw new Error(`HARNESS BROKEN: patch on ${m.file} matched ${n} times: ${JSON.stringify(find.slice(0, 80))}`);
      src = src.replace(find, replace);
    }
    writeFileSync(target, src);
  }
  const report = path.join(dir, "junit.xml");
  const inChannel = m.suite.startsWith("channel/");
  const cwd = inChannel ? path.join(dir, "channel") : dir;
  const suite = inChannel ? m.suite.slice("channel/".length) : m.suite;
  const args = [process.execPath, "test", `./${suite}`, "--reporter=junit", `--reporter-outfile=${report}`];
  if (m.only) args.push("-t", m.only.map(escapeRe).join("|"));
  const proc = Bun.spawnSync(args, {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TMPDIR: "/tmp", OMT_T1_OLD_OMT: OLD_OMT },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = proc.stdout.toString() + proc.stderr.toString();
  if (!existsSync(report)) throw new Error(`HARNESS BROKEN: no JUnit report for ${m.suite}\n${output.slice(-2000)}`);
  const xml = readFileSync(report, "utf-8");
  const r: Result = { passed: [], failed: [], skipped: [], output };
  for (const x of xml.matchAll(/<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const title = unescapeXml(x[1]);
    const body = x[2] ?? "";
    if (body.includes("<failure") || body.includes("<error")) r.failed.push(title);
    else if (body.includes("<skipped")) r.skipped.push(title);
    else r.passed.push(title);
  }
  rmSync(dir, { recursive: true, force: true });
  return r;
}

describe("profile-mode removal control", () => {
  const baseline = new Map<string, Result>();

  for (const suite of [PROFILE, GUARD]) {
    test(`baseline: the unmutated copy of ${suite} passes (else HARNESS BROKEN)`, () => {
      const r = run({ suite, patches: [] });
      baseline.set(suite, r);
      expect({ suite, failed: r.failed, skipped: r.skipped }).toEqual({ suite, failed: [], skipped: [] });
      expect(r.passed.length).toBeGreaterThan(0);
    });
  }

  test("every title named by a mutant exists in its suite (else HARNESS BROKEN)", () => {
    for (const m of MUTANTS) {
      const b = baseline.get(m.suite);
      expect(b).toBeDefined();
      for (const t of [...m.mustFail, ...m.mustPass]) expect({ mutant: m.name, title: t, known: b!.passed.includes(t) }).toEqual({ mutant: m.name, title: t, known: true });
    }
  });

  for (const m of MUTANTS) {
    test(`mutant caught: ${m.name}`, () => {
      const r = run({ file: m.file, suite: m.suite, patches: m.patches, only: [...m.mustFail, ...m.mustPass] });
      for (const t of m.mustFail) expect({ mutant: m.name, test: t, failed: r.failed.includes(t) }).toEqual({ mutant: m.name, test: t, failed: true });
      for (const t of m.mustPass) expect({ mutant: m.name, test: t, passed: r.passed.includes(t) }).toEqual({ mutant: m.name, test: t, passed: true });
    });
  }
});

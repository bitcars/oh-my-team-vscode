/**
 * Fail-safe harness for every test that runs bin/omt (WO-021 plan v2 §6).
 *
 * A test that spawns bin/omt must go through runOmt() here. The harness
 * makes the live fleet (default tmux server, router on :8800, ~/.oh-my-team)
 * unreachable EVEN IF the code under test misbehaves:
 *
 * - The spawned env is built from an allowlist, never from process.env, so
 *   TMUX, ROUTER_PORT, ROUTER_URL, BRIDGE_PORT, OMT_HUB_DIR, SESSION_NAME and
 *   CLAUDE_* from a fleet pane never reach bin/omt.
 * - HOME is a sandbox, and the sandbox lives under /tmp (the seam gate in
 *   bin/omt only honours seams inside such a dir).
 * - PATH starts with shims. In "guard" mode the tmux shim runs real tmux only
 *   for `-L omtv-test-*` (or from inside a pane of such a server) and
 *   otherwise exits 99. The curl shim refuses localhost:8800-8899 and every
 *   non-localhost URL with exit 7. In "record" mode (the T1 differential)
 *   tmux, curl, bun and sleep never run for real: they log argv and fake a
 *   reply.
 * - Nothing here ever runs the real `claude`: the claude shim dumps its env
 *   and argv, runs the status hook once, then starts the real bridge.ts,
 *   but only if its ROUTER_URL and BRIDGE_PORT are set and outside
 *   8800-8899.
 *
 * Limit: the shims see only processes that look tools up on PATH. bun's own
 * fetch and serve (the router, bridge.ts, the tests' listeners) bypass them.
 * Those are covered by the guards under test, the claude-shim check above,
 * and the router's own startup guard, not by the shims.
 *
 * Cleanup kills only the sandbox's own tmux socket (in the default socket
 * dir and in the sandbox's TMUX_TMPDIR), removes its socket file, and
 * refuses a name that is empty, "default", or not omtv-test-*.
 */

import { spawnSync } from "bun";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CHECKOUT = path.resolve(import.meta.dir, "..");
export const OMT = path.join(CHECKOUT, "bin", "omt");

export type ShimMode = "guard" | "record";

export interface Sandbox {
  root: string;
  home: string;
  omtHome: string;
  fleet: string;
  shim: string;
  log: string;
  tmp: string;
  socket: string;
  mode: ShimMode;
  claudeJson: string;
  tmuxConf: string;
}

function which(bin: string): string {
  const r = spawnSync(["/usr/bin/which", bin], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const p = r.stdout.toString().trim();
  if (r.exitCode !== 0 || !p) throw new Error(`harness: ${bin} not found on PATH`);
  return p;
}

const REAL = {
  tmux: which("tmux"),
  curl: which("curl"),
  bun: which("bun"),
  python3: which("python3"),
};

/** Directories the bin/omt seam gate accepts as a sandbox parent. */
const TMP_ROOT = realpathSync("/tmp");

function writeExec(file: string, body: string) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function writeShims(sb: Sandbox) {
  const L = sb.log;
  // tmux
  if (sb.mode === "guard") {
    writeExec(
      path.join(sb.shim, "tmux"),
      `#!/bin/bash
printf '%q ' "$@" >> ${sh(L)}/tmux.log; echo >> ${sh(L)}/tmux.log
ok=0; prev=""; other=0
for a in "$@"; do
  name=""
  if [ "$prev" = "-L" ]; then name="$a"; fi
  case "$a" in -L?*) name="\${a#-L}" ;; -S*) other=1 ;; esac
  if [ -n "$name" ]; then case "$name" in omtv-test-*) ok=1 ;; *) other=1 ;; esac; fi
  prev="$a"
done
# Inside a pane of a test server (router-side bare tmux) $TMUX names its socket.
if [ $ok = 0 ] && [ -n "$TMUX" ]; then
  sockbase="$(basename "\${TMUX%%,*}")"
  case "$sockbase" in omtv-test-*) ok=1 ;; esac
fi
# Any other -L name, or a -S socket path (which can point anywhere, even at
# the default server), is refused, inside a test pane too.
[ $other = 1 ] && ok=0
if [ $ok = 1 ]; then exec ${sh(REAL.tmux)} "$@"; fi
echo "REFUSED tmux $*" >> ${sh(L)}/tmux.log
echo "REFUSED tmux $*" >> ${sh(L)}/refused.log
exit 99
`
    );
  } else {
    writeExec(
      path.join(sb.shim, "tmux"),
      `#!/bin/bash
printf '%q ' "$@" >> ${sh(L)}/tmux.log; echo >> ${sh(L)}/tmux.log
for a in "$@"; do
  case "$a" in has-session) exit 1 ;; list-sessions) exit 0 ;; esac
done
exit 0
`
    );
  }

  // curl
  if (sb.mode === "guard") {
    writeExec(
      path.join(sb.shim, "curl"),
      `#!/bin/bash
printf '%q ' "$@" >> ${sh(L)}/curl.log; echo >> ${sh(L)}/curl.log
refuse() { echo "REFUSED curl $1" >> ${sh(L)}/refused.log; exit 7; }
# Every argument that looks like a URL or a host:port, in any case or form
# (LOCALHOST:8800, 0:8800, 127.1:8800, http://localhost:08800): only
# localhost and 127.0.0.1 pass, and never a port in 8800-8899.
for a in "$@"; do
  low="$(printf '%s' "$a" | tr '[:upper:]' '[:lower:]')"
  if [[ "$low" == *://* ]]; then hp="\${low#*://}"
  elif [[ "$low" =~ ^[a-z0-9.-]+:[0-9]+(/|$) ]] || [[ "$low" == localhost* ]]; then hp="$low"
  else continue
  fi
  hp="\${hp%%/*}"; hp="\${hp%%\\?*}"; hp="\${hp##*@}"
  host="\${hp%%:*}"; port=""
  [[ "$hp" == *:* ]] && port="\${hp##*:}"
  if [ "$host" != "localhost" ] && [ "$host" != "127.0.0.1" ]; then refuse "$a"; fi
  if [[ "$port" =~ ^[0-9]+$ ]] && [ $((10#$port)) -ge 8800 ] && [ $((10#$port)) -le 8899 ]; then refuse "$a"; fi
done
exec ${sh(REAL.curl)} "$@"
`
    );
  } else {
    writeExec(
      path.join(sb.shim, "curl"),
      `#!/bin/bash
printf '%q ' "$@" >> ${sh(L)}/curl.log; echo >> ${sh(L)}/curl.log
url=""; method="GET"; prev=""
for a in "$@"; do
  case "$a" in http://*|https://*) url="$a" ;; esac
  [ "$prev" = "-X" ] && method="$a"
  prev="$a"
done
case "$url" in
  */getMe) echo '{"ok":true,"result":{"username":"recordbot"}}' ;;
  */getChat*) echo '{"ok":true,"result":{"title":"Record Group"}}' ;;
  */getUpdates*) echo '{"ok":true,"result":[]}' ;;
  */health) echo '{"status":"ok","platform":"telegram","sessions":0}' ;;
  */sessions)
    # A test can make every registration fail.
    if [ "$method" = "POST" ] && [ -f ${sh(sb.root)}/curl-fail-register ]; then echo '{"error":"refused by the test"}'
    elif [ "$method" = "POST" ]; then echo '{"name":"x","threadId":"t"}'; else echo '{}'; fi ;;
  */sessions/*) [ "$method" = "DELETE" ] || echo '{}' ;;
  *) echo '{}' ;;
esac
exit 0
`
    );
  }

  // bun and sleep never run for real in record mode (no installs, no waits).
  if (sb.mode === "record") {
    writeExec(path.join(sb.shim, "bun"), `#!/bin/bash\nprintf '%q ' "$@" >> ${sh(L)}/bun.log; echo >> ${sh(L)}/bun.log\nexit 0\n`);
    writeExec(path.join(sb.shim, "sleep"), `#!/bin/bash\nexit 0\n`);
  }

  // A bare `omt` from a test process would be the default hub's CLI: refuse it.
  writeExec(path.join(sb.shim, "omt"), `#!/bin/bash\nprintf '%q ' "$@" >> ${sh(L)}/omt.log; echo >> ${sh(L)}/omt.log\necho "REFUSED omt $*" >> ${sh(L)}/refused.log\nexit 98\n`);

  for (const b of ["open", "xdg-open", "node"]) {
    writeExec(path.join(sb.shim, b), `#!/bin/bash\nprintf '%q ' "$@" >> ${sh(L)}/${b}.log; echo >> ${sh(L)}/${b}.log\nexit 0\n`);
  }

  // claude: never the real one.
  writeExec(
    path.join(sb.shim, "claude"),
    `#!/bin/bash
out=${sh(sb.root)}/claude-\${SESSION_NAME:-none}.txt
# A test can make this claude die at once (like a real claude refusing to start).
[ -f ${sh(sb.root)}/claude-fail ] && exit 1
{ echo "ARGV $*"; env | sort; echo "OMT_ON_PATH $(command -v omt)"; } > "$out"
plugin=""; prev=""
for a in "$@"; do [ "$prev" = "--plugin-dir" ] && plugin="$a"; prev="$a"; done
if [ -n "$plugin" ] && [ -f "$plugin/hooks/status-hook.sh" ]; then
  printf '{"cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' "$PWD" \\
    | bash "$plugin/hooks/status-hook.sh" >/dev/null 2>&1
fi
# bridge.ts talks to the router with bun's own fetch, which the curl shim
# can't see, and falls back to the default hub's ports when ROUTER_URL or
# BRIDGE_PORT is unset. So check both here, before it starts.
for v in "$ROUTER_URL" "http://localhost:$BRIDGE_PORT"; do
  p="\${v##*:}"; p="\${p%%/*}"
  case "$p" in *[!0-9]*|"") p=0 ;; esac
  if [ -z "$ROUTER_URL" ] || [ -z "$BRIDGE_PORT" ] || { [ $((10#$p)) -ge 8800 ] && [ $((10#$p)) -le 8899 ]; }; then
    echo "REFUSED bridge ROUTER_URL=$ROUTER_URL BRIDGE_PORT=$BRIDGE_PORT" >> ${sh(L)}/refused.log
    exit 1
  fi
done
exec ${sh(REAL.bun)} run "$OMT_PLUGIN_DIR/channel/bridge.ts"
`
  );
}

export function makeSandbox(opts: { mode?: ShimMode; fleetAgents?: boolean; fleetConfig?: Record<string, unknown> } = {}): Sandbox {
  const root = mkdtempSync(path.join(TMP_ROOT, "omt-wo021-"));
  const id = path.basename(root).replace(/^omt-wo021-/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const sb: Sandbox = {
    root,
    home: path.join(root, "home"),
    omtHome: path.join(root, "home", ".omtv"),
    fleet: path.join(root, "home", ".oh-my-team"),
    shim: path.join(root, "shim"),
    log: path.join(root, "log"),
    tmp: path.join(root, "tmp"),
    socket: `omtv-test-${id}`,
    mode: opts.mode ?? "guard",
    claudeJson: path.join(root, "claude.json"),
    tmuxConf: path.join(root, "tmux.conf"),
  };
  for (const d of [sb.home, sb.fleet, sb.shim, sb.log, sb.tmp, path.join(root, "tmux")]) mkdirSync(d, { recursive: true });
  if (opts.fleetAgents) mkdirSync(path.join(sb.fleet, "agents"), { recursive: true });
  writeFileSync(
    path.join(sb.fleet, "hub-config.json"),
    JSON.stringify(opts.fleetConfig ?? { platform: "telegram", credentials: { botToken: "111111:FLEET-AAAA", chatId: "-1001" } })
  );
  writeFileSync(sb.tmuxConf, "");
  copyFileSync(path.join(CHECKOUT, "channel", "dev", "stub-adapter-preload.ts"), path.join(root, "stub-adapter-preload.ts"));
  writeFileSync(sb.claudeJson, JSON.stringify({ projects: {} }));
  for (const f of ["tmux", "curl", "refused", "open", "xdg-open", "node", "bun", "omt"]) writeFileSync(path.join(sb.log, `${f}.log`), "");
  writeShims(sb);
  return sb;
}

/** Mark a path trusted in the sandbox's claude.json seam. */
export function trust(sb: Sandbox, p: string) {
  const j = JSON.parse(readFileSync(sb.claudeJson, "utf-8"));
  j.projects[p] = { hasTrustDialogAccepted: true };
  writeFileSync(sb.claudeJson, JSON.stringify(j));
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run bin/omt (or another script) inside the sandbox. profile=true (default)
 * points every seam into the sandbox. env is merged LAST, so a test can
 * deliberately inject fleet-looking values (T7) or drop the profile.
 */
export function runOmt(
  sb: Sandbox,
  args: string[],
  opts: { profile?: boolean; env?: Record<string, string | undefined>; script?: string; stdin?: string; timeoutMs?: number } = {}
): RunResult {
  const env = buildEnv(sb, opts);
  const r = spawnSync(["/bin/bash", opts.script ?? OMT, ...args], {
    env,
    cwd: sb.root,
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
    timeout: opts.timeoutMs ?? 60_000,
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function buildEnv(sb: Sandbox, opts: { profile?: boolean; env?: Record<string, string | undefined> }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${sb.shim}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: sb.home,
    USER: process.env.USER ?? "user",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "user",
    SHELL: "/bin/bash",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: sb.tmp,
    TMUX_TMPDIR: path.join(sb.root, "tmux"),
    OMT_TEST_SANDBOX: sb.root,
    OMT_NO_BROWSER: "",
  };
  delete env.OMT_NO_BROWSER;
  if (opts.profile !== false) {
    Object.assign(env, {
      OMT_HOME: sb.omtHome,
      OMT_TMUX_SOCKET: sb.socket,
      OMT_FLEET_DIR: sb.fleet,
      OMT_CLAUDE_JSON: sb.claudeJson,
      OMT_TMUX_CONF: sb.tmuxConf,
      OMT_ROUTER_PRELOAD: path.join(sb.root, "stub-adapter-preload.ts"),
    });
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** runOmt without blocking the event loop (for tests that serve HTTP in-process). */
export async function runOmtAsync(
  sb: Sandbox,
  args: string[],
  opts: { profile?: boolean; env?: Record<string, string | undefined>; script?: string; stdin?: string; timeoutMs?: number } = {}
): Promise<RunResult> {
  const env = buildEnv(sb, opts);
  const proc = Bun.spawn(["/bin/bash", opts.script ?? OMT, ...args], {
    env,
    cwd: sb.root,
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 60_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export function logLines(sb: Sandbox, name: string): string[] {
  const f = path.join(sb.log, `${name}.log`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8").split("\n").filter((l) => l.trim() !== "");
}

/** The tmux socket dir when TMUX_TMPDIR is unset (where the profile's `env -i` server lives). */
export function defaultTmuxSocketDir(): string {
  return path.join("/tmp", `tmux-${process.getuid!()}`);
}

/**
 * Kill the sandbox's tmux server (only an omtv-test-* socket), remove its
 * socket file, then delete the sandbox.
 *
 * The profile's `env -i` drops TMUX_TMPDIR, so its server normally lives in
 * the default socket dir. A build that skips `env -i` (the wrapper-no-env-i
 * mutant) inherits the sandbox's TMUX_TMPDIR instead, so try both dirs, or
 * that server outlives the run with its socket deleted. tmux 3.7 also leaves
 * the socket file behind after kill-server, so remove it by hand.
 */
export function cleanup(sb: Sandbox) {
  const s = sb.socket;
  if (s && s !== "default" && s.startsWith("omtv-test-")) {
    const base = { PATH: "/usr/bin:/bin" };
    for (const env of [base, { ...base, TMUX_TMPDIR: path.join(sb.root, "tmux") }]) {
      spawnSync([REAL.tmux, "-L", s, "kill-server"], { stdout: "ignore", stderr: "ignore", env });
    }
    rmSync(path.join(defaultTmuxSocketDir(), s), { force: true });
  }
  rmSync(sb.root, { recursive: true, force: true });
}

/** A free TCP port (not in 8800-8899). */
export function freePort(): number {
  for (;;) {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const p = probe.port!;
    probe.stop(true);
    if (p < 8800 || p > 8899) return p;
  }
}

/** Three distinct free ports written to the profile's profile.env. */
export function writeProfilePorts(sb: Sandbox): { router: number; hub: number; base: number } {
  const router = freePort();
  let hub = freePort();
  while (hub === router) hub = freePort();
  let base = freePort();
  while (base === router || base === hub || base > 65000) base = freePort();
  mkdirSync(sb.omtHome, { recursive: true });
  writeFileSync(
    path.join(sb.omtHome, "profile.env"),
    `ROUTER_PORT=${router}\nHUB_BRIDGE_PORT=${hub}\nBRIDGE_PORT_BASE=${base}\n`
  );
  return { router, hub, base };
}

export { REAL };

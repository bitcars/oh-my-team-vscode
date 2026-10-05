/**
 * Profile mode for bin/omt (WO-021, plan v2 §7, T1-T15).
 *
 * Every spawn goes through test/omt-harness.ts: sandbox HOME under /tmp,
 * allowlisted env, and shims that refuse the default tmux server, :8800-8899
 * and any non-localhost URL. No test runs the real claude or reaches
 * Telegram. test/omt-profile.control.test.ts re-runs these tests against
 * mutated copies and names them by title: keep titles unique and stable.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(240_000);
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import {
  CHECKOUT,
  cleanup,
  freePort,
  logLines,
  makeSandbox,
  REAL,
  runOmt,
  runOmtAsync,
  trust,
  writeProfilePorts,
  type Sandbox,
} from "./omt-harness";

const boxes: Sandbox[] = [];
afterAll(() => boxes.forEach(cleanup));
function box(opts: Parameters<typeof makeSandbox>[0] = {}): Sandbox {
  const sb = makeSandbox(opts);
  boxes.push(sb);
  return sb;
}

const FLEET_TOKEN = "111111:FLEET-AAAA";
const FLEET_APP = "xapp-FLEET";
const FLEET_CHAT = "-1001";
const FLEET_CONFIG = { platform: "telegram", credentials: { botToken: FLEET_TOKEN, appToken: FLEET_APP, chatId: FLEET_CHAT } };

function envOf(out: string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1);
  }
  return m;
}

function sha(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Recursive path → sha256 (or "dir"/"link") under root, minus excluded top-level names. */
function manifest(root: string, exclude: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const relName = rel ? `${rel}/${name}` : name;
      if (!rel && exclude.includes(name)) continue;
      const full = path.join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[relName] = "link";
      else if (st.isDirectory()) {
        out[relName] = "dir";
        walk(full, relName);
      } else out[relName] = sha(full);
    }
  };
  walk(root, "");
  return out;
}

/**
 * The whole checkout, which profile mode must never write into. Skips
 * node_modules at any depth, git's own dir, and the local session dirs a
 * running Claude may write while the tests run.
 */
function checkoutManifest(): Record<string, string> {
  const skip = new Set(["node_modules", ".git", ".claude", ".sisyphus"]);
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (skip.has(name)) continue;
      const relName = rel ? `${rel}/${name}` : name;
      const full = path.join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[relName] = "link";
      else if (st.isDirectory()) {
        out[relName] = "dir";
        walk(full, relName);
      } else out[relName] = sha(full);
    }
  };
  walk(CHECKOUT, "");
  return out;
}

function writeProfileConfig(sb: Sandbox, creds: Record<string, string> = { botToken: "222222:OMTV-BBBB", chatId: "-2002" }) {
  mkdirSync(sb.omtHome, { recursive: true });
  writeFileSync(path.join(sb.omtHome, "hub-config.json"), JSON.stringify({ platform: "telegram", credentials: creds }));
}

/** A sandbox with a configured, trusted profile and a started hub. */
function startedHub(opts: { env?: Record<string, string | undefined> } = {}) {
  const sb = box({ mode: "guard", fleetAgents: true, fleetConfig: FLEET_CONFIG });
  const ports = writeProfilePorts(sb);
  writeProfileConfig(sb);
  trust(sb, path.join(sb.omtHome, "hub"));
  const start = runOmt(sb, ["hub", "start"], { env: opts.env, timeoutMs: 120_000 });
  return { sb, ports, start };
}

function project(sb: Sandbox, name: string, trusted = true): string {
  const p = path.join(sb.root, name);
  mkdirSync(p, { recursive: true });
  if (trusted) trust(sb, p);
  return p;
}

async function health(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function registry(sb: Sandbox): Record<string, { bridgePort: number; path: string }> {
  const f = path.join(sb.omtHome, "hub-registry.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf-8")).sessions : {};
}

function testSocketHas(sb: Sandbox, name: string): boolean {
  const r = Bun.spawnSync([REAL.tmux, "-L", sb.socket, "has-session", "-t", `=${name}`], { env: { PATH: "/usr/bin:/bin" } });
  return r.exitCode === 0;
}

// ── T1: the default mode is unchanged (P0) ────────────────────────────────

describe("T1 default mode differential", () => {
  const OLD_REF = "c5ae60b";

  function oldOmt(): string {
    const fromEnv = process.env.OMT_T1_OLD_OMT;
    if (fromEnv && existsSync(fromEnv)) return readFileSync(fromEnv, "utf-8");
    const r = Bun.spawnSync(["git", "-C", CHECKOUT, "show", `${OLD_REF}:bin/omt`]);
    if (r.exitCode !== 0) throw new Error(`T1: can't read ${OLD_REF}:bin/omt (set OMT_T1_OLD_OMT)`);
    return r.stdout.toString();
  }

  function plugin(sb: Sandbox, version: "old" | "new"): string {
    const p = path.join(sb.root, "plugin");
    for (const d of ["bin", "agents", "channel/node_modules"]) mkdirSync(path.join(p, d), { recursive: true });
    writeFileSync(path.join(p, "settings.json"), "{}\n");
    if (version === "old") writeFileSync(path.join(p, "bin", "omt"), oldOmt());
    else {
      writeFileSync(path.join(p, "bin", "omt"), readFileSync(path.join(CHECKOUT, "bin", "omt")));
      writeFileSync(path.join(p, "bin", "omt-profile.sh"), readFileSync(path.join(CHECKOUT, "bin", "omt-profile.sh")));
    }
    return path.join(p, "bin", "omt");
  }

  function transcript(version: "old" | "new", fleetAgents: boolean): string {
    const sb = box({ mode: "record", fleetAgents });
    const script = plugin(sb, version);
    const proj = path.join(sb.root, "proj");
    mkdirSync(proj);
    const run = (args: string[], stdin?: string) => runOmt(sb, args, { profile: false, script, stdin });
    run(["hub", "init", "--telegram", "--token", "333333:REC", "--chat-id", "-3"]);
    run(["hub", "start"]);
    run(["hub", "add", proj]);
    run(["hub", "remove", "proj"]);
    run(["hub", "stop"]);
    writeFileSync(
      path.join(sb.fleet, "hub-registry.json"),
      JSON.stringify({ sessions: { hub: { name: "hub", path: sb.home }, proj: { name: "proj", path: proj } } })
    );
    run(["hub", "start"]);
    run(["hub", "stop", "--clean"]);
    const logs = ["tmux", "curl", "bun", "open", "node", "omt", "refused"].map((n) => `## ${n}\n${logLines(sb, n).join("\n")}`);
    const tree = Object.entries(manifest(sb.root, ["log", "shim"])).filter(([k]) => !k.startsWith("plugin/bin"));
    // contents, not hashes: files embed the sandbox path, which differs per run
    const contents = tree
      .filter(([, v]) => v !== "dir" && v !== "link")
      .map(([k]) => `${k}: ${readFileSync(path.join(sb.root, k), "utf-8")}`);
    return [...logs, "## files", ...tree.map(([k]) => k), "## contents", ...contents].join("\n").split(sb.root).join("<SB>");
  }

  /** The read-only and interactive commands, with their output (hints included). */
  function commandsTranscript(version: "old" | "new"): string {
    const sb = box({ mode: "record", fleetAgents: true });
    const script = plugin(sb, version);
    const outs: string[] = [];
    const cmds = [
      ["hub", "status"], ["hub", "list"], ["hub", "logs"], ["hub", "attach"], ["hub", "attach", "router"],
      ["hub", "attach", "x"], ["dashboard"], ["help"], [], ["-c"], ["-d"], ["hub", "bogus"], ["__env"],
    ];
    for (const args of cmds) {
      const r = runOmt(sb, args, { profile: false, script });
      outs.push(`$ ${args.join(" ")} -> ${r.code}\n${r.stdout}${r.stderr}`);
    }
    const logs = ["tmux", "curl", "bun", "open", "node", "omt", "refused"].map((n) => `## ${n}\n${logLines(sb, n).join("\n")}`);
    return [...outs, ...logs].join("\n").split(sb.root).join("<SB>").replace(/omt-\d+/g, "omt-PID");
  }

  test("T1 default-mode status, list, logs, attach, dashboard, help and interactive runs are unchanged", () => {
    const before = commandsTranscript("old");
    const after = commandsTranscript("new");
    expect(before).toContain("new-session -s omt-PID"); // presence: the interactive runs reached tmux
    expect(before).toContain("Interactive session:"); // and help printed
    expect(after).toBe(before);
  });

  for (const fleetAgents of [false, true]) {
    test(`T1 old and new bin/omt make identical calls and writes (fleet agents dir: ${fleetAgents})`, () => {
      const oldT = transcript("old", fleetAgents);
      const newT = transcript("new", fleetAgents);
      expect(newT.length).toBeGreaterThan(500); // presence: the flows really ran
      expect(oldT).toContain("new-session -d -s omt-router");
      expect(newT).toBe(oldT);
    });
  }
});

// ── T2: resolution ignores the inherited env ──────────────────────────────

describe("T2 profile resolution", () => {
  test("T2 profile values ignore an inherited fleet env and live under OMT_HOME", () => {
    const sb = box({ fleetAgents: true });
    const r = runOmt(sb, ["__env"], {
      env: { ROUTER_PORT: "8800", OMT_HUB_DIR: sb.fleet, BRIDGE_PORT: "8809", SESSION_NAME: "x", ROUTER_URL: "http://localhost:8800" },
    });
    expect(r.code).toBe(0);
    const e = envOf(r.stdout);
    expect(e.OMT_PROFILE).toBe("1");
    expect([e.ROUTER_PORT, e.HUB_BRIDGE_PORT, e.BRIDGE_PORT_BASE]).toEqual(["9800", "9801", "9802"]);
    expect(e.OMT_DIR).toBe(sb.omtHome);
    for (const k of ["CONFIG_PATH", "NEXT_BRIDGE_PORT_FILE", "PLUGIN_ARG", "OMT_CLI", "HUB_CWD"]) {
      expect(e[k].startsWith(sb.omtHome + "/")).toBe(true);
    }
    expect(e.PLUGIN_DIR).toBe(CHECKOUT);
    expect(e.CHANNEL_DIR).toBe(path.join(CHECKOUT, "channel"));
    expect(e.TMUX_SOCKET).toBe(sb.socket);
    expect(e.MCP_NAME).toBe("omtv-bridge");
  });

  test("T2 --profile NAME maps to $HOME/.NAME and rejects a bad name", () => {
    const sb = box();
    const r = runOmt(sb, ["--profile", "omtv", "__env"], { env: { OMT_HOME: undefined } });
    expect(envOf(r.stdout).OMT_DIR).toBe(path.join(sb.home, ".omtv"));
    const bad = runOmt(sb, ["--profile", "Bad Name", "__env"], { env: { OMT_HOME: undefined } });
    expect(bad.code).toBe(2);
  });

  test("T2 a relative OMT_HOME is made absolute against the cwd", () => {
    const sb = box();
    const r = runOmt(sb, ["__env"], { env: { OMT_HOME: "rel/.p" } });
    expect(r.code).toBe(0);
    const e = envOf(r.stdout);
    expect(e.OMT_DIR).toBe(path.join(sb.root, "rel", ".p"));
    expect(e.PLUGIN_ARG).toBe(path.join(sb.root, "rel", ".p", "plugin"));
  });

  test("T2 the profile's omt shim acts on its own profile when run from a plain shell", () => {
    const sb = box();
    trust(sb, sb.root);
    expect(runOmt(sb, ["__interactive-cmd"]).code).toBe(0); // writes the shim
    const shim = path.join(sb.omtHome, "bin", "omt");
    expect(existsSync(shim)).toBe(true);
    for (const home of [undefined, path.join(sb.home, ".other")]) {
      const r = runOmt(sb, ["__env"], { profile: false, script: shim, env: { OMT_HOME: home } });
      const e = envOf(r.stdout);
      expect({ home, code: r.code, profile: e.OMT_PROFILE, dir: e.OMT_DIR }).toEqual({ home, code: 0, profile: "1", dir: sb.omtHome });
    }
    expect(logLines(sb, "refused")).toEqual([]);
  });
});

// ── T3: no bare tmux (static) ─────────────────────────────────────────────

function bareTmux(src: string): string[] {
  const hits: string[] = [];
  let inWrapper = false;
  src.split("\n").forEach((raw, i) => {
    if (/^omt_tmux\(\)\s*\{/.test(raw)) {
      inWrapper = true;
      return;
    }
    if (inWrapper) {
      if (/^\}/.test(raw)) inWrapper = false;
      return;
    }
    if (/^\s*#/.test(raw)) return;
    const line = raw.replace(/command -v tmux/g, "");
    if (/(?<![A-Za-z0-9_])tmux(?![A-Za-z0-9_])/.test(line)) hits.push(`${i + 1}: ${raw.trim()}`);
  });
  return hits;
}

describe("T3 tmux lint", () => {
  const IDIOMS = [
    "x=`tmux ls`",
    'out=$("tmux" ls)',
    "\\tmux ls",
    "TMUX_BIN=tmux; $TMUX_BIN ls",
    "${T:-tmux} ls",
    'eval "tmux ls"',
    "bash -c 'tmux ls'",
    "exec tmux attach",
    "{ tmux ls; }",
    "T=tmux",
    "/opt/homebrew/bin/tmux ls",
    "python3 -c \"import subprocess; subprocess.run(['tmux','ls'])\"",
    "true;tmux ls",
    "echo | tmux ls",
    "(tmux ls)",
  ];
  test("T3 the lint flags all 15 ways to call tmux", () => {
    for (const idiom of IDIOMS) expect(bareTmux(`f() {\n  ${idiom}\n}\n`).length).toBe(1);
    expect(bareTmux("omt_tmux ls\n# tmux in a comment\ncommand -v tmux >/dev/null\n")).toEqual([]);
  });
  test("T3 bin/omt and bin/omt-profile.sh call tmux only through omt_tmux", () => {
    for (const f of ["bin/omt", "bin/omt-profile.sh"]) {
      expect(bareTmux(readFileSync(path.join(CHECKOUT, f), "utf-8"))).toEqual([]);
    }
  });
});

// ── T4: guard ±1 ──────────────────────────────────────────────────────────

describe("T4 profile guard", () => {
  function guard(sb: Sandbox, env: Record<string, string | undefined> = {}) {
    return runOmt(sb, ["__guard"], { env });
  }
  function ports(sb: Sandbox, router: number, hub: number, base: number) {
    mkdirSync(sb.omtHome, { recursive: true });
    writeFileSync(path.join(sb.omtHome, "profile.env"), `ROUTER_PORT=${router}\nHUB_BRIDGE_PORT=${hub}\nBRIDGE_PORT_BASE=${base}\n`);
  }

  test("T4 profile dirs: the fleet dir, inside it, $HOME or a link to it are refused; a sibling is allowed", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    const link = path.join(sb.root, "fleet-link");
    symlinkSync(sb.fleet, link);
    for (const home of [sb.fleet, path.join(sb.fleet, "sub"), sb.home, link, sb.fleet + "/", sb.fleet + "/./"]) {
      expect({ home, code: guard(sb, { OMT_HOME: home }).code }).toEqual({ home, code: 3 });
    }
    // a dir that contains the fleet dir (reached through a link with a valid socket name)
    const parent = path.join(sb.tmp, "fleet-parent");
    symlinkSync(sb.root, parent);
    const c = guard(sb, { OMT_HOME: parent });
    expect({ code: c.code, contains: c.stderr.includes("contains the default hub") }).toEqual({ code: 3, contains: true });
    const ok = guard(sb, { OMT_HOME: path.join(sb.home, ".oh-my-teamx") });
    expect(ok.stdout).toContain("guard-ok");
    // no fleet dir at all: allowed
    const absent = guard(sb, { OMT_HOME: path.join(sb.home, ".p"), OMT_FLEET_DIR: path.join(sb.root, "nofleet") });
    expect(absent.stdout).toContain("guard-ok");
  });

  test("T4 HOME override without the seam gate still guards the passwd home's fleet dir", () => {
    const sb = box();
    const r = runOmt(sb, ["__env"], { env: { OMT_TEST_SANDBOX: undefined } });
    expect(envOf(r.stdout).FLEET_DIR).toBe(path.join(userInfo().homedir, ".oh-my-team"));
  });

  test("T4 ports: 8800 and 8899 refused, 8799 and 8900 allowed, for each port", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    const rows: [number, number, number, number][] = [
      [8800, 9801, 9802, 3], [8899, 9801, 9802, 3], [8799, 9801, 9802, 0], [8900, 9801, 9802, 0],
      [9800, 8800, 9802, 3], [9800, 8899, 9802, 3], [9800, 8799, 9802, 0], [9800, 8900, 9802, 0],
      [9800, 9801, 8800, 3], [9800, 9801, 8899, 3], [9800, 9801, 8900, 0],
      [9800, 9801, 8701, 3], [9800, 9801, 8700, 0],
      [9800, 9800, 9802, 3], [9800, 9801, 9801, 3],
    ];
    for (const [router, hub, base, want] of rows) {
      ports(sb, router, hub, base);
      expect({ router, hub, base, code: guard(sb).code }).toEqual({ router, hub, base, code: want });
    }
  });

  test("T4 every profile command refuses a bad dir or port before any call or write", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    const cmds = [
      ["hub", "remove", "app"], ["hub", "list"], ["hub", "status"], ["hub", "logs"], ["hub", "attach"],
      ["hub", "stop", "--clean"], ["dashboard"], ["__mcp", "x"], ["__env"],
      ["hub", "init", "--telegram", "--token", "333333:OMTV", "--chat-id", "-3003"],
    ];
    const noCalls = (row: string) => {
      for (const log of ["curl", "tmux"]) expect({ row, log, lines: logLines(sb, log) }).toEqual({ row, log, lines: [] });
    };
    // a router port in the default hub's band (a typo in profile.env)
    ports(sb, 8800, 9801, 9802);
    for (const args of cmds) {
      const r = runOmt(sb, args);
      expect({ args, code: r.code }).toEqual({ args, code: 3 });
      noCalls(`port: ${args.join(" ")}`);
    }
    // a profile dir inside the default hub's: refused, and nothing is created there
    const inside = path.join(sb.fleet, "sub");
    for (const args of cmds) {
      const r = runOmt(sb, args, { env: { OMT_HOME: inside } });
      expect({ args, code: r.code, created: existsSync(inside) }).toEqual({ args, code: 3, created: false });
      noCalls(`dir: ${args.join(" ")}`);
    }
  });

  test("T4 ports in use: a foreign listener on the router or hub bridge port refuses hub start, no session", async () => {
    for (const which of ["router", "hub"] as const) {
      const sb = box({ fleetConfig: FLEET_CONFIG });
      const p = writeProfilePorts(sb);
      writeProfileConfig(sb);
      trust(sb, path.join(sb.omtHome, "hub"));
      const foreign = Bun.serve({ port: which === "router" ? p.router : p.hub, hostname: "127.0.0.1", fetch: () => Response.json({ status: "ok" }) });
      try {
        const r = await runOmtAsync(sb, ["hub", "start"], { timeoutMs: 60_000 });
        expect({ which, code: r.code, inUse: r.stderr.includes("in use by another process") }).toEqual({ which, code: 3, inUse: true });
        expect({ which, sessions: logLines(sb, "tmux").filter((l) => l.includes("new-session")) }).toEqual({ which, sessions: [] });
      } finally {
        foreign.stop(true);
      }
    }
  });

  test("T4 ports: a port written with a leading zero is refused, not read as octal", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    writeProfileConfig(sb);
    trust(sb, path.join(sb.omtHome, "hub"));
    for (const key of ["ROUTER_PORT", "HUB_BRIDGE_PORT", "BRIDGE_PORT_BASE"]) {
      const env: Record<string, string> = { ROUTER_PORT: "9800", HUB_BRIDGE_PORT: "9801", BRIDGE_PORT_BASE: "9802", [key]: "08790" };
      writeFileSync(path.join(sb.omtHome, "profile.env"), Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(""));
      const g = runOmt(sb, ["__guard"]);
      expect({ key, code: g.code, why: g.stderr.includes("is not a port number") }).toEqual({ key, code: 3, why: true });
      const s = runOmt(sb, ["hub", "start"], { timeoutMs: 60_000 });
      expect({ key, code: s.code }).toEqual({ key, code: 3 });
    }
    expect(logLines(sb, "tmux").filter((l) => l.includes("new-session"))).toEqual([]);
    expect(readdirSync(sb.root).filter((f) => f.startsWith("claude-"))).toEqual([]);
  });

  test("T4 without lsof, hub start refuses (exit 3) instead of treating every port as free", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    writeProfilePorts(sb);
    writeProfileConfig(sb);
    trust(sb, path.join(sb.omtHome, "hub"));
    const PATH = [sb.shim, path.dirname(REAL.bun), path.dirname(REAL.python3), "/usr/bin", "/bin"].join(":");
    expect(Bun.which("lsof", { PATH })).toBeNull(); // presence control: lsof really is gone
    const r = runOmt(sb, ["hub", "start"], { env: { PATH }, timeoutMs: 60_000 });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("lsof not found");
    expect(logLines(sb, "tmux").filter((l) => l.includes("new-session"))).toEqual([]);
  });

  test("T4 credentials: a default hub config that can't be read is refused; a missing one is allowed", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    writeProfileConfig(sb);
    writeFileSync(path.join(sb.fleet, "hub-config.json"), "{ not json");
    const r = runOmt(sb, ["__guard"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("cannot be read");
    rmSync(path.join(sb.fleet, "hub-config.json"));
    expect(runOmt(sb, ["__guard"]).stdout).toContain("guard-ok");
  });

  test("T4 credentials: same token, bot id, app token or chat refused; near misses allowed; never printed", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    const rows: [Record<string, string>, number][] = [
      [{ botToken: FLEET_TOKEN, chatId: "-2" }, 3],
      [{ botToken: ` ${FLEET_TOKEN} `, chatId: "-2" }, 3],
      [{ botToken: "111111:FLEET-AAAB", chatId: "-2" }, 3],
      [{ botToken: "111112:FLEET-AAAA", chatId: "-2" }, 0],
      [{ botToken: "xoxb-mine", appToken: FLEET_APP, chatId: "-2" }, 3],
      [{ botToken: "xoxb-mine", appToken: "xapp-FLEEU", chatId: "-2" }, 0],
      [{ botToken: "222222:B", chatId: FLEET_CHAT }, 3],
      [{ botToken: "222222:B", chatId: "-1002" }, 0],
    ];
    for (const [creds, want] of rows) {
      writeProfileConfig(sb, creds);
      const r = guard(sb);
      expect({ creds, code: r.code }).toEqual({ creds, code: want });
      for (const secret of [FLEET_TOKEN, FLEET_APP, "FLEET-AAAB"]) {
        expect((r.stdout + r.stderr).includes(secret)).toBe(false);
      }
    }
  });
});

// ── T5: init refuses before any network call ──────────────────────────────

describe("T5 hub init guard", () => {
  test("T5a flags: the fleet token is refused before getMe (0 curl calls)", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    const r = runOmt(sb, ["hub", "init", "--telegram", "--token", FLEET_TOKEN, "--chat-id", "-5"]);
    expect(r.code).toBe(3);
    expect(logLines(sb, "curl")).toEqual([]);
    expect(existsSync(path.join(sb.omtHome, "hub-config.json"))).toBe(false);
  });

  test("T5b no flags: the bash flow runs (0 node calls) and refuses the typed fleet token", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    const r = runOmt(sb, ["hub", "init"], { stdin: `1\n${FLEET_TOKEN}\n` });
    expect(r.code).toBe(3);
    expect(logLines(sb, "node")).toEqual([]);
    expect(logLines(sb, "curl")).toEqual([]);
  });

  test("T5c slack: the fleet app token is refused before apps.connections.open", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    const r = runOmt(sb, ["hub", "init", "--slack", "--token", "xoxb-mine", "--app-token", FLEET_APP, "--channel-id", "C1"], { stdin: "\n" });
    expect(r.code).toBe(3);
    expect(logLines(sb, "curl")).toEqual([]);
  });
});

// ── T6: per-session MCP file ──────────────────────────────────────────────

describe("T6 MCP composition", () => {
  test("T6 mcp-extra servers are added; any bridge named or pathed like the fleet's is dropped", () => {
    const sb = box();
    mkdirSync(sb.omtHome, { recursive: true });
    writeFileSync(
      path.join(sb.omtHome, "mcp-extra.json"),
      JSON.stringify({
        mcpServers: {
          librarian: { command: "librarian-mcp" },
          "omt-bridge": { command: "bun", args: ["run", "/elsewhere/bridge.ts"] },
          sneaky: { command: "bun", args: ["run", path.join(sb.fleet, "channel", "bridge.ts")] },
          sneaky2: { command: "bun", args: ["run", "/Users/someone/.oh-my-team/channel/bridge.ts"] },
        },
      })
    );
    const r = runOmt(sb, ["__mcp", "s1"]);
    expect(r.code).toBe(0);
    const file = path.join(sb.omtHome, "mcp", "s1.json");
    const servers = JSON.parse(readFileSync(file, "utf-8")).mcpServers;
    expect(Object.keys(servers)).toEqual(["omtv-bridge", "librarian"]);
    expect(servers["omtv-bridge"].args).toEqual(["run", path.join(CHECKOUT, "channel", "bridge.ts")]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

// ── T7: the session env (P3, P6) ──────────────────────────────────────────

const FLEET_SCRATCH = "/private/tmp";
const SEAM_KEYS = ["OMT_TEST_SANDBOX", "OMT_TMUX_SOCKET", "OMT_FLEET_DIR", "OMT_CLAUDE_JSON", "OMT_TMUX_CONF", "OMT_ROUTER_PRELOAD"];

describe("T7 session env", () => {
  test("T7 a session started from a polluted env sees only the profile's values", async () => {
    const { sb, ports, start } = startedHub({
      env: {
        CLAUDECODE: "1",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_MESSAGING_TOKEN: "t0ken",
        ROUTER_URL: "http://localhost:8800",
        TMPDIR: FLEET_SCRATCH,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4080",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      },
    });
    expect(start.code).toBe(0);
    expect(await health(ports.hub)).toBe(true);
    const dump = readFileSync(path.join(sb.root, "claude-hub.txt"), "utf-8");
    const e = envOf(dump);
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_TOKEN"]) expect(e[k]).toBeUndefined();
    expect(e.ROUTER_URL).toBe(`http://localhost:${ports.router}`);
    expect(e.TMPDIR).toBe(path.join(sb.omtHome, "tmp"));
    expect(e.OMT_CLI).toBe(path.join(sb.omtHome, "bin", "omt"));
    expect(e.OMT_HOME).toBe(sb.omtHome);
    expect(e.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4080");
    expect(e.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(e.PATH.startsWith(path.join(sb.omtHome, "bin") + ":")).toBe(true);
    expect(dump).toContain(`OMT_ON_PATH ${path.join(sb.omtHome, "bin", "omt")}`);
    for (const [k, v] of Object.entries(e)) {
      // PATH is the caller's (after the profile bin); seam keys exist only in tests
      if (k === "PATH" || SEAM_KEYS.includes(k)) continue;
      expect({ k, fleet: /:88\d\d|\/\.oh-my-team(\/|$)/.test(v) }).toEqual({ k, fleet: false });
    }
    // the bridge logs under the profile, never ~/.oh-my-team
    expect(existsSync(path.join(sb.omtHome, "bridge-hub.log"))).toBe(true);
    runOmt(sb, ["hub", "stop"]);
  });

  test("T7 agents/hub.md never tells the hub to run a bare `omt hub`", () => {
    const md = readFileSync(path.join(CHECKOUT, "agents", "hub.md"), "utf-8");
    expect(md.includes("omt hub")).toBe(false);
    expect(md).toContain('"${OMT_CLI:-omt}" hub add');
  });
});

// ── T8 + T9 + T11: lifecycle writes, restore, trust, plugin view ──────────

describe("T8 lifecycle", () => {
  test("T8 start, add, stop, restore, stop write nothing outside the profile", async () => {
    const sb = box({ mode: "guard", fleetAgents: true, fleetConfig: FLEET_CONFIG });
    const ports = writeProfilePorts(sb);
    writeProfileConfig(sb);
    trust(sb, path.join(sb.omtHome, "hub"));
    writeFileSync(path.join(sb.home, ".omt-env"), "ROUTER_URL=http://localhost:8800\nSESSION_NAME=hub\n");
    const proj = project(sb, "proj");
    const fleetBefore = manifest(sb.fleet);
    const homeBefore = manifest(sb.home, [".omtv", "Library"]);
    const checkoutBefore = checkoutManifest();
    const assertClean = (step: string) => {
      expect({ step, fleet: manifest(sb.fleet) }).toEqual({ step, fleet: fleetBefore });
      expect({ step, home: manifest(sb.home, [".omtv", "Library"]) }).toEqual({ step, home: homeBefore });
      expect({ step, proj: readdirSync(proj) }).toEqual({ step, proj: [] });
      expect({ step, checkout: checkoutManifest() }).toEqual({ step, checkout: checkoutBefore });
      expect({ step, open: logLines(sb, "open") }).toEqual({ step, open: [] });
      expect({ step, refused: logLines(sb, "refused") }).toEqual({ step, refused: [] });
    };

    expect(runOmt(sb, ["hub", "start"], { timeoutMs: 120_000 }).code).toBe(0);
    assertClean("start");
    expect(runOmt(sb, ["hub", "add", proj], { timeoutMs: 120_000 }).code).toBe(0);
    assertClean("add");
    const first = registry(sb).proj;
    expect(first.path).toBe(proj);
    expect(await health(first.bridgePort)).toBe(true);
    // presence control for the browser check: the explicit dashboard command opens exactly once
    runOmt(sb, ["dashboard"]);
    expect(logLines(sb, "open").length).toBe(1);
    writeFileSync(path.join(sb.log, "open.log"), "");

    expect(runOmt(sb, ["hub", "stop"]).code).toBe(0);
    assertClean("stop");
    expect(testSocketHas(sb, "omt-proj")).toBe(false);

    writeFileSync(path.join(sb.root, "claude-proj.txt"), "");
    expect(runOmt(sb, ["hub", "start"], { timeoutMs: 120_000 }).code).toBe(0);
    assertClean("restore");
    const restored = registry(sb).proj;
    expect(await health(restored.bridgePort)).toBe(true);
    const argv = readFileSync(path.join(sb.root, "claude-proj.txt"), "utf-8").split("\n")[0];
    expect(argv).toContain(`--strict-mcp-config --mcp-config ${path.join(sb.omtHome, "mcp", "proj.json")}`);
    expect(argv).toContain("--continue");

    expect(runOmt(sb, ["hub", "remove", "proj"]).code).toBe(0);
    assertClean("remove");
    expect(testSocketHas(sb, "omt-proj")).toBe(false);
    expect(existsSync(path.join(sb.omtHome, "mcp", "proj.json"))).toBe(false);

    expect(runOmt(sb, ["hub", "stop"]).code).toBe(0);
    assertClean("stop again");
    expect(await health(ports.router)).toBe(false);
    // the profile dir holds the bot token: owner only
    expect((statSync(sb.omtHome).mode & 0o077).toString(8)).toBe("0");
  });

  test("T9 an untrusted project is refused before any session starts; a trusted one starts", async () => {
    const { sb, start } = startedHub();
    expect(start.code).toBe(0);
    const untrusted = project(sb, "untrusted", false);
    const r = runOmt(sb, ["hub", "add", untrusted], { timeoutMs: 60_000 });
    expect(r.code).toBe(4);
    expect(logLines(sb, "tmux").some((l) => l.includes("omt-untrusted"))).toBe(false);
    trust(sb, untrusted);
    expect(runOmt(sb, ["hub", "add", untrusted], { timeoutMs: 120_000 }).code).toBe(0);
    expect(await health(registry(sb).untrusted.bridgePort)).toBe(true);
    // a dir name that would break out of the pane command's quotes is refused
    const quoted = project(sb, "it's");
    const q = runOmt(sb, ["hub", "add", quoted], { timeoutMs: 60_000 });
    expect(q.code).toBe(2);
    expect(logLines(sb, "tmux").some((l) => l.includes("omt-it"))).toBe(false);
    expect(runOmt(sb, ["hub", "remove", "../x"]).code).toBe(2);
    runOmt(sb, ["hub", "stop"]);
  });

  test("T9 an untrusted hub dir is refused (exit 4) before any session starts", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    writeProfilePorts(sb);
    writeProfileConfig(sb);
    const r = runOmt(sb, ["hub", "start"], { timeoutMs: 60_000 });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("hasn't trusted");
    expect(logLines(sb, "tmux").filter((l) => l.includes("new-session"))).toEqual([]);
  });

  test("T11 the plugin view copies hooks/ and .claude-plugin/, links the rest, has no .mcp.json, and replaces stale content", () => {
    const sb = box({ fleetConfig: FLEET_CONFIG });
    writeProfilePorts(sb);
    writeProfileConfig(sb);
    trust(sb, path.join(sb.omtHome, "hub"));
    mkdirSync(path.join(sb.omtHome, "plugin", "agents"), { recursive: true });
    writeFileSync(path.join(sb.omtHome, "plugin", "agents", "stale.md"), "x");
    writeFileSync(path.join(sb.omtHome, "plugin", ".mcp.json"), "{}");
    // a hooks/ copy from an older build: a stale mod and a file the checkout no longer has
    mkdirSync(path.join(sb.omtHome, "plugin", "hooks"), { recursive: true });
    writeFileSync(path.join(sb.omtHome, "plugin", "hooks", "ctx-mod.js"), "// stale");
    writeFileSync(path.join(sb.omtHome, "plugin", "hooks", "old-probe.js"), "// gone from the checkout");
    const r = runOmt(sb, ["hub", "start"], { timeoutMs: 120_000 });
    expect(r.code).toBe(0);
    const view = path.join(sb.omtHome, "plugin");
    expect(existsSync(path.join(view, ".mcp.json"))).toBe(false);
    expect(lstatSync(path.join(view, "agents")).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(view, "skills")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(view, "agents", "stale.md"))).toBe(false);
    expect(existsSync(path.join(view, ".claude-plugin", "plugin.json"))).toBe(true);
    // Claude Code refuses a hooks module that resolves outside the plugin dir, so these two are real copies
    for (const e of ["hooks", ".claude-plugin"]) {
      const st = lstatSync(path.join(view, e));
      expect([e, st.isDirectory(), st.isSymbolicLink()]).toEqual([e, true, false]);
    }
    expect(readFileSync(path.join(view, "hooks", "ctx-mod.js"), "utf-8")).toBe(readFileSync(path.join(CHECKOUT, "hooks", "ctx-mod.js"), "utf-8"));
    expect(readFileSync(path.join(view, "hooks", "hooks.json"), "utf-8")).toBe(readFileSync(path.join(CHECKOUT, "hooks", "hooks.json"), "utf-8"));
    expect(existsSync(path.join(view, "hooks", "old-probe.js"))).toBe(false);
    expect(existsSync(path.join(view, "hooks", "hooks"))).toBe(false);
    const argv = readFileSync(path.join(sb.root, "claude-hub.txt"), "utf-8").split("\n")[0];
    expect(argv).toContain(`--plugin-dir ${view}`);
    runOmt(sb, ["hub", "stop"]);
  });
});

/** Put the checkout's hooks/ back into a view, byte for byte. */
function copyHooks(view: string) {
  rmSync(path.join(view, "hooks"), { recursive: true, force: true });
  mkdirSync(path.join(view, "hooks"));
  for (const f of readdirSync(path.join(CHECKOUT, "hooks"))) {
    writeFileSync(path.join(view, "hooks", f), readFileSync(path.join(CHECKOUT, "hooks", f)));
  }
}

describe("T18 stale plugin view", () => {
  test("T18 hub add and interactive mode warn when the view's hooks or manifest differ from the checkout's, or hooks/ is still a link", () => {
    const { sb, start } = startedHub();
    expect(start.code).toBe(0);
    const view = path.join(sb.omtHome, "plugin");
    const WARN = "The plugin view's hooks differ from the checkout's";
    // presence control: a view that matches the checkout prints no warning
    const quiet = runOmt(sb, ["hub", "add", project(sb, "fresh")], { timeoutMs: 120_000 });
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).not.toContain(WARN);
    // a hooks file that drifted since the hub started
    writeFileSync(path.join(view, "hooks", "ctx-mod.js"), "// drifted");
    const drifted = runOmt(sb, ["hub", "add", project(sb, "drifted")], { timeoutMs: 120_000 });
    expect(drifted.code).toBe(0);
    expect(drifted.stderr).toContain(WARN);
    expect(readFileSync(path.join(view, "hooks", "ctx-mod.js"), "utf-8")).toBe("// drifted");
    // the same drift seen from the other caller, ensure_profile_dirs (interactive mode, hub running)
    trust(sb, sb.root);
    const interactive = runOmt(sb, ["__interactive-cmd"]);
    expect(interactive.code).toBe(0);
    expect(interactive.stderr).toContain(WARN);
    // hooks/ back in sync, but the manifest drifted
    copyHooks(view);
    writeFileSync(path.join(view, ".claude-plugin", "plugin.json"), "{}");
    const manifest = runOmt(sb, ["hub", "add", project(sb, "manifest")], { timeoutMs: 120_000 });
    expect(manifest.code).toBe(0);
    expect(manifest.stderr).toContain(WARN);
    // a view built before hooks/ was copied (a link to the checkout); everything else in sync,
    // so only the link itself can trigger the warning
    writeFileSync(path.join(view, ".claude-plugin", "plugin.json"), readFileSync(path.join(CHECKOUT, ".claude-plugin", "plugin.json")));
    rmSync(path.join(view, "hooks"), { recursive: true, force: true });
    symlinkSync(path.join(CHECKOUT, "hooks"), path.join(view, "hooks"));
    const linked = runOmt(sb, ["hub", "add", project(sb, "linked")], { timeoutMs: 120_000 });
    expect(linked.code).toBe(0);
    expect(linked.stderr).toContain(WARN);
    expect(lstatSync(path.join(view, "hooks")).isSymbolicLink()).toBe(true);
    runOmt(sb, ["hub", "stop"]);
  });
});

// ── T17: a hub that never came up is not resumed later (found in V0) ──────

describe("T17 failed hub start", () => {
  test("T17 a hub start whose bridge never comes up doesn't mark the hub initialized", () => {
    const sb = box({ mode: "guard", fleetConfig: FLEET_CONFIG });
    writeProfilePorts(sb);
    writeProfileConfig(sb);
    trust(sb, path.join(sb.omtHome, "hub"));
    writeFileSync(path.join(sb.root, "claude-fail"), "");
    runOmt(sb, ["hub", "start"], { timeoutMs: 180_000 });
    // a later start would add --continue to a hub with no conversation, and claude exits
    expect(existsSync(path.join(sb.omtHome, ".hub-initialized"))).toBe(false);
    runOmt(sb, ["hub", "stop"]);
  });

  test("T17 a hub whose bridge comes up but never registers isn't marked initialized", () => {
    // record mode: tmux and curl are fakes, the bridge "answers" at once
    const sb = box({ mode: "record", fleetConfig: FLEET_CONFIG });
    writeProfilePorts(sb);
    writeProfileConfig(sb);
    trust(sb, path.join(sb.omtHome, "hub"));
    writeFileSync(path.join(sb.root, "curl-fail-register"), "");
    const r = runOmt(sb, ["hub", "start"], { timeoutMs: 60_000 });
    expect(r.stderr).toContain("didn't register");
    expect(existsSync(path.join(sb.omtHome, ".hub-initialized"))).toBe(false);
    // presence control: the same start with registration working marks it
    rmSync(path.join(sb.root, "curl-fail-register"));
    runOmt(sb, ["hub", "start"], { timeoutMs: 60_000 });
    expect(existsSync(path.join(sb.omtHome, ".hub-initialized"))).toBe(true);
  });
});

// ── T10 + T12: the status hook ────────────────────────────────────────────

function listener() {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      hits.push(`${new URL(req.url).pathname} ${await req.text()}`);
      return Response.json({ ok: true });
    },
  });
  return { port: server.port!, hits, stop: () => server.stop(true) };
}

function runHook(sb: Sandbox, cwd: string, env: Record<string, string | undefined>) {
  const event = JSON.stringify({ cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  return runOmtAsync(sb, [], { profile: false, script: path.join(CHECKOUT, "hooks", "status-hook.sh"), stdin: event, env });
}

describe("T10 status hook", () => {
  test("T10 the session env wins over a cwd .omt-env; the file is the fallback", async () => {
    const sb = box();
    const envRouter = listener();
    const fileRouter = listener();
    try {
      const cwd = path.join(sb.root, "p");
      mkdirSync(cwd);
      writeFileSync(path.join(cwd, ".omt-env"), `ROUTER_URL=http://localhost:${fileRouter.port}\nSESSION_NAME=fromfile\n`);
      await runHook(sb, cwd, { ROUTER_URL: `http://localhost:${envRouter.port}`, SESSION_NAME: "fromenv" });
      expect(envRouter.hits.length).toBe(1);
      expect(envRouter.hits[0]).toContain('"sessionName":"fromenv"');
      expect(fileRouter.hits.length).toBe(0);
      // presence control: empty env → the file is used
      await runHook(sb, cwd, {});
      expect(fileRouter.hits.length).toBe(1);
      expect(fileRouter.hits[0]).toContain('"sessionName":"fromfile"');
      // a profile session (OMT_HOME set) never falls back to the cwd file
      await runHook(sb, cwd, { OMT_HOME: sb.omtHome });
      expect(fileRouter.hits.length).toBe(1);
      // default mode: env and file agree → the same single POST as before
      writeFileSync(path.join(cwd, ".omt-env"), `ROUTER_URL=http://localhost:${envRouter.port}\nSESSION_NAME=fromenv\n`);
      await runHook(sb, cwd, { ROUTER_URL: `http://localhost:${envRouter.port}`, SESSION_NAME: "fromenv" });
      expect(envRouter.hits.length).toBe(2);
      expect(envRouter.hits[1]).toBe(envRouter.hits[0]);
    } finally {
      envRouter.stop();
      fileRouter.stop();
    }
  });
});

describe("T12 interactive profile mode", () => {
  test("T12 interactive mode posts no status even with a fleet .omt-env in cwd, and uses the plugin view", async () => {
    const sb = box();
    const fleet = listener();
    try {
      const cwd = path.join(sb.root, "p");
      mkdirSync(cwd);
      writeFileSync(path.join(cwd, ".omt-env"), `ROUTER_URL=http://localhost:${fleet.port}\nSESSION_NAME=fleet\n`);
      trust(sb, sb.root);
      const r = runOmt(sb, ["__interactive-cmd"]);
      expect(r.code).toBe(0);
      const cmd = r.stdout.trim();
      expect(cmd.startsWith("OMT_NO_STATUS=1 ")).toBe(true);
      expect(cmd).toContain(`--plugin-dir '${path.join(sb.omtHome, "plugin")}'`);
      expect(cmd).not.toContain("server:");
      await runHook(sb, cwd, { OMT_NO_STATUS: "1" });
      expect(fleet.hits.length).toBe(0);
      // -d is expanded as in default mode; the ended session's MCP file is
      // dropped once it is over a minute old
      for (const f of readdirSync(path.join(sb.omtHome, "mcp")).filter((n) => n.startsWith("interactive-"))) {
        const old = new Date(Date.now() - 120_000);
        utimesSync(path.join(sb.omtHome, "mcp", f), old, old);
      }
      const d = runOmt(sb, ["__interactive-cmd", "-d"]);
      expect(d.code).toBe(0);
      expect(d.stdout).toContain(" --dangerously-skip-permissions");
      expect(d.stdout).not.toMatch(/ -d( |$)/m);
      const left = readdirSync(path.join(sb.omtHome, "mcp")).filter((f) => f.startsWith("interactive-"));
      expect(left.length).toBe(1);
    } finally {
      fleet.stop();
    }
  });
});

// ── T13: allocation ───────────────────────────────────────────────────────

describe("T13 bridge allocation", () => {
  test("T13 a bridge port held by another process is skipped, never registered", async () => {
    const { sb, start } = startedHub();
    expect(start.code).toBe(0);
    const next = Number(readFileSync(path.join(sb.omtHome, ".next-bridge-port"), "utf-8").trim());
    const foreign = Bun.serve({ port: next, hostname: "127.0.0.1", fetch: () => Response.json({ status: "ok" }) });
    try {
      const proj = project(sb, "proj2");
      const r = runOmt(sb, ["hub", "add", proj], { timeoutMs: 120_000 });
      expect(r.code).toBe(0);
      const got = registry(sb).proj2.bridgePort;
      expect(got).not.toBe(next);
      expect(got).toBe(next + 1);
      expect(await health(got)).toBe(true);
    } finally {
      foreign.stop(true);
      runOmt(sb, ["hub", "stop"]);
    }
  });
});

describe("T13 foreign bridge", () => {
  test("T13 a foreign bridge that takes the chosen port before the session is refused (exit 3), never registered", async () => {
    const { sb, start } = startedHub();
    expect(start.code).toBe(0);
    const next = Number(readFileSync(path.join(sb.omtHome, ".next-bridge-port"), "utf-8").trim());
    // The race, made deterministic: lsof reports the port free once (to the
    // allocator), then tells the truth (to the check before the session).
    const hide = path.join(sb.root, "lsof-hide-once");
    writeFileSync(hide, String(next));
    const shim = path.join(sb.shim, "lsof");
    writeFileSync(
      shim,
      `#!/bin/bash
if [ -f '${hide}' ]; then
  for a in "$@"; do [ "$a" = "-iTCP:$(cat '${hide}')" ] && { rm -f '${hide}'; exit 1; }; done
fi
exec '${Bun.which("lsof")}' "$@"
`
    );
    chmodSync(shim, 0o755);
    const foreign = Bun.serve({ port: next, hostname: "127.0.0.1", fetch: () => Response.json({ status: "ok" }) });
    try {
      const proj = project(sb, "proj3");
      const r = await runOmtAsync(sb, ["hub", "add", proj], { timeoutMs: 120_000 });
      expect(existsSync(hide)).toBe(false); // the allocator really was told the port was free
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("foreign bridge");
      expect(registry(sb).proj3).toBeUndefined();
      expect(testSocketHas(sb, "omt-proj3")).toBe(false);
    } finally {
      foreign.stop(true);
      runOmt(sb, ["hub", "stop"]);
    }
  });
});

// ── T14: seams need the gate ──────────────────────────────────────────────

describe("T14 test seams", () => {
  test("T14 seams without the OMT_TEST_SANDBOX gate, or with a gate outside temp, are ignored", () => {
    const sb = box();
    const real = path.join(userInfo().homedir, ".oh-my-team");
    for (const gate of [undefined, userInfo().homedir]) {
      const r = runOmt(sb, ["__env"], { env: { OMT_TEST_SANDBOX: gate } });
      const e = envOf(r.stdout);
      expect(e.FLEET_DIR).toBe(real);
      expect(e.CLAUDE_JSON).toBe(path.join(sb.home, ".claude.json"));
      expect(e.TMUX_SOCKET).toBe("omtv");
      expect(r.stderr).toContain("ignoring");
    }
    // a gate dir that others can write into is ignored as well
    const loose = mkdtempSync(path.join(realpathSync("/tmp"), "omt-loose-"));
    try {
      chmodSync(loose, 0o777);
      const r = runOmt(sb, ["__env"], { env: { OMT_TEST_SANDBOX: loose, OMT_FLEET_DIR: path.join(loose, "f") } });
      expect(envOf(r.stdout).FLEET_DIR).toBe(real);
      expect(r.stderr).toContain("ignoring OMT_TEST_SANDBOX");
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
    // with the gate: the seams apply
    const gated = envOf(runOmt(sb, ["__env"]).stdout);
    expect(gated.FLEET_DIR).toBe(sb.fleet);
    expect(gated.TMUX_SOCKET).toBe(sb.socket);
  });
});

// ── T15: router-side tmux and restart stay on the profile ─────────────────

describe("T15 dashboard actions", () => {
  test("T15 dashboard stop and restart act on the profile's tmux server only", async () => {
    const { sb, ports, start } = startedHub();
    expect(start.code).toBe(0);
    const proj = project(sb, "dash");
    expect(runOmt(sb, ["hub", "add", proj], { timeoutMs: 120_000 }).code).toBe(0);
    expect(testSocketHas(sb, "omt-dash")).toBe(true);
    const origin = { Origin: `http://localhost:${ports.router}` };
    const stop = await fetch(`http://127.0.0.1:${ports.router}/api/sessions/dash/stop`, { method: "POST", headers: origin });
    expect(stop.status).toBe(200);
    expect(testSocketHas(sb, "omt-dash")).toBe(false);
    // Restart runs `$OMT_CLI hub add <path> --continue` from the router. That
    // CLI's first router call (the existing-session check) must hit the
    // PROFILE router. (Upstream's hub add then stops at "already exists", so
    // restart doesn't bring the session back; that is pre-existing, not ours.)
    const mark = logLines(sb, "curl").length;
    const restart = await fetch(`http://127.0.0.1:${ports.router}/api/sessions/dash/restart`, { method: "POST", headers: origin });
    expect(restart.status).toBe(200);
    const want = `http://localhost:${ports.router}/sessions/dash`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !logLines(sb, "curl").slice(mark).some((l) => l.includes(want))) await Bun.sleep(250);
    expect(logLines(sb, "curl").slice(mark).some((l) => l.includes(want))).toBe(true);
    expect(logLines(sb, "refused")).toEqual([]);
    expect(logLines(sb, "omt")).toEqual([]);
    runOmt(sb, ["hub", "stop"]);
  });
});

// ── T19: the hub's model (WO-025, fork #22) ───────────────────────────────
//
// The fake claude rewrites claude-<session>.txt only when it runs, so every
// launch a test asserts on is preceded by clearArgv and followed by launched(),
// which fails if the file wasn't rewritten.

const ABSENT = Symbol("absent");
const MODEL_FLAG = /(^|\s)--model(\s|=|$)/g;
const MODEL_REFUSED = "hubModel isn't a model id";
const INJECTION = "x'; touch PWNED; '";

/** A guard-mode sandbox with a trusted hub dir and a profile config holding hubModel (or none). */
function modelHub(hubModel: unknown): Sandbox {
  const sb = box({ mode: "guard", fleetAgents: true, fleetConfig: FLEET_CONFIG });
  writeProfilePorts(sb);
  writeProfileConfig(sb);
  setHubModel(sb, hubModel);
  mkdirSync(path.join(sb.omtHome, "hub"), { recursive: true });
  trust(sb, path.join(sb.omtHome, "hub"));
  return sb;
}

function setHubModel(sb: Sandbox, v: unknown) {
  const f = path.join(sb.omtHome, "hub-config.json");
  const j = JSON.parse(readFileSync(f, "utf-8"));
  if (v === ABSENT) delete j.hubModel;
  else j.hubModel = v;
  writeFileSync(f, JSON.stringify(j));
}

/** Set (string) or remove (undefined) registry `model`s. Only while the hub is stopped. */
function setRegistryModels(sb: Sandbox, models: Record<string, string | undefined>) {
  const f = path.join(sb.omtHome, "hub-registry.json");
  const j = JSON.parse(readFileSync(f, "utf-8"));
  for (const [name, m] of Object.entries(models)) {
    if (!j.sessions?.[name]) throw new Error(`registry has no entry '${name}' (did its start or add fail?)`);
    if (m === undefined) delete j.sessions[name].model;
    else j.sessions[name].model = m;
  }
  writeFileSync(f, JSON.stringify(j, null, 2));
}

function registryModels(sb: Sandbox): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, e] of Object.entries(registry(sb))) out[name] = (e as { model?: unknown }).model;
  return out;
}

function clearArgv(sb: Sandbox, ...sessions: string[]) {
  for (const s of sessions) writeFileSync(path.join(sb.root, `claude-${s}.txt`), "");
}

/** The argv line of a launch since clearArgv; fails unless it happened, with or without --continue. */
function launched(sb: Sandbox, session: string, cont: boolean): string {
  const f = path.join(sb.root, `claude-${session}.txt`);
  const argv = existsSync(f) ? readFileSync(f, "utf-8").split("\n")[0] : "";
  expect({ session, launched: argv.startsWith("ARGV ") }).toEqual({ session, launched: true });
  expect({ session, continue: / --continue( |$)/.test(argv) }).toEqual({ session, continue: cont });
  return argv;
}

/** model null: no --model in any form. Otherwise exactly one, followed by the value. */
function expectModel(step: string, argv: string, model: string | null) {
  const flags = (argv.match(MODEL_FLAG) ?? []).length;
  expect({ step, flags }).toEqual({ step, flags: model === null ? 0 : 1 });
  if (model !== null) expect({ step, has: argv.includes(` --model ${model} `) }).toEqual({ step, has: true });
}

/** The first start registered the hub, so the next start resumes it (--continue). */
function expectRegistered(sb: Sandbox, step: string) {
  expect({ step, initialized: existsSync(path.join(sb.omtHome, ".hub-initialized")) }).toEqual({ step, initialized: true });
}

function newSessions(sb: Sandbox): string[] {
  return logLines(sb, "tmux").filter((l) => / new-session /.test(l));
}

/** Every file named PWNED under root (symlinks not followed). */
function findPwned(root: string): string[] {
  const out: string[] = [];
  // Sessions may still be running: a file or dir that goes away mid-walk is skipped.
  const gone = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      if (gone(e)) return;
      throw e;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      if (name === "PWNED") out.push(full);
      let st;
      try {
        st = lstatSync(full);
      } catch (e) {
        if (gone(e)) continue;
        throw e;
      }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

describe("T19 hub model", () => {
  test("T19a hubModel launches the hub with --model on the first start and on --continue; project sessions get none, after add and after restore", () => {
    const sb = modelHub("fable");
    clearArgv(sb, "hub");
    expect(runOmt(sb, ["hub", "start"], { timeoutMs: 120_000 }).code).toBe(0);
    expectModel("hub start", launched(sb, "hub", false), "fable");
    expectRegistered(sb, "hub start");

    const proj = project(sb, "proj");
    clearArgv(sb, "proj");
    expect(runOmt(sb, ["hub", "add", proj], { timeoutMs: 120_000 }).code).toBe(0);
    expectModel("proj add", launched(sb, "proj", false), null);

    expect(runOmt(sb, ["hub", "stop"]).code).toBe(0);
    clearArgv(sb, "hub", "proj");
    expect(runOmt(sb, ["hub", "start"], { timeoutMs: 120_000 }).code).toBe(0);
    expectModel("hub restart", launched(sb, "hub", true), "fable");
    expectModel("proj restore", launched(sb, "proj", true), null);
    runOmt(sb, ["hub", "stop"]);
  }, 400_000);

  test("T19b without hubModel, or with it null or \"\", no session gets --model; the registry's hub model is ignored; user-level settings are never used or written", () => {
    const sb = modelHub(ABSENT);
    // Decoys: a model in the user's settings, in the profile's settings, and
    // (once the registry exists) on the registry's hub entry.
    const userSettings = path.join(sb.home, ".claude", "settings.json");
    mkdirSync(path.dirname(userSettings), { recursive: true });
    writeFileSync(userSettings, JSON.stringify({ model: "sonnet" }));
    writeFileSync(path.join(sb.omtHome, "settings.json"), JSON.stringify({ model: "haiku" }));
    const userSha = sha(userSettings);
    const homeBefore = manifest(sb.home, [".omtv", "Library"]);
    const untouched = (step: string) => {
      expect({ step, sha: sha(userSettings) }).toEqual({ step, sha: userSha });
      expect({ step, home: manifest(sb.home, [".omtv", "Library"]) }).toEqual({ step, home: homeBefore });
    };

    clearArgv(sb, "hub");
    expect(runOmt(sb, ["hub", "start"], { timeoutMs: 120_000 }).code).toBe(0);
    expectModel("first start, absent", launched(sb, "hub", false), null);
    expectRegistered(sb, "first start");
    untouched("first start");
    const proj = project(sb, "proj");
    clearArgv(sb, "proj");
    expect(runOmt(sb, ["hub", "add", proj], { timeoutMs: 120_000 }).code).toBe(0);
    expectModel("proj add", launched(sb, "proj", false), null);
    untouched("add");
    expect(runOmt(sb, ["hub", "stop"]).code).toBe(0);
    untouched("stop");

    setRegistryModels(sb, { hub: "claude-opus-5-5" });
    for (const [label, v] of [["absent", ABSENT], ["null", null], ["empty", ""]] as const) {
      setHubModel(sb, v);
      clearArgv(sb, "hub", "proj");
      expect({ label, code: runOmt(sb, ["hub", "start"], { timeoutMs: 120_000 }).code }).toEqual({ label, code: 0 });
      expectModel(`hub, hubModel ${label}`, launched(sb, "hub", true), null);
      expectModel(`proj restore, hubModel ${label}`, launched(sb, "proj", true), null);
      untouched(`start, hubModel ${label}`);
      expect(runOmt(sb, ["hub", "stop"]).code).toBe(0);
      untouched(`stop, hubModel ${label}`);
    }
    // presence: the registry decoy was there for every cycle
    expect(registryModels(sb).hub).toBe("claude-opus-5-5");
  }, 600_000);

  test("T19c start and restore pass each model verbatim and quoted; a model-less row gets none; the hub ignores the registry", () => {
    const sb = modelHub("opus[1m]");
    // An unquoted opus[1m] would glob to this file in the hub's cwd.
    writeFileSync(path.join(sb.omtHome, "hub", "opus1"), "");
    expect(runOmt(sb, ["hub", "start"], { timeoutMs: 120_000 }).code).toBe(0);
    expectRegistered(sb, "first start");
    for (const name of ["proj", "proj3", "proj2"]) {
      expect(runOmt(sb, ["hub", "add", project(sb, name)], { timeoutMs: 120_000 }).code).toBe(0);
    }
    expect(runOmt(sb, ["hub", "stop"]).code).toBe(0);
    setRegistryModels(sb, { hub: "claude-haiku-x", proj: "claude-opus-5-5", proj3: undefined, proj2: "claude-nope-9" });
    // proj3 (no model) comes right after proj (a model), so a carried-over model would show
    expect(Object.keys(registry(sb))).toEqual(["hub", "proj", "proj3", "proj2"]);

    const want = { hub: "opus[1m]", proj: "claude-opus-5-5", proj3: null, proj2: "claude-nope-9" };
    for (const round of ["restore", "second restore"]) {
      clearArgv(sb, ...Object.keys(want));
      expect({ round, code: runOmt(sb, ["hub", "start"], { timeoutMs: 180_000 }).code }).toEqual({ round, code: 0 });
      for (const [name, model] of Object.entries(want)) expectModel(`${round}: ${name}`, launched(sb, name, true), model);
      expect(runOmt(sb, ["hub", "stop"]).code).toBe(0);
      expect({ round, models: registryModels(sb) }).toEqual({
        round,
        models: { hub: "claude-haiku-x", proj: "claude-opus-5-5", proj3: undefined, proj2: "claude-nope-9" },
      });
    }
  }, 600_000);

  test("T19d1 a hubModel outside the allowed set is refused before anything starts, without printing it", () => {
    const sb = modelHub(ABSENT);
    // value, then a part of it that must never be printed (null: nothing distinctive)
    const cases: [unknown, string | null][] = [
      [INJECTION, "touch PWNED"],
      ["a b", "a b"],
      ["$(touch PWNED)", "touch PWNED"],
      ["`touch PWNED`", "touch PWNED"],
      ["a".repeat(101), "a".repeat(20)],
      ["fable\n", "fable"],
      [5, null],
      [{}, null],
    ];
    for (const [v, secret] of cases) {
      const label = JSON.stringify(v);
      setHubModel(sb, v);
      writeFileSync(path.join(sb.log, "tmux.log"), "");
      const r = runOmt(sb, ["hub", "start"], { timeoutMs: 60_000 });
      expect({ label, code: r.code }).toEqual({ label, code: 3 });
      expect({ label, refused: r.stderr.includes(MODEL_REFUSED) }).toEqual({ label, refused: true });
      if (secret !== null) expect({ label, printed: (r.stdout + r.stderr).includes(secret) }).toEqual({ label, printed: false });
      expect({ label, started: newSessions(sb) }).toEqual({ label, started: [] });
    }
    expect(findPwned(sb.root)).toEqual([]);
    // presence control: in this same sandbox a valid hubModel starts both sessions
    setHubModel(sb, "fable");
    writeFileSync(path.join(sb.log, "tmux.log"), "");
    expect(runOmt(sb, ["hub", "start"], { timeoutMs: 120_000 }).code).toBe(0);
    const started = newSessions(sb);
    expect(started.some((l) => l.includes(" -s omt-router "))).toBe(true);
    expect(started.some((l) => l.includes(" -s omt-hub "))).toBe(true);
    runOmt(sb, ["hub", "stop"]);
  }, 400_000);

  test("T19d2 an injection in hubModel never runs", () => {
    const sb = modelHub(INJECTION);
    // claude exits at once, so anything pasted after it on the pane line would run
    writeFileSync(path.join(sb.root, "claude-fail"), "");
    writeFileSync(path.join(sb.log, "tmux.log"), "");
    const r = runOmt(sb, ["hub", "start"], { timeoutMs: 180_000 });
    expect({ pwned: findPwned(sb.root) }).toEqual({ pwned: [] });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(MODEL_REFUSED);
    expect(newSessions(sb)).toEqual([]);
    runOmt(sb, ["hub", "stop"]);
  }, 300_000);

  test("T19d3 a bad registry model skips only that session and never runs it", () => {
    const sb = modelHub(ABSENT);
    expect(runOmt(sb, ["hub", "start"], { timeoutMs: 120_000 }).code).toBe(0);
    expectRegistered(sb, "first start");
    for (const name of ["proj", "proj2"]) {
      expect(runOmt(sb, ["hub", "add", project(sb, name)], { timeoutMs: 120_000 }).code).toBe(0);
    }
    expect(runOmt(sb, ["hub", "stop"]).code).toBe(0);
    setRegistryModels(sb, { proj: INJECTION, proj2: "claude-opus-5-5" });
    writeFileSync(path.join(sb.root, "claude-fail-proj"), "");
    clearArgv(sb, "proj", "proj2");
    const r = runOmt(sb, ["hub", "start"], { timeoutMs: 180_000 });
    expect({ pwned: findPwned(sb.root) }).toEqual({ pwned: [] });
    expect(r.code).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("Skipping proj: its registry model isn't a model id");
    expect(out.includes("touch PWNED")).toBe(false);
    expect(testSocketHas(sb, "omt-proj")).toBe(false);
    expectModel("proj2 restore", launched(sb, "proj2", true), "claude-opus-5-5");
    runOmt(sb, ["hub", "stop"]);
  }, 400_000);

  test("T19d4 a hub-config.json that isn't a JSON object is refused before anything starts", () => {
    // record mode: tmux, curl and bun are fakes that log their calls
    const sb = box({ mode: "record", fleetConfig: FLEET_CONFIG });
    writeProfilePorts(sb);
    writeProfileConfig(sb);
    mkdirSync(path.join(sb.omtHome, "hub"), { recursive: true });
    trust(sb, path.join(sb.omtHome, "hub"));
    const cfg = path.join(sb.omtHome, "hub-config.json");
    const good = readFileSync(cfg, "utf-8");
    // The credential check reads a falsy config as {}, so only the model check stops these.
    for (const bad of ["null", "[]", "0"]) {
      writeFileSync(cfg, bad);
      writeFileSync(path.join(sb.log, "tmux.log"), "");
      const r = runOmt(sb, ["hub", "start"], { timeoutMs: 60_000 });
      expect({ bad, code: r.code }).toEqual({ bad, code: 3 });
      expect({ bad, refused: r.stderr.includes("can't be read as a JSON object") }).toEqual({ bad, refused: true });
      expect({ bad, started: newSessions(sb) }).toEqual({ bad, started: [] });
    }
    // presence control: the same sandbox with its object config starts both sessions
    writeFileSync(cfg, good);
    writeFileSync(path.join(sb.log, "tmux.log"), "");
    expect(runOmt(sb, ["hub", "start"], { timeoutMs: 60_000 }).code).toBe(0);
    const started = newSessions(sb);
    expect(started.some((l) => l.includes(" -s omt-router "))).toBe(true);
    expect(started.some((l) => l.includes(" -s omt-hub "))).toBe(true);
  });

  test("T19e the model check accepts exactly the router's CTX_MODEL_RE", () => {
    const src = readFileSync(path.join(CHECKOUT, "channel", "router.ts"), "utf-8");
    const m = src.match(/^const CTX_MODEL_RE = \/(.+)\/;$/m);
    if (!m) throw new Error("const CTX_MODEL_RE = /…/; not found in channel/router.ts");
    const re = new RegExp(m[1]);
    const inputs: string[] = [];
    for (let c = 1; c <= 0x7f; c++) inputs.push(`a${String.fromCharCode(c)}b`);
    inputs.push("é", "ß", "ｆ", "😀", "", "a", "a".repeat(99), "a".repeat(100), "a".repeat(101));
    inputs.push("opus[1m]", "us.anthropic.claude-x:0", "vertex@x", "gw/x", "[", "]", "-x");
    // /bin/bash explicitly (macOS 3.2, what bin/omt runs under), one argv per input.
    // Note: LC_ALL=C in valid_model doesn't change these results on macOS, so
    // this test does not pin it.
    const script = 'source "$0"; for v in "$@"; do if valid_model "$v"; then echo 1; else echo 0; fi; done';
    const r = Bun.spawnSync(["/bin/bash", "-c", script, path.join(CHECKOUT, "bin", "omt-profile.sh"), ...inputs], {
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    });
    expect(r.exitCode).toBe(0);
    const got = r.stdout.toString().trim().split("\n");
    expect(got.length).toBe(inputs.length);
    const mismatches = inputs.filter((v, i) => (got[i] === "1") !== re.test(v)).map((v) => JSON.stringify(v));
    expect(mismatches).toEqual([]);
    // presence: both answers occur
    expect(got.filter((g) => g === "1").length).toBeGreaterThan(0);
    expect(got.filter((g) => g === "0").length).toBeGreaterThan(0);
  });

  test("T19f-tg telegram hub init writes fable into a new or key-less config and keeps an existing hubModel, null included", () => {
    const sb = box({ mode: "record", fleetConfig: FLEET_CONFIG });
    const cfg = path.join(sb.omtHome, "hub-config.json");
    const creds = { botToken: "222222:OMTV-BBBB", chatId: "-2002" };
    const init = () => runOmt(sb, ["hub", "init", "--telegram", "--token", creds.botToken, "--chat-id", creds.chatId]).code;
    const read = () => JSON.parse(readFileSync(cfg, "utf-8"));

    expect(init()).toBe(0);
    expect(read()).toEqual({ platform: "telegram", credentials: creds, hubModel: "fable" });
    expect((statSync(cfg).mode & 0o777).toString(8)).toBe("600");

    writeFileSync(cfg, JSON.stringify({ platform: "telegram", credentials: creds }));
    expect(init()).toBe(0);
    expect({ step: "key-less", hubModel: read().hubModel }).toEqual({ step: "key-less", hubModel: "fable" });

    for (const kept of ["claude-opus-5-5", null]) {
      writeFileSync(cfg, JSON.stringify({ platform: "telegram", credentials: creds, hubModel: kept }));
      expect(init()).toBe(0);
      expect(read()).toEqual({ platform: "telegram", credentials: creds, hubModel: kept });
    }
  });

  test("T19f-slack slack hub init keeps an existing hubModel and writes fable into a new config", () => {
    const sb = box({ mode: "record", fleetConfig: FLEET_CONFIG });
    const cfg = path.join(sb.omtHome, "hub-config.json");
    const creds = { botToken: "xoxb-mine", appToken: "xapp-mine", channelId: "C1" };
    const init = () =>
      runOmt(sb, ["hub", "init", "--slack", "--token", creds.botToken, "--app-token", creds.appToken, "--channel-id", creds.channelId], { stdin: "\n" }).code;
    const read = () => JSON.parse(readFileSync(cfg, "utf-8"));

    expect(init()).toBe(0);
    expect(read()).toEqual({ platform: "slack", credentials: creds, hubModel: "fable" });

    writeFileSync(cfg, JSON.stringify({ platform: "slack", credentials: creds, hubModel: "x" }));
    expect(init()).toBe(0);
    expect(read()).toEqual({ platform: "slack", credentials: creds, hubModel: "x" });
  });
});

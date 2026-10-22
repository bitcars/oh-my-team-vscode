/**
 * Exact tmux session targets in bin/omt's default mode (WO-029, fork #10,
 * plan v2 §5.2).
 *
 * tmux reads `-t NAME` as an exact session name first and then as a prefix,
 * so with omt-app gone, `-t omt-app` acts on omt-app2. Every default-mode
 * target must be `=name` (session verbs) or `=name:` (send-keys).
 *
 * Every bin/omt run goes through test/omt-harness.ts with pinDefault: the
 * default mode's bare tmux lands on the sandbox's own -L server, never the
 * default one, and fleetAgents keeps PLUGIN_DIR in the sandbox. Test sessions
 * run `sleep 6029`, so a leftover is easy to find. The removal control
 * (tmux-exact.control.test.ts) names these tests by title: keep titles unique
 * and stable.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CHECKOUT, cleanup, freePort, logLines, makeSandbox, OMT, runOmtAsync, sandboxTmux, type RunResult, type Sandbox } from "./omt-harness";

setDefaultTimeout(60_000);

// ── S1: every -t target in bin/omt is exact (static) ──────────────────────

const SESSION_VERBS = new Set(["has-session", "kill-session", "attach-session", "switch-client", "rename-session"]);
const SESSION_TARGET = /^(?:"=[^=:"\s]+"|=[^=:"\s]+)$/;
const PANE_TARGET = /^(?:"=[^=:"\s]+:"|=[^=:"\s]+:)$/;

interface Call {
  line: number;
  verb: string;
  /** The call's text, up to the next tmux call on the same line. */
  segment: string;
  text: string;
}

/**
 * Every omt_tmux/tmux call, outside comments and outside the omt_tmux()
 * wrapper (the wrapper rule of T3's bareTmux). A `\`-continued line is one
 * line to the shell, so it is joined first and reported at its first line.
 * A line may hold more than one call.
 */
function tmuxCalls(src: string): Call[] {
  const out: Call[] = [];
  const lines = src.split("\n");
  let inWrapper = false;
  for (let i = 0; i < lines.length; i++) {
    const first = i;
    let raw = lines[i];
    if (/^omt_tmux\(\)\s*\{/.test(raw)) {
      inWrapper = true;
      continue;
    }
    if (inWrapper) {
      if (/^\}/.test(raw)) inWrapper = false;
      continue;
    }
    if (/^\s*#/.test(raw)) continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(raw) && i + 1 < lines.length) raw = `${raw.slice(0, -1)} ${lines[++i]}`;
    const calls = [...raw.matchAll(/(?<![A-Za-z0-9_-])(?:omt_)?tmux\s+(\S+)/g)];
    calls.forEach((call, k) => {
      const segment = raw.slice(call.index, k + 1 < calls.length ? calls[k + 1].index : raw.length);
      out.push({ line: first + 1, verb: call[1], segment, text: raw.trim() });
    });
  }
  return out;
}

/** A call's shell words, quotes kept, up to the first unquoted `;`, `|` or `&` (not a `>&` redirect). */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      word += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "\\" && i + 1 < segment.length) {
      word += c + segment[++i];
      inWord = true;
      continue;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    } else if (c === ";" || c === "|" || (c === "&" && !/[<>]$/.test(word))) break;
    word += c;
    inWord = true;
  }
  if (inWord) words.push(word);
  return words;
}

interface Target {
  call: Call;
  value: string;
  exact: boolean;
}

/**
 * S1's matcher: every -t of every call, the way getopt reads it: `-t X`,
 * `-tX`, `-t"X"`, and a cluster that reaches t (`-at X`, `-atX`). More than
 * one per call counts; a -t with no value is a target that isn't exact.
 */
function tmuxTargets(src: string): Target[] {
  return tmuxCalls(src).flatMap((call) => {
    const words = shellWords(call.segment).slice(2);
    const targets: Target[] = [];
    for (let k = 0; k < words.length; k++) {
      const flag = /^-[A-Za-z]*?t(.*)$/.exec(words[k]);
      if (!flag) continue;
      const value = flag[1] !== "" ? flag[1] : (words[++k] ?? "");
      targets.push({ call, value, exact: (SESSION_VERBS.has(call.verb) ? SESSION_TARGET : PANE_TARGET).test(value) });
    }
    return targets;
  });
}

const flagged = (ts: Target[]) => ts.filter((t) => !t.exact).map((t) => `${t.call.line}: ${t.call.text}`);

/** S1c's own matcher: profile mode's `-t "$(tgt …)"` and `-t "$(tgt_pane …)"`. */
function profileTargets(src: string): { call: Call; helper: string }[] {
  return tmuxCalls(src).flatMap((call) => [...call.segment.matchAll(/\s-t\s+"\$\((tgt|tgt_pane)\s/g)].map((t) => ({ call, helper: t[1] })));
}

describe("S1 static", () => {
  test("S1a bin/omt has exactly 27 tmux -t targets, each =name on a session verb or =name: on send-keys", () => {
    const ts = tmuxTargets(readFileSync(OMT, "utf-8"));
    expect({
      targets: ts.length,
      flagged: flagged(ts),
      sendKeys: ts.filter((t) => t.call.verb === "send-keys").length,
      session: ts.filter((t) => SESSION_VERBS.has(t.call.verb)).length,
    }).toEqual({ targets: 27, flagged: [], sendKeys: 11, session: 16 });
  });

  test("S1b the matcher flags every prefix, doubled, colon-less or misplaced-colon target and skips comments", () => {
    const second = 'omt_tmux has-session -t "=omt-hub" 2>/dev/null && omt_tmux kill-session -t "omt-hub"';
    const fixtures = [
      'omt_tmux has-session -t "omt-hub" 2>/dev/null',
      "omt_tmux send-keys -t omt-hub Enter 2>/dev/null",
      'omt_tmux send-keys -t "=omt-$NAME" Enter 2>/dev/null',
      'omt_tmux has-session -t "==omt-hub" 2>/dev/null',
      'omt_tmux has-session -t "=omt-hub:" 2>/dev/null',
      'omt_tmux capture-pane -p -t "=omt-hub"',
      'omt_tmux display-message -p -t "omt-hub"',
      second,
      'omt_tmux send-keys -t "omt-$NAME:" Enter 2>/dev/null',
      'omt_tmux kill-session -t "$s" 2>/dev/null',
    ];
    // Every way getopt reads a -t: each prefix spelling is flagged, its exact twin is not.
    const spellings = [
      ["omt_tmux has-session -tomt-hub 2>/dev/null", "omt_tmux has-session -t=omt-hub 2>/dev/null"],
      ['omt_tmux kill-session -t"omt-hub" 2>/dev/null', 'omt_tmux kill-session -t"=omt-hub" 2>/dev/null'],
      ["omt_tmux kill-session -at omt-hub 2>/dev/null", 'omt_tmux kill-session -at "=omt-hub" 2>/dev/null'],
      ["omt_tmux send-keys \\\n        -t omt-hub Enter 2>/dev/null", "omt_tmux send-keys \\\n        -t =omt-hub: Enter 2>/dev/null"],
    ];
    const scan = (f: string) => {
      const ts = tmuxTargets(`f() {\n    ${f}\n}\n`);
      return { f, targets: ts.length, flagged: flagged(ts).length };
    };
    const prefix = [...fixtures, ...spellings.map(([p]) => p)];
    expect(prefix.map(scan)).toEqual(prefix.map((f) => ({ f, targets: f === second ? 2 : 1, flagged: 1 })));
    const twins = spellings.map(([, e]) => e);
    expect(twins.map(scan)).toEqual(twins.map((f) => ({ f, targets: 1, flagged: 0 })));
    expect(tmuxTargets("f() {\n    # omt_tmux has-session -t omt-hub\n}\n")).toEqual([]);
  });

  test("S1c positive control: profile.sh's 27 tgt and tgt_pane targets are found, and exact default-form lines pass", () => {
    const src = readFileSync(path.join(CHECKOUT, "bin", "omt-profile.sh"), "utf-8");
    const ts = profileTargets(src);
    expect({
      targets: ts.length,
      tgt: ts.filter((t) => t.helper === "tgt").length,
      tgtPane: ts.filter((t) => t.helper === "tgt_pane").length,
      paneOffSendKeys: ts.filter((t) => (t.helper === "tgt_pane") !== (t.call.verb === "send-keys")).map((t) => `${t.call.line}: ${t.call.text}`),
    }).toEqual({ targets: 27, tgt: 19, tgtPane: 8, paneOffSendKeys: [] });

    const exactLines = [
      'omt_tmux has-session -t "=omt-$NAME" 2>/dev/null',
      'omt_tmux send-keys -t "=omt-$name:" Enter 2>/dev/null',
      "omt_tmux send-keys -t =omt-hub: Enter 2>/dev/null",
      'omt_tmux kill-session -t "=$s" 2>/dev/null',
      'omt_tmux capture-pane -p -t "=omt-hub:"',
    ];
    const seen = exactLines.map((f) => {
      const t = tmuxTargets(`f() {\n    ${f}\n}\n`);
      return { f, targets: t.length, flagged: flagged(t).length };
    });
    expect(seen).toEqual(exactLines.map((f) => ({ f, targets: 1, flagged: 0 })));
  });
});

// ── Behaviour: a fake router, pinned sandboxes, sibling sessions ──────────

/** A free port outside both hubs' ranges: 8800-8899 (freePort) and 9800-9899. */
function testPort(): number {
  let p = freePort();
  while (p >= 9800 && p <= 9899) p = freePort();
  return p;
}

const router = Bun.serve({
  port: testPort(),
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return Response.json({ status: "ok", platform: "telegram", sessions: 0 });
    if (pathname === "/sessions" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      return Response.json({ name: body.name ?? "", threadId: "t" });
    }
    if (pathname === "/sessions") return Response.json({});
    // hub_add aborts on a body that names the session: 404 with {}.
    if (pathname.startsWith("/sessions/")) return Response.json({}, { status: req.method === "DELETE" ? 200 : 404 });
    return Response.json({}, { status: 404 });
  },
});

const boxes: Sandbox[] = [];
afterAll(() => {
  boxes.forEach(cleanup);
  router.stop(true);
});

function box(pinDefault = true): Sandbox {
  const sb = makeSandbox({ mode: "guard", fleetAgents: true, pinDefault });
  boxes.push(sb);
  return sb;
}

function omt(sb: Sandbox, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return runOmtAsync(sb, args, { profile: false, env: { ROUTER_PORT: String(router.port) }, timeoutMs });
}

function session(sb: Sandbox, name: string, cmd = "sleep 6029") {
  const r = sandboxTmux(sb, ["new-session", "-d", "-s", name, cmd]);
  if (r.code !== 0) throw new Error(`setup: new-session ${name} failed: ${r.stderr}`);
}

function alive(sb: Sandbox, names: string[]): Record<string, boolean> {
  return Object.fromEntries(names.map((n) => [n, sandboxTmux(sb, ["has-session", "-t", `=${n}`]).code === 0]));
}

const all = (names: string[], up: boolean) => Object.fromEntries(names.map((n) => [n, up]));

function read(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf-8") : "";
}

/**
 * omt-app2 runs a recorder that appends "L\n" per line it reads, so an Enter
 * typed into its pane shows in app2.in. Presence probe: one Enter through the
 * exact pane target must show up within 5 s; then the file is emptied.
 * Returns what the probe saw ("L\n" when the recorder works). After
 * idleSeconds without a line the recorder exits, so a run killed before
 * cleanup doesn't leave it behind.
 */
async function recorder(sb: Sandbox, idleSeconds = 600): Promise<{ file: string; probe: string }> {
  const rec = path.join(sb.root, "rec.sh");
  const file = path.join(sb.root, "app2.in");
  writeFileSync(rec, `while IFS= read -r -t ${idleSeconds} l; do printf 'L\\n' >> "$1"; done\n`);
  session(sb, "omt-app2", `bash ${rec} ${file}`);
  sandboxTmux(sb, ["send-keys", "-t", "=omt-app2:", "Enter"]);
  for (let i = 0; i < 50 && read(file) !== "L\n"; i++) await Bun.sleep(100);
  const probe = read(file);
  writeFileSync(file, "");
  return { file, probe };
}

function hubLine(stdout: string): string {
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  return (plain.split("\n").find((l) => /^\s*Hub:/.test(l)) ?? "").trim();
}

const reached = (sb: Sandbox) => logLines(sb, "attach").map((l) => l.replace(/^ATTACH \S+ /, ""));

describe("C0 the pinned shim", () => {
  test("C0a a pinned default-mode run reaches only the sandbox's own server", async () => {
    const sb = box();
    const r = await omt(sb, ["hub", "attach", "x"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Session 'x' not found");
    const calls = logLines(sb, "tmux");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((l) => !l.startsWith(`-L ${sb.socket} `))).toEqual([]);
    expect(logLines(sb, "refused").filter((l) => l.startsWith("REFUSED tmux"))).toEqual([]);
    const natural = logLines(sb, "tmux-call");
    expect(natural.some((l) => /^has-session -t =?omt-x $/.test(l))).toBe(true);
    expect(natural.filter((l) => /(^| )-[LS]/.test(l))).toEqual([]);
  });

  test("C0b without the pin, default mode's bare tmux is refused", async () => {
    const sb = box(false);
    const r = await omt(sb, ["hub", "attach", "x"]);
    expect(r.code).toBe(1);
    expect(logLines(sb, "refused").some((l) => l.startsWith("REFUSED tmux has-session"))).toBe(true);
  });

  test("C0c the attach stand-in names the session an attach reaches, NONE when it finds none", () => {
    const sb = box();
    session(sb, "omt-x");
    // No TMUX_TMPDIR in this env: the shim must set it to find the server.
    const attach = (t: string) =>
      Bun.spawnSync([path.join(sb.shim, "tmux"), "attach-session", "-t", t], { env: { PATH: "/usr/bin:/bin" }, cwd: sb.root, stdout: "pipe", stderr: "pipe" }).exitCode;
    expect(attach("=omt-x")).toBe(0);
    expect(logLines(sb, "attach")).toEqual(["ATTACH =omt-x -> omt-x"]);
    expect(logLines(sb, "tmux").map((l) => l.trimEnd())).toEqual([`-L ${sb.socket} -C attach-session -t =omt-x`]);
    expect(attach("=omt-y")).toBe(1);
    expect(logLines(sb, "attach")).toEqual(["ATTACH =omt-x -> omt-x", "ATTACH =omt-y -> NONE"]);
  });

  test("C0d the pinned shim refuses a -S hidden in a flag cluster before the subcommand", () => {
    const sb = box();
    session(sb, "omt-x");
    const elsewhere = path.join(sb.root, "elsewhere.sock");
    const shim = (...args: string[]) =>
      Bun.spawnSync([path.join(sb.shim, "tmux"), ...args], { env: { PATH: "/usr/bin:/bin" }, cwd: sb.root, stdout: "pipe", stderr: "pipe" }).exitCode;
    expect({ uS: shim("-uS", elsewhere, "list-sessions"), twoUS: shim("-2uS", elsewhere, "list-sessions"), u: shim("-u", "list-sessions") }).toEqual({
      uS: 99,
      twoUS: 99,
      u: 0,
    });
    expect(logLines(sb, "refused")).toEqual([
      `REFUSED tmux -L ${sb.socket} -uS ${elsewhere} list-sessions`,
      `REFUSED tmux -L ${sb.socket} -2uS ${elsewhere} list-sessions`,
    ]);
  });
});

describe("R the B6/B7 recorder", () => {
  test("R1 the recorder records an Enter and exits on its own once idle", async () => {
    const sb = box();
    const { probe } = await recorder(sb, 2);
    expect(probe).toBe("L\n");
    let up = true;
    for (let i = 0; i < 60 && up; i++) {
      await Bun.sleep(100);
      up = alive(sb, ["omt-app2"])["omt-app2"];
    }
    expect({ recorderUp: up }).toEqual({ recorderUp: false });
  });
});

describe("B1 hub remove (952, 953)", () => {
  test("B1a hub remove app with only omt-app2 leaves omt-app2 alive", async () => {
    const sb = box();
    session(sb, "omt-app2");
    expect(alive(sb, ["omt-app2"])).toEqual(all(["omt-app2"], true));
    const r = await omt(sb, ["hub", "remove", "app"]);
    expect({ code: r.code, stopped: r.stdout.includes("Stopped: app"), alive: alive(sb, ["omt-app2"]) }).toEqual({
      code: 0,
      stopped: true,
      alive: all(["omt-app2"], true),
    });
  });

  test("B1b hub remove app kills omt-app and leaves omt-app2", async () => {
    const sb = box();
    session(sb, "omt-app");
    session(sb, "omt-app2");
    expect(alive(sb, ["omt-app", "omt-app2"])).toEqual(all(["omt-app", "omt-app2"], true));
    const r = await omt(sb, ["hub", "remove", "app"]);
    expect({ code: r.code, alive: alive(sb, ["omt-app", "omt-app2"]) }).toEqual({ code: 0, alive: { "omt-app": false, "omt-app2": true } });
  });
});

describe("B2 hub attach NAME (1021, 1022)", () => {
  test("B2a hub attach app with only omt-app2 says not found and attaches nothing", async () => {
    const sb = box();
    session(sb, "omt-app2");
    expect(alive(sb, ["omt-app2"])).toEqual(all(["omt-app2"], true));
    const r = await omt(sb, ["hub", "attach", "app"]);
    expect({ code: r.code, notFound: r.stdout.includes("Session 'app' not found"), attach: logLines(sb, "attach") }).toEqual({
      code: 1,
      notFound: true,
      attach: [],
    });
  });

  test("B2b hub attach app attaches omt-app when it exists beside omt-app2", async () => {
    const sb = box();
    session(sb, "omt-app");
    session(sb, "omt-app2");
    expect(alive(sb, ["omt-app", "omt-app2"])).toEqual(all(["omt-app", "omt-app2"], true));
    const r = await omt(sb, ["hub", "attach", "app"]);
    expect({ code: r.code, reached: reached(sb) }).toEqual({ code: 0, reached: ["-> omt-app"] });
  });
});

describe("B3 hub attach hub and router (1015-1016, 1018-1019)", () => {
  test("B3a hub attach and attach router with only omt-hubx and omt-routerx say not running and attach nothing", async () => {
    const sb = box();
    session(sb, "omt-hubx");
    session(sb, "omt-routerx");
    expect(alive(sb, ["omt-hubx", "omt-routerx"])).toEqual(all(["omt-hubx", "omt-routerx"], true));
    const hub = await omt(sb, ["hub", "attach"]);
    const rtr = await omt(sb, ["hub", "attach", "router"]);
    expect({
      hub: [hub.code, hub.stdout.includes("Hub not running.")],
      router: [rtr.code, rtr.stdout.includes("Router not running.")],
      attach: logLines(sb, "attach"),
    }).toEqual({ hub: [1, true], router: [1, true], attach: [] });
  });

  test("B3b hub attach and attach router attach omt-hub and omt-router", async () => {
    const sb = box();
    session(sb, "omt-hub");
    session(sb, "omt-router");
    expect(alive(sb, ["omt-hub", "omt-router"])).toEqual(all(["omt-hub", "omt-router"], true));
    const hub = await omt(sb, ["hub", "attach"]);
    const rtr = await omt(sb, ["hub", "attach", "router"]);
    expect({ codes: [hub.code, rtr.code], reached: reached(sb) }).toEqual({ codes: [0, 0], reached: ["-> omt-hub", "-> omt-router"] });
  });
});

describe("B4 hub stop (1045, 1054-1055, 1060-1061)", () => {
  // omt-hubx and omt-routerx never enter the stop loop: bin/omt:1035's `grep -v`
  // drops any name containing omt-hub or omt-router (fork #47). When #47 is
  // fixed they join the loop and are stopped by exact name, so B4a and the
  // revert-stop control mutant flip by design: update both then.
  test("B4a hub stop kills project sessions and leaves omt-hubx and omt-routerx alive", async () => {
    const sb = box();
    for (const s of ["omt-hubx", "omt-routerx", "omt-p"]) session(sb, s);
    expect(alive(sb, ["omt-hubx", "omt-routerx", "omt-p"])).toEqual(all(["omt-hubx", "omt-routerx", "omt-p"], true));
    const r = await omt(sb, ["hub", "stop"]);
    expect({ code: r.code, alive: alive(sb, ["omt-hubx", "omt-routerx", "omt-p"]) }).toEqual({
      code: 0,
      alive: { "omt-hubx": true, "omt-routerx": true, "omt-p": false },
    });
  });

  test("B4b hub stop kills omt-hub and omt-router", async () => {
    const sb = box();
    session(sb, "omt-hub");
    session(sb, "omt-router");
    expect(alive(sb, ["omt-hub", "omt-router"])).toEqual(all(["omt-hub", "omt-router"], true));
    const r = await omt(sb, ["hub", "stop"]);
    expect({
      code: r.code,
      stopped: [r.stdout.includes("Stopped: hub"), r.stdout.includes("Stopped: router")],
      alive: alive(sb, ["omt-hub", "omt-router"]),
    }).toEqual({ code: 0, stopped: [true, true], alive: all(["omt-hub", "omt-router"], false) });
  });
});

describe("B5 hub status (1002)", () => {
  test("B5a hub status says the hub is stopped when only omt-hubx exists", async () => {
    const sb = box();
    session(sb, "omt-hubx");
    expect(alive(sb, ["omt-hubx"])).toEqual(all(["omt-hubx"], true));
    const r = await omt(sb, ["hub", "status"]);
    expect(hubLine(r.stdout)).toMatch(/^Hub:\s+stopped$/);
  });

  test("B5b hub status says the hub is running when omt-hub exists", async () => {
    const sb = box();
    session(sb, "omt-hub");
    expect(alive(sb, ["omt-hub"])).toEqual(all(["omt-hub"], true));
    const r = await omt(sb, ["hub", "status"]);
    expect(hubLine(r.stdout)).toMatch(/^Hub:\s+running$/);
  });
});

// B6 and B7 each run bin/omt once; both tests of a pair share that run
// (a memoized promise, not a hook, so a title filter can run either alone).

interface FlowRun {
  sb: Sandbox;
  r: RunResult;
  probe: string;
  before: Record<string, boolean>;
  /** omt-app was seen up while bin/omt ran (so "gone" afterwards means an Enter ended it). */
  appSeenUp: boolean;
  after: Record<string, boolean>;
  app2In: string;
  newSession: boolean;
  sendKeys: number;
  bridgePolls: number;
  polls88xx: string[];
  refusedCurl: string[];
}

async function flow(setup: (sb: Sandbox) => void, args: string[], timeoutMs: number, watch: string[]): Promise<FlowRun> {
  const sb = box();
  setup(sb);
  const { file, probe } = await recorder(sb);
  const proj = path.join(sb.root, "app");
  mkdirSync(proj);
  // The pane's claude (the shim) exits at once; the pane then waits in read -n1.
  writeFileSync(path.join(sb.root, "claude-fail-app"), "");
  // hub add and restore take the bridge port from this file: a closed port
  // outside both hubs' ranges, so the bridge never comes up and nothing live
  // (8801, 8802) is polled.
  const bridgePort = testPort();
  writeFileSync(path.join(sb.fleet, ".next-bridge-port"), `${bridgePort}\n`);
  const before = alive(sb, watch);
  let done = false;
  const running = omt(sb, args.map((a) => (a === "<app>" ? proj : a)), timeoutMs);
  running.then(
    () => (done = true),
    () => (done = true)
  );
  let appSeenUp = false;
  while (!done && !appSeenUp) {
    appSeenUp = alive(sb, ["omt-app"])["omt-app"];
    if (!appSeenUp) await Bun.sleep(100);
  }
  const r = await running;
  await Bun.sleep(1000); // let a late Enter land before the snapshot
  const tmux = logLines(sb, "tmux");
  const curl = logLines(sb, "curl");
  return {
    sb,
    r,
    probe,
    before,
    appSeenUp,
    after: alive(sb, ["omt-app", ...watch]),
    app2In: read(file),
    newSession: tmux.some((l) => l.includes(" new-session -d -s omt-app ")),
    sendKeys: tmux.filter((l) => l.includes(" send-keys ")).length,
    bridgePolls: curl.filter((l) => l.includes(`localhost:${bridgePort}/health`)).length,
    polls88xx: curl.filter((l) => /:88\d\d\b/.test(l)),
    refusedCurl: logLines(sb, "refused").filter((l) => l.startsWith("REFUSED curl")),
  };
}

describe("B6 hub add (895, 897, 899, 911)", () => {
  // The seeded bridge port is closed: the wait loop runs all 46 rounds.
  let run: Promise<FlowRun> | undefined;
  const b6 = () => (run ??= flow(() => {}, ["hub", "add", "<app>"], 120_000, ["omt-app2"]));

  test("B6a hub add sends no Enter to a sibling omt-app2", async () => {
    const f = await b6();
    expect({ probe: f.probe, before: f.before }).toEqual({ probe: "L\n", before: all(["omt-app2"], true) });
    expect({
      code: f.r.code,
      bridgeFailed: f.r.stdout.includes("Bridge failed to start for 'app'"),
      newSession: f.newSession,
      sendKeysAtLeast4: f.sendKeys >= 4,
      app2In: f.app2In,
      app2Alive: f.after["omt-app2"],
    }).toEqual({ code: 1, bridgeFailed: true, newSession: true, sendKeysAtLeast4: true, app2In: "", app2Alive: true });
    expect({ bridgePolled: f.bridgePolls > 0, polls88xx: f.polls88xx, refusedCurl: f.refusedCurl }).toEqual({ bridgePolled: true, polls88xx: [], refusedCurl: [] });
  }, 150_000);

  test("B6b hub add's Enter reaches omt-app through the exact pane target", async () => {
    const f = await b6();
    expect({ newSession: f.newSession, appSeenUp: f.appSeenUp, appAlive: f.after["omt-app"] }).toEqual({ newSession: true, appSeenUp: true, appAlive: false });
  }, 150_000);
});

describe("B7 hub start restore (542, 544, 546, 559)", () => {
  // omt-router and omt-hub exist, so hub_start starts neither (and keeps the
  // seeded bridge port file); node_modules exists and there is no dashboard,
  // so nothing installs or builds. The seeded bridge port is closed: restore's
  // loop runs all 61 rounds.
  let run: Promise<FlowRun> | undefined;
  const watch = ["omt-app2", "omt-router", "omt-hub"];
  const setup = (sb: Sandbox) => {
    session(sb, "omt-router");
    session(sb, "omt-hub");
    mkdirSync(path.join(sb.fleet, "channel", "node_modules"), { recursive: true });
    const proj = path.join(sb.root, "app");
    writeFileSync(path.join(sb.fleet, "hub-registry.json"), JSON.stringify({ sessions: { app: { name: "app", path: proj } } }));
  };
  const b7 = () => (run ??= flow(setup, ["hub", "start", "--no-browser"], 150_000, watch));

  test("B7a hub start's restore sends no Enter to a sibling omt-app2", async () => {
    const f = await b7();
    expect({ probe: f.probe, before: f.before }).toEqual({ probe: "L\n", before: all(watch, true) });
    const { stdout, stderr } = f.r;
    expect({
      code: f.r.code,
      routerSkipped: stdout.includes("Router already running."),
      hubSkipped: stdout.includes("Hub session already running."),
      restoring: stdout.includes("Restoring app"),
      installed: stdout.includes("Installing channel dependencies"),
      built: stdout.includes("Building dashboard"),
      restoreFailed: stderr.includes("Failed to restore 'app'"),
      newSession: f.newSession,
      app2In: f.app2In,
      alive: Object.fromEntries(watch.map((n) => [n, f.after[n]])),
    }).toEqual({
      code: 0,
      routerSkipped: true,
      hubSkipped: true,
      restoring: true,
      installed: false,
      built: false,
      restoreFailed: true,
      newSession: true,
      app2In: "",
      alive: all(watch, true),
    });
    expect({ bridgePolled: f.bridgePolls > 0, polls88xx: f.polls88xx, refusedCurl: f.refusedCurl }).toEqual({ bridgePolled: true, polls88xx: [], refusedCurl: [] });
  }, 180_000);

  test("B7b restore's Enter reaches omt-app through the exact pane target", async () => {
    const f = await b7();
    expect({ newSession: f.newSession, appSeenUp: f.appSeenUp, appAlive: f.after["omt-app"] }).toEqual({ newSession: true, appSeenUp: true, appAlive: false });
  }, 180_000);
});

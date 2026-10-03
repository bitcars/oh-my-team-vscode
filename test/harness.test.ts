/**
 * Controls for the fail-safe harness (WO-021 plan v2 §6, C0/C0b).
 *
 * These run bin/omt in DEFAULT mode on purpose: the profile is not set, so
 * the code under test would aim at the live fleet (default tmux server,
 * router :8800). The harness shims must refuse every such call. The tests
 * assert on the shim's own refusal log, not on "the fleet survived".
 */
import { spawnSync } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { cleanup, defaultTmuxSocketDir, logLines, makeSandbox, REAL, runOmt, type Sandbox } from "./omt-harness";

const boxes: Sandbox[] = [];
afterAll(() => boxes.forEach(cleanup));
function box() {
  const sb = makeSandbox({ mode: "guard" });
  boxes.push(sb);
  return sb;
}

describe("harness controls", () => {
  test("C0: a default-mode `hub stop` is refused by the tmux shim (exit 99)", () => {
    const sb = box();
    runOmt(sb, ["hub", "stop"], { profile: false });
    const refused = logLines(sb, "refused").filter((l) => l.startsWith("REFUSED tmux"));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.some((l) => l.includes("list-sessions"))).toBe(true);
    // every tmux call that reached the shim was refused: none carried a test socket
    const calls = logLines(sb, "tmux").filter((l) => !l.startsWith("REFUSED"));
    expect(calls.length).toBe(refused.length);
  });

  test("C0b: a default-mode `hub add` is refused by the curl shim on :8800 (exit 7)", () => {
    const sb = box();
    const r = runOmt(sb, ["hub", "add", sb.root], { profile: false });
    expect(r.code).not.toBe(0);
    const refused = logLines(sb, "refused").filter((l) => l.startsWith("REFUSED curl"));
    expect(refused.some((l) => /localhost:8800/.test(l))).toBe(true);
  });

  test("the spawned env carries no fleet variable even if the test runner has them", () => {
    const sb = box();
    const r = runOmt(sb, [], { profile: false, script: "/dev/stdin", stdin: "env" });
    const keys = r.stdout.split("\n").map((l) => l.split("=")[0]);
    for (const k of ["TMUX", "TMUX_PANE", "ROUTER_PORT", "ROUTER_URL", "BRIDGE_PORT", "OMT_HUB_DIR", "SESSION_NAME", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"]) {
      expect(keys).not.toContain(k);
    }
    expect(r.stdout).toContain(`HOME=${sb.home}\n`);
  });

  test("the curl shim refuses non-localhost URLs too (no network from tests)", () => {
    const sb = box();
    runOmt(sb, [], { profile: false, script: "/dev/stdin", stdin: "curl -s https://api.telegram.org/botX/getMe; echo rc=$?" });
    expect(logLines(sb, "refused").some((l) => l.includes("api.telegram.org"))).toBe(true);
  });

  test("the shims refuse every spelling of the default hub's ports, other sockets, and a bridge aimed at the default hub", () => {
    const sb = box();
    const curls = ["http://localhost:08800/health", "LOCALHOST:8800/health", "0:8800", "127.1:9999", "HTTP://LocalHost:8899/x?y=1"];
    const tmuxes = [`-L ${sb.socket} -S /tmp/elsewhere ls`, "-Ldefault ls", "-L default ls"];
    const script = [
      ...curls.map((u) => `curl -s ${u}`),
      ...tmuxes.map((t) => `tmux ${t}`),
      // inside a pane of the test server, an explicit other socket is still refused
      `TMUX=/tmp/tmux-0/${sb.socket},1,0 tmux -L default ls`,
      "ROUTER_URL= BRIDGE_PORT=9999 claude",
      "ROUTER_URL=http://localhost:8800 BRIDGE_PORT=9999 claude",
      "ROUTER_URL=http://localhost:9998 BRIDGE_PORT=8801 claude",
      "ROUTER_URL=http://localhost:9998 BRIDGE_PORT= claude",
      // presence control: a localhost port outside the band is let through
      "curl -s -o /dev/null http://127.0.0.1:9/ ; true",
    ].join("\n");
    runOmt(sb, [], { profile: false, script: "/dev/stdin", stdin: script });
    const refused = logLines(sb, "refused");
    for (const u of curls) expect({ u, refused: refused.includes(`REFUSED curl ${u}`) }).toEqual({ u, refused: true });
    expect(refused.filter((l) => l.startsWith("REFUSED tmux")).length).toBe(tmuxes.length + 1);
    expect(refused.filter((l) => l.startsWith("REFUSED bridge")).length).toBe(4);
    expect(refused.some((l) => l.includes("127.0.0.1:9/"))).toBe(false);
    expect(logLines(sb, "curl").some((l) => l.includes("127.0.0.1:9/"))).toBe(true);
  });

  // A server the run started must not outlive cleanup(), wherever its socket
  // lives: the default dir (the profile's `env -i` drops TMUX_TMPDIR) or the
  // sandbox's TMUX_TMPDIR (a build that skips `env -i`).
  for (const where of ["default socket dir", "sandbox TMUX_TMPDIR"] as const) {
    test(`cleanup kills a test server in the ${where} and leaves no socket file`, () => {
      const sb = makeSandbox({ mode: "guard" });
      const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
      if (where === "sandbox TMUX_TMPDIR") env.TMUX_TMPDIR = path.join(sb.root, "tmux");
      const tmux = (...a: string[]) => spawnSync([REAL.tmux, "-L", sb.socket, ...a], { env, stdout: "pipe", stderr: "pipe" });
      expect(tmux("new-session", "-d", "-s", "probe", "sleep 300").exitCode).toBe(0);
      const pid = Number(tmux("display-message", "-p", "#{pid}").stdout.toString().trim());
      expect(pid).toBeGreaterThan(0);

      cleanup(sb);

      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 40 && alive(); i++) Bun.sleepSync(50);
      expect({ where, serverAlive: alive() }).toEqual({ where, serverAlive: false });
      expect(existsSync(path.join(defaultTmuxSocketDir(), sb.socket))).toBe(false);
    });
  }
});

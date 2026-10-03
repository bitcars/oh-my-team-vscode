/**
 * Acceptance for issue #9 (WO-021 plan v2 §8): a profile hub started beside
 * the LIVE default hub changes nothing of the default hub's.
 *
 * Opt-in: OMTV_ACCEPTANCE=1 bun test test/omtv-isolation.test.ts
 *
 * It reads (never writes) the real ~/.oh-my-team, ~/.mcp.json, the real
 * default tmux server and ports 8800-8899, so it does not run in the normal
 * suite. Everything it starts lives in a /tmp sandbox, on a private
 * `tmux -L omtv-test-*` server, behind the harness shims. The "claude" here
 * is the harness shim (it starts the real bridge.ts), not the real claude;
 * the real claude and router run only in the operator's live steps.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { CHECKOUT, cleanup, logLines, makeSandbox, REAL, runOmt, runOmtAsync, trust, writeProfilePorts } from "./omt-harness";

setDefaultTimeout(300_000);

const ENABLED = process.env.OMTV_ACCEPTANCE === "1";
const HOME = userInfo().homedir;
const FLEET = path.join(HOME, ".oh-my-team");
const TAG = `wo021acc-${process.pid}`;

function sha(p: string): string {
  return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent";
}

function defaultSessions(): string[] {
  const r = Bun.spawnSync([REAL.tmux, "-L", "default", "list-sessions", "-F", "#{session_name}"], { env: { PATH: "/usr/bin:/bin" } });
  return r.stdout.toString().split("\n").filter(Boolean).sort();
}

function fleetPorts(): string[] {
  const r = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], { env: { PATH: "/usr/sbin:/usr/bin:/bin" } });
  const ports = new Set<string>();
  for (const m of r.stdout.toString().matchAll(/:(88\d\d) \(LISTEN\)/g)) ports.add(m[1]);
  return [...ports].sort();
}

/**
 * The default hub's registry minus each session's lastActivity. The live
 * router rewrites that field on every message its own sessions send, so it
 * changes during the run whatever the profile does. Every other field, and
 * the set of sessions, must stay identical.
 */
function registryShape(reg: string): { keys: string[]; body: string } {
  if (!existsSync(reg)) return { keys: [], body: "absent" };
  const sessions: Record<string, Record<string, unknown>> = JSON.parse(readFileSync(reg, "utf-8")).sessions ?? {};
  const stripped = Object.fromEntries(
    Object.entries(sessions).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([f]) => f !== "lastActivity"))])
  );
  return { keys: Object.keys(sessions).sort(), body: createHash("sha256").update(JSON.stringify(stripped)).digest("hex") };
}

function snapshot() {
  const reg = path.join(FLEET, "hub-registry.json");
  return {
    S1: registryShape(reg),
    S2: sha(path.join(HOME, ".mcp.json")),
    S3: defaultSessions(),
    S4: fleetPorts(),
    S5: {
      nextPort: sha(path.join(FLEET, ".next-bridge-port")),
      omtEnv: sha(path.join(HOME, ".omt-env")),
      top: existsSync(FLEET) ? readdirSync(FLEET).sort() : [],
    },
    S6: {
      git: Bun.spawnSync(["git", "-C", CHECKOUT, "status", "--porcelain"]).stdout.toString(),
      mcp: sha(path.join(CHECKOUT, ".mcp.json")),
      settings: sha(path.join(CHECKOUT, "settings.json")),
    },
  };
}

const boxes: ReturnType<typeof makeSandbox>[] = [];
afterAll(() => boxes.forEach(cleanup));

describe.skipIf(!ENABLED)("omtv beside the live default hub", () => {
  test("a profile start → add → stop leaves the default hub untouched", async () => {
    expect(existsSync(FLEET)).toBe(true); // the point is to run beside a real default hub
    const sb = makeSandbox({ mode: "guard" });
    boxes.push(sb);
    const ports = writeProfilePorts(sb);
    // a token that can't be the default hub's; the real config is compared in-process
    await Bun.write(path.join(sb.omtHome, "hub-config.json"), JSON.stringify({ platform: "telegram", credentials: { botToken: `999999:${TAG}`, chatId: "-999999" } }));
    trust(sb, path.join(sb.omtHome, "hub"));
    const proj = path.join(sb.root, TAG);
    mkdirSync(proj);
    trust(sb, proj);

    const routerLog = path.join(FLEET, "router.log");
    const routerLogOffset = existsSync(routerLog) ? statSync(routerLog).size : 0;
    const before = snapshot();

    // real HOME, real default-hub dir as the guarded one; sandbox for the rest
    const env = { HOME, OMT_FLEET_DIR: undefined };
    let polling = true;
    const seenOnDefault = new Set<string>();
    const poll = (async () => {
      while (polling) {
        for (const s of defaultSessions()) seenOnDefault.add(s);
        await Bun.sleep(500);
      }
    })();

    try {
      const start = await runOmtAsync(sb, ["hub", "start"], { env, timeoutMs: 120_000 });
      expect({ code: start.code, err: start.stderr.slice(-500) }).toEqual({ code: 0, err: start.stderr.slice(-500) });
      const add = await runOmtAsync(sb, ["hub", "add", proj], { env, timeoutMs: 120_000 });
      expect(add.code).toBe(0);

      const reg = JSON.parse(readFileSync(path.join(sb.omtHome, "hub-registry.json"), "utf-8")).sessions;
      expect(Object.keys(reg).sort()).toEqual(["hub", TAG].sort());
      for (const p of [ports.router, ports.hub, reg[TAG].bridgePort]) {
        expect((await fetch(`http://127.0.0.1:${p}/health`)).ok).toBe(true);
      }
      expect(readdirSync(proj)).toEqual([]);

      const stop = await runOmtAsync(sb, ["hub", "stop"], { env, timeoutMs: 60_000 });
      expect(stop.code).toBe(0);
    } finally {
      polling = false;
      await poll;
    }

    const after = snapshot();
    expect(after).toEqual(before);

    // attributable: the tag appears nowhere on the default hub's side
    expect([...seenOnDefault].filter((s) => s.includes("wo021acc"))).toEqual([]);
    expect(after.S1.keys.filter((k) => k.includes("wo021acc"))).toEqual([]);
    expect(readdirSync(FLEET).filter((n) => n.includes("wo021acc"))).toEqual([]);
    if (existsSync(routerLog)) {
      const tail = readFileSync(routerLog).subarray(routerLogOffset).toString();
      expect(tail.includes("wo021acc")).toBe(false);
    }

    // every tmux call carried the test socket; nothing was refused
    const tmuxCalls = logLines(sb, "tmux");
    expect(tmuxCalls.length).toBeGreaterThan(5);
    expect(tmuxCalls.filter((l) => !l.includes(`-L ${sb.socket}`))).toEqual([]);
    expect(logLines(sb, "refused")).toEqual([]);
    // the session's status hook posted to the profile router only
    const posts = logLines(sb, "curl").filter((l) => l.includes("/status"));
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((l) => l.includes(`localhost:${ports.router}/status`))).toBe(true);

    // negative control: one un-socketed call trips the same detector
    runOmt(sb, [], { profile: false, script: "/dev/stdin", stdin: "tmux has-session -t wo021-negative-control" });
    const after2 = logLines(sb, "tmux").filter((l) => !l.includes(`-L ${sb.socket}`));
    expect(after2.some((l) => l.includes("wo021-negative-control"))).toBe(true);
    expect(logLines(sb, "refused").some((l) => l.includes("wo021-negative-control"))).toBe(true);
  });
});

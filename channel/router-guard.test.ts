/**
 * Profile startup guard in router.ts (WO-021 plan v2 §3, T16).
 *
 * Spawns the real router with OMT_PROFILE=1 against a fake "default hub" dir
 * inside a /tmp sandbox (the OMT_FLEET_DIR seam, honoured only under
 * OMT_TEST_SANDBOX). Every fixture uses platform "none", so a router that
 * passes the guard stops at "Unknown platform" (exit 1) before any network
 * call or port bind, and a refused one exits 2 first. That also pins the
 * guard's position: moved after loadAdapter, the refused rows would exit 1.
 *
 * bin/omt's control (test/omt-profile.control.test.ts) mutates router.ts and
 * names these tests by title.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dir;
const ROOT = mkdtempSync(path.join(realpathSync("/tmp"), "omt-router-guard-"));
const FLEET = path.join(ROOT, "fleet");
const FLEET_CREDS = { botToken: "111111:FLEET-AAAA", appToken: "xapp-FLEET", chatId: "-1001" };
mkdirSync(FLEET, { recursive: true });
writeFileSync(path.join(FLEET, "hub-config.json"), JSON.stringify({ platform: "none", credentials: FLEET_CREDS }));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
function hubDir(creds: Record<string, string>): string {
  const d = path.join(ROOT, `hub-${++n}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "hub-config.json"), JSON.stringify({ platform: "none", credentials: creds }));
  return d;
}

function router(dir: string, port: number, profile = true, fleet = FLEET) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: ROOT,
    OMT_HUB_DIR: dir,
    ROUTER_PORT: String(port),
    OMT_TEST_SANDBOX: ROOT,
    OMT_FLEET_DIR: fleet,
  };
  if (profile) env.OMT_PROFILE = "1";
  const r = Bun.spawnSync([process.execPath, "run", "router.ts"], { cwd: HERE, env, timeout: 20_000 });
  return { code: r.exitCode, err: r.stderr.toString() };
}

const OK_CREDS = { botToken: "222222:OMTV", chatId: "-2002" };

function refused(r: { code: number | null; err: string }) {
  return r.code === 2 && r.err.includes("refusing to start");
}
function passed(r: { code: number | null; err: string }) {
  return r.code === 1 && r.err.includes("Unknown platform");
}

describe("router profile startup guard", () => {
  test("refuses the default hub's dir and anything inside it", () => {
    expect(refused(router(FLEET, 19011))).toBe(true);
    const sub = path.join(FLEET, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "hub-config.json"), JSON.stringify({ platform: "none", credentials: OK_CREDS }));
    expect(refused(router(sub, 19012))).toBe(true);
  });

  test("refuses a hub dir that contains the default hub's dir", () => {
    // Not ROOT itself: ROOT is $HOME here (and bun's userInfo().homedir reads
    // $HOME), so the home-dir refusal would mask this one.
    const outer = path.join(ROOT, "outer");
    const innerFleet = path.join(outer, "fleet");
    mkdirSync(innerFleet, { recursive: true });
    writeFileSync(path.join(innerFleet, "hub-config.json"), JSON.stringify({ platform: "none", credentials: FLEET_CREDS }));
    writeFileSync(path.join(outer, "hub-config.json"), JSON.stringify({ platform: "none", credentials: OK_CREDS }));
    const r = router(outer, 19022, true, innerFleet);
    expect({ refused: refused(r), contains: r.err.includes("contains") }).toEqual({ refused: true, contains: true });
    expect(passed(router(hubDir(OK_CREDS), 19023, true, innerFleet))).toBe(true);
  });

  test("refuses when the default hub's config exists but can't be read; allows when there is none", () => {
    const unreadable = path.join(ROOT, "fleet-garbled");
    mkdirSync(unreadable, { recursive: true });
    writeFileSync(path.join(unreadable, "hub-config.json"), "{ not json");
    expect(refused(router(hubDir(OK_CREDS), 19024, true, unreadable))).toBe(true);
    // valid JSON of the wrong shape can't be compared either
    writeFileSync(path.join(unreadable, "hub-config.json"), JSON.stringify({ platform: "none", credentials: "x" }));
    expect(refused(router(hubDir(OK_CREDS), 19030, true, unreadable))).toBe(true);
    const none = path.join(ROOT, "fleet-unconfigured");
    mkdirSync(none, { recursive: true });
    expect(passed(router(hubDir(OK_CREDS), 19025, true, none))).toBe(true);
  });

  test("honours the OMT_FLEET_DIR seam only under a private temp gate", () => {
    // seam = the hub dir itself: honoured, the router refuses; ignored, it passes
    const run = (gate: string, dir: string, port: number) => {
      const r = Bun.spawnSync([process.execPath, "run", "router.ts"], {
        cwd: HERE,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: gate, OMT_HUB_DIR: dir, ROUTER_PORT: String(port), OMT_PROFILE: "1", OMT_TEST_SANDBOX: gate, OMT_FLEET_DIR: dir },
        timeout: 20_000,
      });
      return { code: r.exitCode, err: r.stderr.toString() };
    };
    const outside = mkdtempSync("/var/tmp/omt-router-guard-");
    const loose = mkdtempSync(path.join(realpathSync("/tmp"), "omt-router-guard-loose-"));
    try {
      chmodSync(loose, 0o777);
      for (const gate of [outside, loose]) {
        const dir = path.join(gate, "hub");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "hub-config.json"), JSON.stringify({ platform: "none", credentials: OK_CREDS }));
        expect({ gate, passed: passed(run(gate, dir, 19028)) }).toEqual({ gate, passed: true });
      }
      // control: under the private /tmp gate the same seam is honoured
      const d = hubDir(OK_CREDS);
      expect(refused(router(d, 19029, true, d))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(loose, { recursive: true, force: true });
    }
  });

  test("refuses ports 8800 and 8899, allows 8799 and 8900", () => {
    const d = hubDir(OK_CREDS);
    expect(refused(router(d, 8800))).toBe(true);
    expect(refused(router(d, 8899))).toBe(true);
    expect(passed(router(d, 8799))).toBe(true);
    expect(passed(router(d, 8900))).toBe(true);
  });

  test("refuses the default hub's token, bot id and app token; allows near misses", () => {
    expect(refused(router(hubDir({ botToken: "111111:FLEET-AAAA" }), 19013))).toBe(true);
    expect(refused(router(hubDir({ botToken: "111111:FLEET-AAAB" }), 19014))).toBe(true);
    expect(passed(router(hubDir({ botToken: "111112:FLEET-AAAA" }), 19015))).toBe(true);
    expect(refused(router(hubDir({ botToken: "xoxb-mine", appToken: "xapp-FLEET" }), 19016))).toBe(true);
    expect(passed(router(hubDir({ botToken: "xoxb-mine", appToken: "xapp-FLEEU" }), 19017))).toBe(true);
  });

  test("refuses the default hub's chat; allows another", () => {
    expect(refused(router(hubDir({ botToken: "222222:B", chatId: "-1001" }), 19018))).toBe(true);
    expect(passed(router(hubDir({ botToken: "222222:B", chatId: "-1002" }), 19019))).toBe(true);
  });

  test("the refusal never prints a credential", () => {
    const r = router(hubDir({ botToken: "111111:FLEET-AAAA", appToken: "xapp-FLEET" }), 19020);
    expect(refused(r)).toBe(true);
    for (const s of ["FLEET-AAAA", "xapp-FLEET"]) expect(r.err.includes(s)).toBe(false);
  });

  test("without OMT_PROFILE the router is unchanged: the default dir on a non-8800 port starts", () => {
    expect(passed(router(FLEET, 8850, false))).toBe(true);
    expect(passed(router(hubDir({ botToken: "111111:FLEET-AAAA" }), 19021, false))).toBe(true);
  });
});

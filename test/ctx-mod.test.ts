/**
 * The ctx mod (hooks/ctx-mod.js, WO-022 / fork #16) under Claude Code's own
 * mod test kit.
 *
 * At module load this builds a temp plugin from hooks/ctx-mod.js and the kit
 * file test/mods/ctx-mod.cc-test.ts, then runs `claude plugin test` and
 * `claude plugin validate` on it through the harness (sandboxed: temp HOME and
 * CLAUDE_CONFIG_DIR, see runClaudePluginSandboxed). Each kit title becomes one
 * bun test below. The runs happen at module load because bun cannot register
 * tests from beforeAll.
 *
 * The plugin's real hooks/hooks.json and status-hook.sh go into the temp
 * plugin too, so validate checks the file that ships the feature (its
 * `modules` line), not a stand-in.
 *
 * The mod is read from ../hooks relative to THIS file, so the removal control
 * (ctx-mod.control.test.ts) can run a copy of this file against a patched copy
 * of the mod. Keep TITLES equal to the kit's titles: the "exactly" test fails
 * on any title added, renamed or dropped on one side only.
 *
 * Needs a local claude >= 2.1.289. Without one every test here fails with
 * HARNESS BROKEN; it never skips.
 */

import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type PluginRun, runClaudePluginSandboxed } from "./omt-harness";

const HOOKS_DIR = path.join(import.meta.dir, "..", "hooks");
const MOD = path.join(HOOKS_DIR, "ctx-mod.js");
const KIT = path.join(import.meta.dir, "mods", "ctx-mod.cc-test.ts");

const TITLES = [
  "M1a no SESSION_NAME and no ROUTER_URL: no post",
  "M1b a non-local ROUTER_URL: no post",
  "M1c ROUTER_URL without SESSION_NAME: no post",
  "M1d a teammate process (CLAUDE_CODE_TEAMMATE) never posts",
  "M1e only http on localhost/127.0.0.1 with an explicit port and no path counts as local",
  "M1f SESSION_NAME plus a local ROUTER_URL posts once to <router>/ctx",
  "M2 tokens = input + cache_read + cache_creation of the main step; output never counts",
  "M3 a subagent's step reports the lead's context and keeps the model",
  "M4 model comes from the main step's result.usage.model, never session.model",
  "M5 /clear posts tokens 0, not the stale usage() of the ended conversation",
  "M6a an unchanged report is not sent twice, even a millisecond later",
  "M6b every /clear posts, even when the report is unchanged",
  "M6c session end for exit or other reasons posts nothing",
  "M6d /resume posts tokens null",
  "M7a a manual main-conversation compaction posts tokens null after it ran",
  "M7b a subagent's own compaction posts nothing",
  "M7c a precompute compaction posts nothing",
  "M7d a vetoed compaction posts nothing",
  "M8 running = pending + running + waiting; alive = running + idle",
  "M9a quota maps five_hour and seven_day only; an empty list gives two nulls",
  "M9b no rateLimits at all: quota null and the report still goes out",
  "M10 the wire carries exactly session, sid, at, model, ctx{tokens, window}, quota, agents",
  "M11 an agent list that is refused gives agents null; the report still goes out",
  "M12a a hung agent list holds turn.step for 150 ms of hook time, then the result passes through",
  "M12b a hung usage() holds turn.complete for 150 ms of hook time, no more",
  "M13 a POST that never settles holds no hook: step, measure and clear all return at once",
  "M14a at most 4 POSTs are in flight",
  "M14b a report skipped at the cap is sent by the next event once a slot frees",
  "M14c a refused POST frees its slot: six refused POSTs all go out",
  "M15 at is the mod's Date.now() when the event fired, never decreasing",
  "M16 a report that finishes after a newer one is dropped, and dedupe follows the newer one",
  "M17 a report the router refuses is logged once, not swallowed",
  "M18 a 404 (the session not registered yet) is not logged and leaves the warning for a real refusal",
];

const HOOKS = ["turn.step", "session.measure", "turn.complete", "session.compact", "session.end"];
const ENV_READS = ["CLAUDE_CODE_TEAMMATE", "ROUTER_URL", "SESSION_NAME"];
/** Everything the mod may call: no transcript (`$.session.messages`), no fs, no process. */
const CALLS = ["$.agent.list", "$.clock.sleep", "$.env.get", "$.http.fetch", "$.session.id", "$.session.usage", "$.ui.log"];

// ── Build the temp plugin and run the kit (module load) ────────────────────

const plugin = mkdtempSync(path.join(realpathSync("/tmp"), "omt-ctx-mod-kit-"));
let broken: string | null = null;
let kit: PluginRun | null = null;
let validate: PluginRun | null = null;
try {
  for (const d of [".claude-plugin", "hooks", "tests"]) mkdirSync(path.join(plugin, d));
  writeFileSync(
    path.join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "ctx-mod-kit", version: "0.0.0", description: "ctx-mod kit run", author: { name: "oh-my-team" } })
  );
  for (const f of ["hooks.json", "status-hook.sh"]) copyFileSync(path.join(HOOKS_DIR, f), path.join(plugin, "hooks", f));
  copyFileSync(MOD, path.join(plugin, "hooks", "ctx-mod.js"));
  copyFileSync(KIT, path.join(plugin, "tests", "ctx-mod.test.ts"));
  kit = runClaudePluginSandboxed("test", plugin);
  validate = runClaudePluginSandboxed("validate", plugin);
} catch (err) {
  broken = String(err);
}

afterAll(() => {
  for (const d of [plugin, kit?.sandbox, validate?.sandbox]) if (d) rmSync(d, { recursive: true, force: true });
});

/** Kit result per title: "pass", or the failure text the kit printed under it. */
const results = new Map<string, { pass: boolean; detail: string }>();
/** Titles the kit reported more than once (a later pass would hide an earlier fail). */
const duplicates: string[] = [];
if (kit) {
  let current: { pass: boolean; detail: string } | null = null;
  for (const line of kit.out.split("\n")) {
    const m = line.match(/^\((pass|fail)\) (.*) \[[\d.]+ms\]$/);
    if (m) {
      current = { pass: m[1] === "pass", detail: "" };
      if (results.has(m[2])) duplicates.push(m[2]);
      results.set(m[2], current);
    } else if (current && !current.pass && line.startsWith("  ")) {
      current.detail += line + "\n";
    } else {
      current = null;
    }
  }
}

function harness(): PluginRun {
  if (broken || !kit || !validate) throw new Error(`HARNESS BROKEN: ${broken ?? "kit did not run"}`);
  return kit;
}

for (const title of TITLES) {
  test(title, () => {
    const run = harness();
    const r = results.get(title);
    if (!r) throw new Error(`the kit did not report this title\n${run.out}`);
    if (!r.pass) throw new Error(`kit failure:\n${r.detail}`);
  });
}

test("kit reported exactly the titles listed here, once each, and exited 0", () => {
  const run = harness();
  expect(duplicates).toEqual([]);
  expect([...results.keys()].sort()).toEqual([...TITLES].sort());
  expect(run.code).toBe(0);
});

test("validate: the mod's hooks, calls, env reads and env writes are exactly the plan's", () => {
  harness();
  const out = validate!.out;
  const field = (name: string) => out.match(new RegExp(`ctx-mod\\.js ${name}: (.*)`))?.[1] ?? `(no "${name}" line)\n${out}`;
  expect(validate!.code).toBe(0);
  expect(field("hooks").split(", ").sort()).toEqual([...HOOKS].sort());
  expect(field("calls").split(", ").map((c) => c.replace(/ \(via [^)]*\)$/, "")).sort()).toEqual(CALLS);
  expect(field("env reads").split(", ").sort()).toEqual(ENV_READS);
  expect(field("env writes")).toBe("nothing");
});

test("sandbox honoured: validate wrote its config under the temp CLAUDE_CONFIG_DIR, not ~/.claude.json", () => {
  harness();
  expect(existsSync(path.join(validate!.sandbox, "config", ".claude.json"))).toBe(true);
});

/**
 * The ctx-log mod (hooks/ctx-log.js, LWO-007 / fork #37) under Claude Code's own
 * mod test kit. It mirrors test/ctx-mod.test.ts.
 *
 * At module load this builds two temp plugins and runs them through the harness
 * (sandboxed: temp HOME and CLAUDE_CONFIG_DIR, see runClaudePluginSandboxed):
 * - the kit plugin: the real hooks/hooks.json and hooks/mods.js with both mods
 *   and status-hook.sh, plus the kit file test/mods/ctx-log.cc-test.ts, so the
 *   kit loads ctx-log the way the plugin ships it (next to ctx-mod);
 * - the validate plugin: ctx-log.js alone as its one module, so `claude plugin
 *   validate` prints ctx-log's own hooks, calls and env reads (an aggregator
 *   prints them merged with ctx-mod's).
 * Each kit title becomes one bun test below.
 *
 * The mods are read from ../hooks relative to THIS file, so the removal control
 * (ctx-log.control.test.ts) can run a copy of this file against patched copies.
 * Keep TITLES equal to the kit's titles. Needs a local claude >= 2.1.296;
 * without one every test here fails with HARNESS BROKEN; it never skips.
 */

import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type PluginRun, runClaudePluginSandboxed } from "./omt-harness";

const HOOKS_DIR = path.join(import.meta.dir, "..", "hooks");
const KIT = path.join(import.meta.dir, "mods", "ctx-log.cc-test.ts");

const TITLES = [
  "L1 a main turn writes one turn line: tokens from the last main step, window from usage()",
  "L2 a subagent turn writes its agentId and its own last step's tokens, with window null",
  "L20 a turn with no step after a turn that had usage logs tokens null",
  "L25 interleaved main and subagent steps: each loop's line has its own last step",
  "L3 a main compaction writes one compact line: trigger, before and after from the result, agentId null, the main window",
  "L4 a subagent compaction writes its agentId, before and after",
  "L5 a skipped compaction writes nothing",
  "L6 a precompute compaction writes nothing",
  "L7 a next(e) that throws is rethrown as the same error and writes nothing",
  "L8 the hook returns next(e)'s result unchanged",
  "L8b next receives the hook's input unchanged",
  "L9 no SESSION_NAME (OMT_HUB_DIR set or not): no fs call",
  "L10 SESSION_NAME with OMT_HUB_DIR also set: the line and the file use SESSION_NAME",
  "L11 HOME unset, or relative: no fs call",
  "L12 a write that throws: one warning, then no fs call, even for the rest of its own batch",
  "L13a a write that never settles holds neither turn.complete nor session.compact: both return at once",
  "L13b session.end waits for the queue up to 150 ms of hook time",
  "L13c a usage() that never answers holds turn.complete only 150 ms, and the line has window null",
  "L14 the path is <HOME>/.omt-scratch/lab-ctx/<name>-<inst>-<YYYYMMDD>.jsonl; a later UTC day opens a new file",
  "L19 a line built before midnight and queued after a newer one goes to the newer file; day D keeps all its lines",
  "L15 rotation: a line ending exactly at 4,128,768 stays, one character more goes to -2; an oversize line is written alone, in part 1 when the file is new",
  "L16 queue: 64 pending are all written, the 63 queued in one write; a 65th is dropped, the next line carries dropped:1 and the one after none",
  "L17 each write is the previous text plus the new lines, in event order",
  "L18 a session name with / and spaces is sanitised in the path, but kept as given in the line",
  "L22 a line enqueued after the first hook returned is written when the held write is released",
  "L23 a non-ASCII session name is escaped, so the line's length equals its UTF-8 byte count",
  "L24 every line carries the same 6-character base36 inst, and so does the filename",
  "L26 record writes one line with ctx-log's v/at/session/inst, in the same file as the turn lines",
  "L26b record before any ctx-log hook ran: the first event, a manual compaction, still writes its pass line",
  "L27 mixed kinds share the 64-line queue and the dropped count: 32 manual compactions (64 lines) all go out, the 33rd pair is dropped, the next line carries dropped:2",
  "L-lc with ledger-compact on: it ran (its read of now.md), complete() is the bottom’s answer, a manual compaction returns KEPT, and the lines are turn, pass/manual, compact",
];

const HOOKS = ['turn.step{turnId=/"^"/}', 'turn.complete{turnId=/"^"/}', "session.compact{trigger=manual|auto|plugin}", 'session.end{sessionId=/"^"/}'];
const ENV_READS = ["HOME", "SESSION_NAME"];
/** Everything the mod may call: fs only to write, no transcript, no process, no network. */
const CALLS = ["$.clock.now", "$.clock.sleep", "$.env.get", "$.fs.write", "$.session.usage", "$.ui.log"];
/** hooks/mods.js, byte for byte (plan v2.1 D-2). */
const MODS_JS = "// The plugin's one hooks module (Claude Code 2.1.296 loads one per plugin): it registers\n// ctx-mod (router reports), ctx-log (context-size log, #37) and ledger-compact (#66) on the\n// same `on`. A plugin's registrations nest in order, first outermost: ctx-log wraps ledger-compact.\nimport { register as registerCtxMod } from './ctx-mod.js'\nimport { register as registerCtxLog } from './ctx-log.js'\nimport { register as registerLedgerCompact } from './ledger-compact.js'\n\nexport function register(on) {\n  registerCtxMod(on)\n  registerCtxLog(on)\n  registerLedgerCompact(on)\n}\n";

// ── Build the temp plugins and run the kit (module load) ───────────────────

function makePlugin(prefix: string, files: string[], hooksJson?: string): string {
  const dir = mkdtempSync(path.join(realpathSync("/tmp"), prefix));
  for (const d of [".claude-plugin", "hooks", "tests"]) mkdirSync(path.join(dir, d));
  writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "ctx-log-kit", version: "0.0.0", description: "ctx-log kit run", author: { name: "oh-my-team" } })
  );
  for (const f of files) copyFileSync(path.join(HOOKS_DIR, f), path.join(dir, "hooks", f));
  if (hooksJson !== undefined) writeFileSync(path.join(dir, "hooks", "hooks.json"), hooksJson);
  return dir;
}

let plugin: string | null = null;
let validatePlugin: string | null = null;
let broken: string | null = null;
let kit: PluginRun | null = null;
let validate: PluginRun | null = null;
try {
  plugin = makePlugin("omt-ctx-log-kit-", ["hooks.json", "mods.js", "ctx-mod.js", "ctx-log.js", "ledger-compact.js", "status-hook.sh"]);
  copyFileSync(KIT, path.join(plugin, "tests", "ctx-log.test.ts"));
  validatePlugin = makePlugin("omt-ctx-log-val-", ["ctx-log.js"], JSON.stringify({ modules: ["./ctx-log.js"] }));
  kit = runClaudePluginSandboxed("test", plugin);
  validate = runClaudePluginSandboxed("validate", validatePlugin);
} catch (err) {
  broken = String(err);
}

afterAll(() => {
  for (const d of [plugin, validatePlugin, kit?.sandbox, validate?.sandbox]) if (d) rmSync(d, { recursive: true, force: true });
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
  const field = (name: string) => out.match(new RegExp(`ctx-log\\.js ${name}: (.*)`))?.[1] ?? `(no "${name}" line)\n${out}`;
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

test("the real hooks.json loads ./mods.js, and mods.js registers ctx-mod, ctx-log and ledger-compact", () => {
  const hooks = JSON.parse(readFileSync(path.join(HOOKS_DIR, "hooks.json"), "utf-8")) as { modules?: unknown };
  expect({ modules: hooks.modules, mods: readFileSync(path.join(HOOKS_DIR, "mods.js"), "utf-8") }).toEqual({ modules: ["./mods.js"], mods: MODS_JS });
});

/**
 * Removal control for the ctx mod's kit tests (test/ctx-mod.test.ts, WO-022).
 *
 * A green suite proves something only if it goes red when the behaviour is
 * gone. Each mutant TEXTUALLY patches hooks/ctx-mod.js in a temp copy of the
 * files the wrapper needs, runs that copy of test/ctx-mod.test.ts (which runs
 * the real `claude plugin test`, sandboxed by the harness) with a JUnit
 * report, and asserts the mustFail titles fail and the mustPass titles pass,
 * so the mutant is caught by the test meant to catch it, not by a crash.
 *
 * "HARNESS BROKEN" means the control is not measuring anything: the unmutated
 * copy failed, a patch didn't apply exactly once, a named title doesn't
 * exist, or no report was written. Fix the harness or the table; never delete
 * a mutant to go green. Adding a mutant is one table row.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

setDefaultTimeout(120_000);

const REPO = path.resolve(import.meta.dir, "..");
const COPY = ["hooks/ctx-mod.js", "hooks/hooks.json", "hooks/status-hook.sh", "test/ctx-mod.test.ts", "test/mods/ctx-mod.cc-test.ts", "test/omt-harness.ts"];
const MOD = "hooks/ctx-mod.js";
const WRAPPER = "test/ctx-mod.test.ts";

interface Mutant {
  name: string;
  /** File the patches apply to (default hooks/ctx-mod.js). */
  file?: string;
  /** Each [find, replace] must match the file exactly once. */
  patches: [find: string, replace: string][];
  mustFail: string[];
  mustPass: string[];
}

const M1a = "M1a no SESSION_NAME and no ROUTER_URL: no post";
const M1b = "M1b a non-local ROUTER_URL: no post";
const M1c = "M1c ROUTER_URL without SESSION_NAME: no post";
const M1d = "M1d a teammate process (CLAUDE_CODE_TEAMMATE) never posts";
const M1e = "M1e only http on localhost/127.0.0.1 with an explicit port and no path counts as local";
const M1f = "M1f SESSION_NAME plus a local ROUTER_URL posts once to <router>/ctx";
const M2 = "M2 tokens = input + cache_read + cache_creation of the main step; output never counts";
const M3 = "M3 a subagent's step reports the lead's context and keeps the model";
const M4 = "M4 model comes from the main step's result.usage.model, never session.model";
const M5 = "M5 /clear posts tokens 0, not the stale usage() of the ended conversation";
const M6a = "M6a an unchanged report is not sent twice, even a millisecond later";
const M6b = "M6b every /clear posts, even when the report is unchanged";
const M6c = "M6c session end for exit or other reasons posts nothing";
const M6d = "M6d /resume posts tokens null";
const M7a = "M7a a manual main-conversation compaction posts tokens null after it ran";
const M7b = "M7b a subagent's own compaction posts nothing";
const M7c = "M7c a precompute compaction posts nothing";
const M7d = "M7d a vetoed compaction posts nothing";
const M8 = "M8 running = pending + running + waiting; alive = running + idle";
const M9a = "M9a quota maps five_hour and seven_day only; an empty list gives two nulls";
const M9b = "M9b no rateLimits at all: quota null and the report still goes out";
const M10 = "M10 the wire carries exactly session, sid, at, model, ctx{tokens, window}, quota, agents";
const M11 = "M11 an agent list that is refused gives agents null; the report still goes out";
const M12a = "M12a a hung agent list holds turn.step for 150 ms of hook time, then the result passes through";
const M12b = "M12b a hung usage() holds turn.complete for 150 ms of hook time, no more";
const M13 = "M13 a POST that never settles holds no hook: step, measure and clear all return at once";
const M14a = "M14a at most 4 POSTs are in flight";
const M14b = "M14b a report skipped at the cap is sent by the next event once a slot frees";
const M15 = "M15 at is the mod's Date.now() when the event fired, never decreasing";
const M14c = "M14c a refused POST frees its slot: six refused POSTs all go out";
const M16 = "M16 a report that finishes after a newer one is dropped, and dedupe follows the newer one";
const M17 = "M17 a report the router refuses is logged once, not swallowed";
const M18 = "M18 a 404 (the session not registered yet) is not logged and leaves the warning for a real refusal";
const SANDBOX = "sandbox honoured: validate wrote its config under the temp CLAUDE_CONFIG_DIR, not ~/.claude.json";
const VALIDATE = "validate: the mod's hooks, calls, env reads and env writes are exactly the plan's";

const MUTANTS: Mutant[] = [
  {
    name: "gate-session-only: ROUTER_URL is not checked",
    patches: [["    if (!session || !isLocalUrl(router)) return\n", "    if (!session) return\n"]],
    mustFail: [M1b, M1e],
    mustPass: [M1c],
  },
  {
    name: "gate-router-only: SESSION_NAME is not checked",
    patches: [["    if (!session || !isLocalUrl(router)) return\n", "    if (!isLocalUrl(router)) return\n"]],
    mustFail: [M1c],
    mustPass: [M1b],
  },
  {
    name: "gate-ignores-teammate: a teammate process posts",
    patches: [["    if (await $.env.get('CLAUDE_CODE_TEAMMATE')) return\n", ""]],
    mustFail: [M1d],
    mustPass: [M1f],
  },
  {
    name: "url-prefix-match: any URL starting with a local host counts",
    patches: [["  let u\n  try {\n    u = new URL(s)\n", "  if (typeof s === 'string' && (s.startsWith('http://localhost') || s.startsWith('http://127.0.0.1'))) return true\n  let u\n  try {\n    u = new URL(s)\n"]],
    mustFail: [M1e],
    mustPass: [M1b],
  },
  {
    name: "url-allows-path: a path after the port counts as local",
    patches: [["    u.pathname === '/' &&\n", ""]],
    mustFail: [M1e],
    mustPass: [M1f],
  },
  {
    name: "url-allows-default-port: no explicit port counts as local",
    patches: [["    u.port !== '' &&\n", ""]],
    mustFail: [M1e],
    mustPass: [M1f],
  },
  {
    name: "formula-adds-output: output tokens count as context",
    patches: [["n(u.cache_creation_input_tokens)\n", "n(u.cache_creation_input_tokens) + n(u.output_tokens)\n"]],
    mustFail: [M2],
    mustPass: [M3],
  },
  {
    name: "formula-drops-cache-creation: cache writes are not counted",
    patches: [["n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)", "n(u.cache_read_input_tokens)"]],
    mustFail: [M2],
    mustPass: [M3],
  },
  {
    name: "subagent-as-main: a subagent's step is reported as the lead's",
    patches: [["    if (!e.agentId && result && result.usage) {\n", "    if (result && result.usage) {\n"]],
    mustFail: [M3],
    mustPass: [M2],
  },
  {
    name: "model-from-session: model comes from session.model()",
    patches: [["      if (typeof result.usage.model === 'string') model = result.usage.model\n", "      model = await $.session.model()\n"]],
    mustFail: [M4],
    mustPass: [M5],
  },
  {
    name: "clear-uses-usage: /clear posts the stale usage()",
    patches: [["report($, 0, undefined, true)", "report($, undefined, undefined, true)"]],
    mustFail: [M5, M6b],
    mustPass: [M6d],
  },
  {
    name: "no-dedupe: unchanged reports are re-sent",
    patches: [["    if (!force && key === last) return\n", ""]],
    mustFail: [M6a],
    mustPass: [M6b],
  },
  {
    name: "dedupe-includes-at: the dedupe key carries at",
    patches: [["    const key = JSON.stringify({\n      session,\n", "    const key = JSON.stringify({\n      at,\n      session,\n"]],
    mustFail: [M6a],
    mustPass: [M6b],
  },
  {
    name: "clear-no-force: a repeated /clear is deduped",
    patches: [["report($, 0, undefined, true)", "report($, 0, undefined, false)"]],
    mustFail: [M6b],
    mustPass: [M5],
  },
  {
    name: "end-any-reason-posts: every session end posts",
    patches: [["    else if (e.reason === 'resume') await bounded($, next, report($, null))\n", "    else await bounded($, next, report($, null))\n"]],
    mustFail: [M6c],
    mustPass: [M6d],
  },
  {
    name: "resume-ignored: /resume posts nothing",
    patches: [["    else if (e.reason === 'resume') await bounded($, next, report($, null))\n", ""]],
    mustFail: [M6d],
    mustPass: [M6c],
  },
  {
    name: "compact-keeps-tokens: a compaction posts the old tokens",
    patches: [["await bounded($, next, report($, null))\n    return r\n", "await bounded($, next, report($))\n    return r\n"]],
    mustFail: [M7a],
    mustPass: [M7b],
  },
  {
    name: "compact-ignores-agentId: a subagent's compaction blanks the lead",
    patches: [["!r.skip && !e.agentId && e.trigger", "!r.skip && e.trigger"]],
    mustFail: [M7b],
    mustPass: [M7a],
  },
  {
    name: "compact-on-precompute: a precompute blanks the reading",
    patches: [[" && e.trigger !== 'precompute'", ""]],
    mustFail: [M7c],
    mustPass: [M7a],
  },
  {
    name: "compact-ignores-skip: a vetoed compaction blanks the reading",
    patches: [["if (r && !r.skip && !e.agentId", "if (r && !e.agentId"]],
    mustFail: [M7d],
    mustPass: [M7a],
  },
  {
    name: "compact-before-next: the compaction post goes out before it ran",
    patches: [["    const r = await next(e)\n    if (r && !r.skip && !e.agentId && e.trigger !== 'precompute') await bounded($, next, report($, null))\n", "    if (!e.agentId && e.trigger !== 'precompute') await bounded($, next, report($, null))\n    const r = await next(e)\n"]],
    mustFail: [M7d],
    mustPass: [M7a],
  },
  {
    name: "running-excludes-waiting",
    patches: [["new Set(['pending', 'running', 'waiting'])", "new Set(['pending', 'running'])"]],
    mustFail: [M8],
    mustPass: [M9a],
  },
  {
    name: "running-excludes-pending",
    patches: [["new Set(['pending', 'running', 'waiting'])", "new Set(['running', 'waiting'])"]],
    mustFail: [M8],
    mustPass: [M9a],
  },
  {
    name: "running-counts-idle",
    patches: [["new Set(['pending', 'running', 'waiting'])", "new Set(['pending', 'running', 'waiting', 'idle'])"]],
    mustFail: [M8],
    mustPass: [M9a],
  },
  {
    name: "alive-excludes-idle",
    patches: [["    return { running, alive: running + list.filter((a) => a.status === 'idle').length }\n", "    return { running, alive: running }\n"]],
    mustFail: [M8],
    mustPass: [M9a],
  },
  {
    name: "alive-counts-ended",
    patches: [["    return { running, alive: running + list.filter((a) => a.status === 'idle').length }\n", "    return { running, alive: list.length }\n"]],
    mustFail: [M8],
    mustPass: [M9a],
  },
  {
    name: "quota-kinds-swapped",
    patches: [["? 'fiveHour' : l && l.kind === 'seven_day' ? 'sevenDay'", "? 'sevenDay' : l && l.kind === 'seven_day' ? 'fiveHour'"]],
    mustFail: [M9a],
    mustPass: [M9b],
  },
  {
    name: "quota-throws-on-missing: no rateLimits drops the report",
    patches: [["  if (!Array.isArray(limits)) return null\n", ""]],
    mustFail: [M9b],
    mustPass: [M9a],
  },
  {
    name: "wire-adds-pct: the mod sends a pct",
    patches: [["ctx: { tokens: tokens === undefined", "ctx: { pct: 0, tokens: tokens === undefined"]],
    mustFail: [M10, M2],
    mustPass: [M8],
  },
  {
    name: "wire-drops-sid: no sid on the wire",
    patches: [["      sid: await $.session.id(),\n", ""]],
    mustFail: [M10],
    mustPass: [M8],
  },
  {
    name: "agents-throw-drops-post: a refused agent list drops the report",
    patches: [["    return { running, alive: running + list.filter((a) => a.status === 'idle').length }\n  } catch {\n    return null\n  }\n", "    return { running, alive: running + list.filter((a) => a.status === 'idle').length }\n  } finally {\n    // rethrow\n  }\n"]],
    mustFail: [M11],
    mustPass: [M8],
  },
  {
    name: "no-race: reports are awaited unbounded",
    patches: [["  return Promise.race([work, $.clock.sleep(RACE_MS, next.signal ? { signal: next.signal } : undefined).catch(() => {})])\n", "  return work\n"]],
    mustFail: [M12a, M12b],
    mustPass: [M13],
  },
  {
    name: "race-longer: the bound is 151 ms",
    patches: [["const RACE_MS = 150\n", "const RACE_MS = 151\n"]],
    mustFail: [M12a, M12b],
    mustPass: [M13],
  },
  {
    name: "race-shorter: the bound is 149 ms",
    patches: [["const RACE_MS = 150\n", "const RACE_MS = 149\n"]],
    mustFail: [M12a],
    mustPass: [M13],
  },
  {
    name: "fetch-awaited: the POST is awaited",
    patches: [["      posted = $.http.fetch(", "      posted = await $.http.fetch("]],
    mustFail: [M13, M14a],
    mustPass: [M2],
  },
  {
    name: "no-inflight-cap: POSTs pile up",
    patches: [["    if (inflight >= MAX_INFLIGHT) return // key not advanced: the next event re-sends\n", ""]],
    mustFail: [M14a, M14b],
    mustPass: [M13],
  },
  {
    name: "cap-advances-dedupe: a capped report is marked sent",
    patches: [["    if (inflight >= MAX_INFLIGHT) return // key not advanced: the next event re-sends\n    last = key\n", "    last = key\n    if (inflight >= MAX_INFLIGHT) return // key not advanced: the next event re-sends\n"]],
    mustFail: [M14b],
    mustPass: [M14a],
  },
  {
    name: "inflight-never-released: a settled POST keeps its slot",
    patches: [["        inflight--\n", ""]],
    mustFail: [M14b],
    mustPass: [M14a],
  },
  {
    name: "cap-5: five POSTs in flight",
    patches: [["const MAX_INFLIGHT = 4\n", "const MAX_INFLIGHT = 5\n"]],
    mustFail: [M14a, M14b],
    mustPass: [M13],
  },
  {
    name: "cap-3: three POSTs in flight",
    patches: [["const MAX_INFLIGHT = 4\n", "const MAX_INFLIGHT = 3\n"]],
    mustFail: [M14a, M14b],
    mustPass: [M13],
  },
  {
    name: "at-from-zero: at is not the clock",
    patches: [["  const at = Date.now()\n", "  const at = 0\n"]],
    mustFail: [M15],
    mustPass: [M10],
  },
  {
    name: "out-of-order-advances: a late, older report replaces the newer one",
    patches: [["    if (at < lastAt) return // a newer report already went out\n", ""]],
    mustFail: [M16],
    mustPass: [M6a],
  },
  {
    name: "at-late: at is taken after the reads",
    patches: [["async function report($, tokens, measured, force) {\n  const at = Date.now()\n", "async function report($, tokens, measured, force) {\n"], ["    if (at < lastAt) return // a newer report already went out\n", "    const at = Date.now()\n    if (at < lastAt) return // a newer report already went out\n"]],
    mustFail: [M15],
    mustPass: [M10],
  },
  {
    name: "release-only-on-success: a refused POST keeps its slot",
    patches: [["      .catch(() => {})\n      .finally(() => {\n        inflight--\n      })\n", "      .then(() => {\n        inflight--\n      }, () => {})\n"]],
    mustFail: [M14c],
    mustPass: [M14b],
  },
  {
    name: "url-allows-hash: a #fragment after the port counts as local",
    patches: [["    !u.search &&\n    !u.hash\n", "    !u.search\n"]],
    mustFail: [M1e],
    mustPass: [M1f],
  },
  {
    name: "reads-transcript: the mod calls $.session.messages()",
    patches: [["    const u = measured ?? (await $.session.usage())\n", "    const u = measured ?? (await $.session.usage())\n    if (force === 'never') await $.session.messages()\n"]],
    mustFail: [VALIDATE],
    mustPass: [M2],
  },
  {
    name: "refusal-swallowed: a refused report is not logged",
    patches: [["        if (res && !res.ok && res.status !== 404) warnOnce('router answered ' + res.status)\n", ""]],
    mustFail: [M17],
    mustPass: [M14c],
  },
  {
    name: "hooks-json-no-modules: the real hooks.json doesn't load the mod",
    file: "hooks/hooks.json",
    patches: [["  \"modules\": [\"./ctx-mod.js\"],\n", ""]],
    mustFail: [M2, VALIDATE],
    mustPass: [SANDBOX],
  },
  {
    name: "warn-on-404: the expected startup 404 uses up the one warning",
    patches: [["res.status !== 404", "res.status !== 0"]],
    mustFail: [M18],
    mustPass: [M17],
  },
];

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface SuiteResult {
  exitCode: number;
  passed: string[];
  failed: string[];
  skipped: string[];
  output: string;
}

/** Copy the wrapper's files into a temp tree, patch the mod, run the wrapper. */
function runWrapper(patches: [string, string][], file: string = MOD): SuiteResult {
  const dir = mkdtempSync(path.join(realpathSync("/tmp"), "omt-ctx-mod-control-"));
  tempDirs.push(dir);
  for (const rel of COPY) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    copyFileSync(path.join(REPO, rel), path.join(dir, rel));
  }
  const target = path.join(dir, file);
  let source = readFileSync(target, "utf-8");
  for (const [find, replace] of patches) {
    const n = countOccurrences(source, find);
    if (n !== 1) {
      throw new Error(`HARNESS BROKEN: patch on ${file} matched ${n} times (expected exactly 1): ${JSON.stringify(find.slice(0, 80))}`);
    }
    source = source.replace(find, replace);
  }
  writeFileSync(target, source);
  const report = path.join(dir, "junit.xml");
  const proc = Bun.spawnSync([process.execPath, "test", `./${WRAPPER}`, "--reporter=junit", `--reporter-outfile=${report}`], {
    cwd: dir,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = proc.stdout.toString() + proc.stderr.toString();
  if (!existsSync(report)) throw new Error(`HARNESS BROKEN: no JUnit report written (exit ${proc.exitCode})\n${output}`);
  const xml = readFileSync(report, "utf-8");
  const passed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const m of xml.matchAll(/<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const title = unescapeXml(m[1]);
    const body = m[2] ?? "";
    if (body.includes("<failure") || body.includes("<error")) failed.push(title);
    else if (body.includes("<skipped")) skipped.push(title);
    else passed.push(title);
  }
  return { exitCode: proc.exitCode ?? -1, passed, failed, skipped, output };
}

describe("ctx-mod removal control", () => {
  let baseline: string[] = [];

  test("baseline: the unmutated copy passes (else HARNESS BROKEN)", () => {
    const r = runWrapper([]);
    if (r.exitCode !== 0 || r.failed.length > 0 || r.passed.length === 0) {
      throw new Error(`HARNESS BROKEN: unmutated wrapper did not pass cleanly (exit ${r.exitCode})\n${r.output}`);
    }
    if (r.skipped.length > 0) throw new Error(`HARNESS BROKEN: skipped tests prove nothing: ${JSON.stringify(r.skipped)}`);
    baseline = r.passed;
  });

  test("every title named by a mutant exists (else HARNESS BROKEN)", () => {
    expect(baseline.length).toBeGreaterThan(0);
    const missing = MUTANTS.flatMap((m) => [...m.mustFail, ...m.mustPass]).filter((t) => !baseline.includes(t));
    if (missing.length > 0) throw new Error(`HARNESS BROKEN: mutant table names tests that don't exist: ${JSON.stringify(missing)}`);
  });

  for (const m of MUTANTS) {
    test(`mutant caught: ${m.name}`, () => {
      const r = runWrapper(m.patches, m.file);
      expect(r.exitCode).not.toBe(0);
      for (const title of m.mustFail) expect(r.failed).toContain(title);
      for (const title of m.mustPass) expect(r.passed).toContain(title);
    });
  }
});

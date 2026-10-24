/**
 * Removal control for the ctx-log mod's kit tests (test/ctx-log.test.ts,
 * LWO-007 / fork #37). It mirrors test/ctx-mod.control.test.ts.
 *
 * Each mutant TEXTUALLY patches hooks/ctx-log.js (or hooks/mods.js) in a temp
 * copy of the files the wrapper needs, runs that copy of test/ctx-log.test.ts
 * (which runs the real `claude plugin test` and `claude plugin validate`,
 * sandboxed by the harness) with a JUnit report, and asserts the mustFail
 * titles fail and the mustPass titles pass, so the mutant is caught by the test
 * meant to catch it, not by a crash. Left out as equivalent mutants (the host
 * makes them no-ops; measured, LWO-007 DONE): X8 (result copied: results and
 * inputs are handed on as copies anyway) and X7 (a swallowed throw: the host
 * skips a hook that returns nothing and the throw beneath still arrives). X32 (teammate) went with the field, which the host never
 * sets. "HARNESS BROKEN" means the control measures nothing. Never delete a
 * mutant to go green.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

setDefaultTimeout(120_000);

const REPO = path.resolve(import.meta.dir, "..");
const COPY = ["hooks/ctx-log.js", "hooks/ctx-mod.js", "hooks/ledger-compact.js", "hooks/mods.js", "hooks/hooks.json", "hooks/status-hook.sh", "test/ctx-log.test.ts", "test/mods/ctx-log.cc-test.ts", "test/omt-harness.ts"];
const MOD = "hooks/ctx-log.js";
const WRAPPER = "test/ctx-log.test.ts";

interface Mutant {
  name: string;
  /** File the patches apply to (default hooks/ctx-log.js). */
  file?: string;
  /** Each [find, replace] must match the file exactly once. */
  patches: [find: string, replace: string][];
  mustFail: string[];
  mustPass: string[];
}

const T1 = "L1 a main turn writes one turn line: tokens from the last main step, window from usage()";
const T2 = "L2 a subagent turn writes its agentId and its own last step's tokens, with window null";
const T20 = "L20 a turn with no step after a turn that had usage logs tokens null";
const T25 = "L25 interleaved main and subagent steps: each loop's line has its own last step";
const T3 = "L3 a main compaction writes one compact line: trigger, before and after from the result, agentId null, the main window";
const T4 = "L4 a subagent compaction writes its agentId, before and after";
const T5 = "L5 a skipped compaction writes nothing";
const T6 = "L6 a precompute compaction writes nothing";
const T7 = "L7 a next(e) that throws is rethrown as the same error and writes nothing";
const T8 = "L8 the hook returns next(e)'s result unchanged";
const T8b = "L8b next receives the hook's input unchanged";
const T9 = "L9 no SESSION_NAME (OMT_HUB_DIR set or not): no fs call";
const T10 = "L10 SESSION_NAME with OMT_HUB_DIR also set: the line and the file use SESSION_NAME";
const T11 = "L11 HOME unset, or relative: no fs call";
const T12 = "L12 a write that throws: one warning, then no fs call, even for the rest of its own batch";
const T13a = "L13a a write that never settles holds neither turn.complete nor session.compact: both return at once";
const T13b = "L13b session.end waits for the queue up to 150 ms of hook time";
const T13c = "L13c a usage() that never answers holds turn.complete only 150 ms, and the line has window null";
const T14 = "L14 the path is <HOME>/.omt-scratch/lab-ctx/<name>-<inst>-<YYYYMMDD>.jsonl; a later UTC day opens a new file";
const T19 = "L19 a line built before midnight and queued after a newer one goes to the newer file; day D keeps all its lines";
const T15 = "L15 rotation: a line ending exactly at 4,128,768 stays, one character more goes to -2; an oversize line is written alone, in part 1 when the file is new";
const T16 = "L16 queue: 64 pending are all written, the 63 queued in one write; a 65th is dropped, the next line carries dropped:1 and the one after none";
const T17 = "L17 each write is the previous text plus the new lines, in event order";
const T18 = "L18 a session name with / and spaces is sanitised in the path, but kept as given in the line";
const T22 = "L22 a line enqueued after the first hook returned is written when the held write is released";
const T23 = "L23 a non-ASCII session name is escaped, so the line's length equals its UTF-8 byte count";
const T24 = "L24 every line carries the same 6-character base36 inst, and so does the filename";
const VALIDATE = "validate: the mod's hooks, calls, env reads and env writes are exactly the plan's";
const MODSJS = "the real hooks.json loads ./mods.js, and mods.js registers ctx-mod, ctx-log and ledger-compact";

const T26 = "L26 record writes one line with ctx-log's v/at/session/inst, in the same file as the turn lines";
const T27 = "L27 mixed kinds share the 64-line queue and the dropped count: 32 manual compactions (64 lines) all go out, the 33rd pair is dropped, the next line carries dropped:2";
const TLC = "L-lc with ledger-compact on: it ran (its read of now.md), complete() is the bottom\u2019s answer, a manual compaction returns KEPT, and the lines are turn, pass/manual, compact";
const MUTANTS: Mutant[] = [
  {
    name: "X44 (plan X38) ledger-compact-extra-line: its turn.complete records one extra line on every turn (#66)",
    file: "hooks/ledger-compact.js",
    patches: [["  on('turn.complete', { turnId: /./ }, async ($, e, next) => {\n    const r = await next(e)\n", "  on('turn.complete', { turnId: /./ }, async ($, e, next) => {\n    const r = await next(e)\n    log($, { kind: 'pass', reason: 'x38' })\n"]],
    mustFail: [TLC],
    mustPass: [T9],
  },
  {
    name: "X45 (plan X59) record-without-stamps: record writes a line with no v/at/session/inst (#66)",
    patches: [["  const line = { v: 1, at, session: g.name, inst, agentId: null }\n", "  const line = { agentId: null }\n"]],
    mustFail: [T26],
    mustPass: [T1],
  },
  {
    name: "X46 (plan X60b) record-private-queue: record queues past MAX_PENDING and the dropped count (#66)",
    patches: [["  enqueue($, g, line)\n  return !off", "  queue.push({ day: utcDay(line.at), text: ascii(line) + '\\n' })\n  if (!draining) draining = drain($, g)\n  return !off"]],
    mustFail: [T27],
    mustPass: [T1],
  },
  {
    name: "X1 turn-not-logged: turn.complete enqueues nothing",
    patches: [["      enqueue($, g, { v: 1, at, session: g.name, inst, agentId: e.agentId ?? null, kind: 'turn', tokens, window })\n", ""]],
    mustFail: [T1, T2, T3, T4, T10, T12, T13b, T13c, T14, T17, T18, T19, T20, T22, T23, T25],
    mustPass: [T5],
  },
  {
    name: "X2 before-after-swapped: a compact line's before and after trade places",
    patches: [["before: r.tokensBefore ?? null,\n          after: r.tokensAfter ?? null,", "before: r.tokensAfter ?? null,\n          after: r.tokensBefore ?? null,"]],
    mustFail: [T3, T4],
    mustPass: [T1],
  },
  {
    name: "X3 home-guard-removed: a write is attempted with no usable HOME",
    patches: [["  if (typeof home !== 'string' || !home.startsWith('/')) return null\n", ""]],
    mustFail: [T11],
    mustPass: [T1],
  },
  {
    name: "X4 home-relative-allowed: only an unset HOME is refused",
    patches: [["  if (typeof home !== 'string' || !home.startsWith('/')) return null\n", "  if (!home) return null\n"]],
    mustFail: [T11],
    mustPass: [T1],
  },
  {
    name: "X5 failure-not-disabling: a failed write is retried at the next event",
    patches: [["        off = true\n", ""]],
    mustFail: [T12],
    mustPass: [T1],
  },
  {
    name: "X6 write-blocks-turn: turn.complete waits for the queue",
    patches: [["      enqueue($, g, { v: 1, at, session: g.name, inst, agentId: e.agentId ?? null, kind: 'turn', tokens, window })\n", "      enqueue($, g, { v: 1, at, session: g.name, inst, agentId: e.agentId ?? null, kind: 'turn', tokens, window })\n      await draining\n"]],
    mustFail: [T12, T13a, T13b, T22],
    mustPass: [T5],
  },
  {
    name: "X9 instructions-rewrite: next gets other instructions",
    patches: [["    const r = await next(e)\n    // A second guard", "    const r = await next({ ...e, instructions: 'x' })\n    // A second guard"]],
    mustFail: [T8b],
    mustPass: [T3],
  },
  {
    name: "X10 messages-trim: next gets fewer messages",
    patches: [["    const r = await next(e)\n    // A second guard", "    const r = await next({ ...e, messages: e.messages.slice(1) })\n    // A second guard"]],
    mustFail: [T3, T4, T8b, T15, T16, T17, T19, T22],
    mustPass: [T1],
  },
  {
    name: "X11 veto: the hook skips the compaction instead of handing it on",
    patches: [["    const r = await next(e)\n    // A second guard", "    const r = { skip: 'x' }\n    // A second guard"]],
    mustFail: [T3, T4, T7, T8, T8b, T15, T16, T17, T19, T22],
    mustPass: [T1],
  },
  {
    name: "X12 change-in-place: the hook changes the result's tokensAfter",
    patches: [["    const r = await next(e)\n    // A second guard", "    const r = await next(e)\n    if (r) r.tokensAfter = 0\n    // A second guard"]],
    mustFail: [T3, T4, T8],
    mustPass: [T1],
  },
  {
    name: "X13 precompute-logged: the matcher and the code both let precompute through",
    patches: [["{ trigger: ['manual', 'auto', 'plugin'] }", "{ trigger: ['manual', 'auto', 'plugin', 'precompute'] }"], [" && e.trigger !== 'precompute') {", ") {"]],
    mustFail: [T6, VALIDATE],
    mustPass: [T3],
  },
  {
    name: "X14 skip-logged: a skipped compaction is logged",
    patches: [["    if (r && !r.skip && e.trigger", "    if (r && e.trigger"]],
    mustFail: [T5],
    mustPass: [T3],
  },
  {
    name: "X15 subagent-tokens-from-usage: a subagent's tokens come from usage()",
    patches: [["    const tokens = steps.has(loop) ? steps.get(loop) : null\n", "    const tokens = e.agentId ? (await $.session.usage()).context.tokens : steps.has(loop) ? steps.get(loop) : null\n"]],
    mustFail: [T2, T25],
    mustPass: [T1],
  },
  {
    name: "X16 subagent-window-from-usage: a subagent's line takes the main window",
    patches: [["      const window = e.agentId ? null : await bounded($, next, windowOf($))\n", "      const window = await bounded($, next, windowOf($))\n"]],
    mustFail: [T2],
    mustPass: [T1],
  },
  {
    name: "X17 rotate-at-limit: a line ending exactly at the limit rotates",
    patches: [["w.text.length + text.length > ROTATE_BYTES", "w.text.length + text.length >= ROTATE_BYTES"]],
    mustFail: [T15],
    mustPass: [T14],
  },
  {
    name: "X18 rotate-one-late: a line one past the limit stays",
    patches: [["w.text.length + text.length > ROTATE_BYTES", "w.text.length + text.length > ROTATE_BYTES + 1"]],
    mustFail: [T15],
    mustPass: [T14],
  },
  {
    name: "X19 queue-65: 65 lines may wait",
    patches: [["const MAX_PENDING = 64", "const MAX_PENDING = 65"]],
    mustFail: [T16],
    mustPass: [T1],
  },
  {
    name: "X20 queue-63: 63 lines may wait",
    patches: [["const MAX_PENDING = 64", "const MAX_PENDING = 63"]],
    mustFail: [T16],
    mustPass: [T1],
  },
  {
    name: "X21 no-inst-in-path: the file name has no instance id",
    patches: [["${safe}-${inst}-${day}", "${safe}-${day}"]],
    mustFail: [T14, T24],
    mustPass: [T1],
  },
  {
    name: "X22 hub-fallback: no SESSION_NAME but OMT_HUB_DIR logs as hub",
    patches: [["  const name = await $.env.get('SESSION_NAME')\n", "  const name = (await $.env.get('SESSION_NAME')) || ((await $.env.get('OMT_HUB_DIR')) ? 'hub' : '')\n"]],
    mustFail: [T9, VALIDATE],
    mustPass: [T10],
  },
  {
    name: "X23 mods-js-without-ctx-log: mods.js no longer registers ctx-log",
    file: "hooks/mods.js",
    patches: [["  registerCtxLog(on)\n", ""]],
    mustFail: [T1, T2, T3, T4, T10, T12, T13a, T13b, T13c, T14, T15, T16, T17, T18, T19, T20, T22, T23, T24, T25, MODSJS],
    mustPass: [VALIDATE],
  },
  {
    name: "X24 end-no-wait: session.end does not wait for the queue",
    patches: [["    if (draining) await bounded($, next, draining)\n", ""]],
    mustFail: [T13b],
    mustPass: [T13a],
  },
  {
    name: "X25 end-unbounded: session.end waits for the queue without a bound",
    patches: [["    if (draining) await bounded($, next, draining)\n", "    if (draining) await draining\n"]],
    mustFail: [T13b],
    mustPass: [T13a],
  },
  {
    name: "X26 usage-no-race: turn.complete waits for usage() without a bound",
    patches: [["await bounded($, next, windowOf($))", "await windowOf($)"]],
    mustFail: [T13c, T19],
    mustPass: [T13a],
  },
  {
    name: "X27 day-from-at: a late line reopens the older day's file",
    patches: [["      const d = day > w.day ? day : w.day\n", "      const d = day\n"]],
    mustFail: [T19],
    mustPass: [T14],
  },
  {
    name: "X28 day-never-switches: the first day's file is used forever",
    patches: [["      const d = day > w.day ? day : w.day\n", "      const d = w.day || day\n"]],
    mustFail: [T14, T15, T19],
    mustPass: [T1],
  },
  {
    name: "X29 write-only-line: each write holds only the new lines",
    patches: [["    let w = { ...file, dirty: false }\n", "    let w = { ...file, text: '', dirty: false }\n"]],
    mustFail: [T3, T4, T15, T16, T17, T19, T20, T22, T25],
    mustPass: [T5],
  },
  {
    name: "X30 no-sanitiser: the session name goes into the path as given",
    patches: [["  const safe = g.name.replace(/[^A-Za-z0-9._-]/g, '_')\n", "  const safe = g.name\n"]],
    mustFail: [T18],
    mustPass: [T1],
  },
  {
    name: "X31 stale-step-cache: a loop's step tokens survive its turn",
    patches: [["    steps.delete(loop)\n", ""]],
    mustFail: [T20],
    mustPass: [T1],
  },
  {
    name: "X33 no-escape: non-ASCII goes out raw",
    patches: [["  return JSON.stringify(obj).replace(", "  return JSON.stringify(obj) || ''.replace("]],
    mustFail: [T23],
    mustPass: [T1],
  },
  {
    name: "X34 drop-while-inflight: lines queued during a write are lost",
    patches: [["    inflight = 0\n  }\n  draining = null", "    queue = []\n    inflight = 0\n  }\n  draining = null"]],
    mustFail: [T16, T22],
    mustPass: [T1],
  },
  {
    name: "X35 inst-missing-in-line: turn lines carry no inst",
    patches: [["      enqueue($, g, { v: 1, at, session: g.name, inst, agentId: e.agentId ?? null, kind: 'turn', tokens, window })\n", "      enqueue($, g, { v: 1, at, session: g.name, agentId: e.agentId ?? null, kind: 'turn', tokens, window })\n"]],
    mustFail: [T14, T24],
    mustPass: [T1],
  },
  {
    name: "X36 first-step-wins: a loop keeps its first step's tokens",
    patches: [["    steps.set(e.agentId ?? '', result && result.usage ? contextTokens(result.usage) : null)\n", "    if (!steps.has(e.agentId ?? '')) steps.set(e.agentId ?? '', result && result.usage ? contextTokens(result.usage) : null)\n"]],
    mustFail: [T1, T25],
    mustPass: [T3],
  },
  {
    name: "X37 shared-key: main and subagent steps share one entry",
    patches: [["    steps.set(e.agentId ?? '', result", "    steps.set('', result"], ["    const loop = e.agentId ?? ''\n", "    const loop = ''\n"]],
    mustFail: [T25],
    mustPass: [T3],
  },
  {
    name: "X38 dropped-not-reset: every later line repeats the drop count",
    patches: [["    line.dropped = dropped\n    dropped = 0\n", "    line.dropped = dropped\n"]],
    mustFail: [T16],
    mustPass: [T1],
  },
  {
    name: "X39 compact-window-null: a main compact line has no window",
    patches: [["          window: e.agentId ? null : lastWindow,\n", "          window: null,\n"]],
    mustFail: [T3],
    mustPass: [T1],
  },
  {
    name: "X40 last-window-not-set: the main window is never remembered",
    patches: [["    lastWindow = w\n", ""]],
    mustFail: [T3],
    mustPass: [T1],
  },
  {
    name: "X41 subagent-compact-window: a subagent compact line takes the main window",
    patches: [["          window: e.agentId ? null : lastWindow,\n", "          window: lastWindow,\n"]],
    mustFail: [T4],
    mustPass: [T1],
  },
  {
    name: "X42 no-break-after-failure: the rest of a failed batch is still written",
    patches: [["        break\n", ""]],
    mustFail: [T12],
    mustPass: [T1],
  },
  {
    name: "X43 oversize-first-to-part-2: an oversize first line skips part 1",
    patches: [["      if (w.text.length > 0 && w.text.length + text.length > ROTATE_BYTES) {", "      if (w.text.length + text.length > ROTATE_BYTES) {"]],
    mustFail: [T15],
    mustPass: [T14],
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
  const dir = mkdtempSync(path.join(realpathSync("/tmp"), "omt-ctx-log-control-"));
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

describe("ctx-log removal control", () => {
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

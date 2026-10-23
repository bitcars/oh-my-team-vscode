/**
 * Removal control for test/review-brief.test.ts (LWO-017, fork #36; plan v2 §7 as amended by v2.1 A4 and v2.2 A8).
 *
 * Each mutant breaks one rule in a temp copy of the checkout, runs the whole suite there
 * (JUnit report), and asserts that its mustFail titles fail with the expected text, while
 * every other title (the derived mustPass) still passes. The control prints, per mutant, the
 * mustPass titles that ran green.
 *
 * "HARNESS BROKEN" means the control measures nothing: the unmutated copy is not 47/47 with no
 * skips and no repeated title, an anchor matched the wrong number of times, a named title does not
 * exist, or no report was written. Fix the table or the anchor; never delete a mutant to go green.
 * If a mutant's red set differs from the plan's table, stop and report it before changing the table.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

setDefaultTimeout(300_000);

const REPO = path.resolve(import.meta.dir, "..");
const ROOT = mkdtempSync(path.join(realpathSync("/tmp"), "review-brief-control-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const SUITE = "test/review-brief.test.ts";
const COPY = ["agents", "skills", "test", "package.json", ".gitignore"];
const EXPECTED_TOTAL = 47;

const R = "agents/reviewer.md";
const S = "agents/security-auditor.md";
const K = "skills/review-work/SKILL.md";
const Y = "agents/sisyphus.md";
const A = "agents/atlas.md";
const BRIEF3 = [R, S, K];
const STUCK3 = [Y, A, K];

// ── mutation primitives (each throws HARNESS BROKEN unless its anchor count is exact) ──

type Edit = (dir: string, env: Record<string, string>) => void;

function count(h: string, n: string): number {
  let c = 0;
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) c++;
  return c;
}

function patchAll(file: string, find: string, replace: string, expected: number): Edit {
  return (dir) => {
    const p = path.join(dir, file);
    const s = readFileSync(p, "utf-8");
    const n = count(s, find);
    if (n !== expected) throw new Error(`HARNESS BROKEN: patch on ${file} matched ${n} times, expected ${expected}: ${JSON.stringify(find.slice(0, 80))}`);
    writeFileSync(p, s.split(find).join(replace));
  };
}

const patch = (file: string, find: string, replace: string): Edit => patchAll(file, find, replace, 1);
const each = (files: string[], find: string, replace: string): Edit[] => files.map((f) => patch(f, find, replace));

function setEnv(key: string, value: () => string): Edit {
  return (_dir, env) => {
    env[key] = value();
  };
}

// ── anchors (the plan's text, as inserted) ──

const block = (f: string, name: string): string => {
  const s = readFileSync(path.join(REPO, f), "utf-8");
  const i = s.indexOf(`<!-- ${name}:start -->\n`);
  const end = `<!-- ${name}:end -->\n`;
  const j = s.indexOf(end);
  if (i < 0 || j < i) throw new Error(`HARNESS BROKEN: no ${name} block in ${f}`);
  return s.slice(i, j + end.length);
};
const BRIEF = block(R, "review-brief");
const STUCK = block(Y, "stuck-rule");
const HUB = block(Y, "hub-order");
const lineOf = (rgn: string, n: number) => rgn.split("\n")[n]; // line n without markers (1-based)
const POINTER_PATH = "`$OMT_PLUGIN_DIR/skills/review-work/SKILL.md`";
const ROUTE_LINE = "If TeamCreate is not in your tool list, spawn each reviewer with Agent and `run_in_background: true`, with no team_name. The stuck rule in Step 5 is written for that route.";
const PLACEHOLDER = "  [PASTE THE BRIEF RULES BLOCK FROM ABOVE HERE]\n";
const STOPPED = "A reviewer stopped by this rule counts as completed with verdict FAIL (stuck).\n";
const RULE5_START = "\n5. **Stuck reviewers**: apply the rule below. ";
const POINTER_START = "When you spawn an oracle, explorer or hephaestus as a reviewer";
const ATLAS_LINE_START = "- If your prompt starts with `HUB-RUN ORDER`";
const SYS_TITLE = "# Sisyphus - Autonomous Orchestrator\n";

function lineStarting(f: string, start: string): string {
  const s = readFileSync(path.join(REPO, f), "utf-8");
  const hits = s.split("\n").filter((l) => l.startsWith(start));
  if (hits.length !== 1) throw new Error(`HARNESS BROKEN: ${hits.length} lines in ${f} start with ${JSON.stringify(start)}`);
  return hits[0];
}
const RULE5_LINE = lineStarting(Y, RULE5_START.slice(1));
const POINTER_LINE = lineStarting(A, POINTER_START);
const ATLAS_LINE = lineStarting(A, ATLAS_LINE_START);

// titles
const B1 = "B1 brief markers: exactly one start then one end marker in reviewer.md, security-auditor.md and SKILL.md";
const B2 = "B2 brief identical: the three marked blocks are byte-identical";
const B30 = "B3.0 brief text: the reviewer.md block equals the plan text, in order";
const briefNames = ["title", "one simple command", "never use", "two levels", "one call per step", "working directory and timeout", "time budget", "partial is FAIL", "the 20 minutes is set here"];
const B3 = (n: number) => `B3.${n} brief line ${n}: ${briefNames[n - 1]}`;
const B4 = "B4 brief numbers: the minute numbers are 2, 20, 19, 20, 20 in order";
const B5 = "B5 brief placement: after the Output Format closing fence and before ## Constraints in reviewer.md and security-auditor.md; in SKILL.md Step 4 after the paste line";
const B6 = "B6 placeholders: exactly one per Agent( segment, before its Output: line, five in all";
const B7 = "B7 partial tag: both Output Formats carry <partial>true or false</partial> right after <verdict>";
const B8 = "B8 route line: SKILL.md Step 4 has the no-TeamCreate route line right after the brief block";
const T1 = "T1 stuck markers: one block each in sisyphus.md (after the rule 5 line), atlas.md (Phase 3, after the pointer line) and SKILL.md (Step 5, after the Do-NOT-deliver line)";
const T2 = "T2 stuck identical: the three marked blocks are byte-identical";
const T30 = "T3.0 stuck text: the sisyphus.md block equals the plan text, in order";
const stuckNames = ["title", "step 0", "step 1", "step 2", "step 3", "step 4", "step 5", "age, thresholds, kill and report"];
const T3 = (n: number) => `T3.${n} stuck line ${n}: ${stuckNames[n - 1]}`;
const T4 = "T4 stuck numbers: every digit run in the block, in order, is 36,0,1,0,1,300,2,3,4,1,5,4,1,2,3,300,299,5,300000,1000,60,120000,0";
const T5 = "T5 Step 5 lines: the stopped-is-FAIL and partial-is-FAIL lines follow the stuck block in SKILL.md";
const T6 = 'T6 no respawn: none of the five edited files contains "respawn"';
const T7 = "T7 pointer: sisyphus rule 5 and atlas Phase 3 carry the exact pointer sentence with the $OMT_PLUGIN_DIR path";
const H1 = "H1 hub-order section: one ## Hub-run orders between ## Communication style and ## Hard constraints in sisyphus.md, holding one marked block";
const H20 = "H2.0 hub-order text: the block equals the plan text, in order";
const hubNames = ["hub-run definition", "no ask, escalate or reply question", "decisions to the hub", "a relayed ruling is the tap", "forward verbatim with ts", "put the marker first", "the marker line", "outside a hub-run order"];
const H2 = (n: number) => `H2.${n} hub-order line ${n}: ${hubNames[n - 1]}`;
const H3 = "H3 atlas line: the HUB-RUN ORDER line sits directly after the :86 line under ## Communication in atlas.md";
const H4 = "H4 marker key: the sisyphus marker line starts with the HUB-RUN ORDER key the atlas line names";
const G1 = "G1 gitignore: .gitignore has the line .sisyphus/";
const G2 = "G2 base absent: git -C $REVIEW_BRIEF_BASE_REPO show 9d7c81a:<file> exits 0 with output for each of the five files, and none has a marker or a block line";
const G3 = "G3 outside blocks: each edited file with its inserts removed equals 9d7c81a (inserted text only; a deleted base blank line before an eat-blank insert is not detected, §9.14)";

interface Mutant {
  name: string;
  edits: Edit[];
  mustFail: string[];
  mustFailWith: [string, string];
}

const v1Line5 = "- For a multi-step offline check, Write a script file in your scratch dir and run it as one call: `bash <file> </dev/null`.";
const sl = (n: number) => lineOf(STUCK, n);
const hl = (n: number) => lineOf(HUB, n);

const MUTANTS: Mutant[] = [
  { name: "M1 reviewer.md budget 20 -> 19", edits: [patch(R, "Time budget: 20 minutes", "Time budget: 19 minutes")], mustFail: [B2, B30, B3(7), B4], mustFailWith: [B4, "minute numbers 2,19,19,20,20"] },
  { name: "M2 brief budget 20 -> 21 everywhere", edits: BRIEF3.map((f) => patchAll(f, "20 minutes", "21 minutes", 3)), mustFail: [B30, B3(7), B3(9), B4], mustFailWith: [B4, "minute numbers 2,21,19,21,21"] },
  { name: "M3 brief At 19 -> At 18", edits: each(BRIEF3, "At 19 minutes", "At 18 minutes"), mustFail: [B30, B3(7), B4], mustFailWith: [B4, "minute numbers 2,20,18,20,20"] },
  { name: "M4 security-auditor.md one word (wallclock)", edits: [patch(S, "wall clock", "wallclock")], mustFail: [B2], mustFailWith: [B2, "wallclock"] },
  { name: "M5 brief never-use line deleted", edits: each(BRIEF3, lineOf(BRIEF, 3) + "\n", ""), mustFail: [B30, B3(3)], mustFailWith: [B3(3), "occurs 0 times"] },
  { name: "M6 brief bash -c allowed", edits: each(BRIEF3, "Never use `bash -c` or `sh -c`,", "You may use `bash -c` or `sh -c`, but never"), mustFail: [B30, B3(3)], mustFailWith: [B30, "You may use"] },
  { name: "M7 brief v1 Write-a-script line back", edits: each(BRIEF3, lineOf(BRIEF, 5), v1Line5), mustFail: [B30, B3(5)], mustFailWith: [B30, "Write a script file"] },
  { name: "M8 brief partial-is-FAIL line deleted", edits: each(BRIEF3, lineOf(BRIEF, 8) + "\n", ""), mustFail: [B30, B3(8)], mustFailWith: [B3(8), "occurs 0 times"] },
  { name: "M9 brief three levels fine", edits: each(BRIEF3, "Three levels are banned", "Three levels are fine"), mustFail: [B30, B3(4)], mustFailWith: [B30, "Three levels are fine"] },
  { name: "M10 SKILL.md brief removed", edits: [patch(K, "\n" + BRIEF, "")], mustFail: [B1, B2, B5, B8], mustFailWith: [B1, "review-brief start markers 0"] },
  { name: "M11 SKILL.md brief moved to Step 5", edits: [patch(K, "\n" + BRIEF, ""), patch(K, "## Step 5: Collect verdicts and synthesize\n", "## Step 5: Collect verdicts and synthesize\n\n" + BRIEF)], mustFail: [B5, B8], mustFailWith: [B5, "the brief (Step 4) is not between"] },
  { name: "M12 SKILL.md template 5 placeholder removed", edits: [patch(K, PLACEHOLDER + "  Output: <verdict>PASS/FAIL</verdict> <discovered_context>", "  Output: <verdict>PASS/FAIL</verdict> <discovered_context>")], mustFail: [B6], mustFailWith: [B6, "has 0 placeholder lines"] },
  {
    name: "M13 SKILL.md template 5 placeholder moved into template 1",
    edits: [
      patch(K, PLACEHOLDER + "  Output: <verdict>PASS/FAIL</verdict> <discovered_context>", "  Output: <verdict>PASS/FAIL</verdict> <discovered_context>"),
      patch(K, PLACEHOLDER + "  Output: <verdict>PASS/FAIL</verdict> <summary>1-3 sentences</summary>", PLACEHOLDER + PLACEHOLDER + "  Output: <verdict>PASS/FAIL</verdict> <summary>1-3 sentences</summary>"),
    ],
    mustFail: [B6],
    mustFailWith: [B6, "has 2 placeholder lines"],
  },
  { name: "M14 reviewer.md line added after the brief end marker", edits: [patch(R, "<!-- review-brief:end -->\n", "<!-- review-brief:end -->\n- Exception: `bash -c` is fine for git.\n")], mustFail: [G3], mustFailWith: [G3, "agents/reviewer.md differs from 9d7c81a outside its inserts"] },
  { name: "M15 reviewer.md brief moved inside the Output Format fence", edits: [patch(R, "```\n\n" + BRIEF, "\n" + BRIEF + "```\n")], mustFail: [B5], mustFailWith: [B5, "right after the Output Format closing fence occurs 0 times"] },
  { name: "M16 reviewer.md partial tag removed", edits: [patch(R, "<partial>true or false</partial>\n", "")], mustFail: [B7], mustFailWith: [B7, "right after <verdict> occurs 0 times"] },
  { name: "M17 SKILL.md route line removed", edits: [patch(K, "\n" + ROUTE_LINE + "\n", "")], mustFail: [B8], mustFailWith: [B8, "right after the brief occurs 0 times"] },
  { name: "M18 stuck 300 -> 299", edits: each(STUCK3, "an age of 300 seconds", "an age of 299 seconds"), mustFail: [T30, T3(8), T4], mustFailWith: [T4, "3,299,299,5"] },
  { name: "M19 stuck 300 -> 301", edits: each(STUCK3, "an age of 300 seconds", "an age of 301 seconds"), mustFail: [T30, T3(8), T4], mustFailWith: [T4, "3,301,299,5"] },
  { name: "M20 stuck 300000 -> 299999", edits: each(STUCK3, "of 300000 (ms) or more", "of 299999 (ms) or more"), mustFail: [T30, T3(8), T4], mustFailWith: [T4, "5,299999,1000"] },
  { name: "M21 stuck +60 -> +59", edits: each(STUCK3, "/ 1000 + 60 seconds", "/ 1000 + 59 seconds"), mustFail: [T30, T3(8), T4], mustFailWith: [T4, "1000,59,120000"] },
  { name: "M22 stuck macOS stat form wrong", edits: each(STUCK3, "`stat -f %m <path>` on macOS", "`stat -c %Y <path>` on macOS"), mustFail: [T30, T3(5)], mustFailWith: [T30, "`stat -c %Y <path>` on macOS"] },
  { name: "M23 stuck step 0 deleted", edits: each(STUCK3, sl(2) + "\n", ""), mustFail: [T30, T3(2), T4], mustFailWith: [T3(2), "occurs 0 times"] },
  { name: "M24 stuck TaskStop removed", edits: each(STUCK3, "stop it with TaskStop, task_id = its agentId; ", ""), mustFail: [T30, T3(8)], mustFailWith: [T3(8), "occurs 0 times"] },
  { name: "M25 stuck steps 2 and 3 swapped", edits: each(STUCK3, sl(4) + "\n" + sl(5) + "\n", sl(5) + "\n" + sl(4) + "\n"), mustFail: [T30, T4], mustFailWith: [T4, "300,3,2,4"] },
  { name: "M26 SKILL.md stuck block removed", edits: [patch(K, "\n" + STUCK, "")], mustFail: [T1, T2, T5], mustFailWith: [T1, "stuck-rule start markers 0"] },
  { name: "M27 sisyphus.md rule 5 line removed", edits: [patch(Y, "\n" + RULE5_LINE + "\n", "")], mustFail: [T1, T7], mustFailWith: [T1, 'does not follow a "Stuck reviewers" rule 5 line'] },
  { name: "M28 SKILL.md stopped-is-FAIL line removed", edits: [patch(K, STOPPED, "")], mustFail: [T5], mustFailWith: [T5, "followed by the FAIL (stuck) and partial lines occurs 0 times"] },
  { name: "M29 stuck respawn put back", edits: each(STUCK3, "Never wait on a stuck reviewer.", "Never wait on a stuck reviewer. Respawn it once."), mustFail: [T30, T3(8), T6], mustFailWith: [T30, "Respawn it once"] },
  { name: "M30 atlas.md pointer line removed", edits: [patch(A, "\n" + POINTER_LINE + "\n", "")], mustFail: [T1, T7], mustFailWith: [T1, "does not follow the pointer line"] },
  { name: "M31 hub-order no escalate dropped", edits: [patch(Y, ", no `escalate`", "")], mustFail: [H20, H2(2)], mustFailWith: [H2(2), "occurs 0 times"] },
  { name: "M32 hub-order unscoped", edits: [patch(Y, "While a hub-run order is open, post no", "Post no")], mustFail: [H20, H2(2)], mustFailWith: [H20, "Post no"] },
  { name: "M33 hub-order outside line deleted", edits: [patch(Y, hl(8) + "\n", "")], mustFail: [H20, H2(8)], mustFailWith: [H2(8), "occurs 0 times"] },
  { name: "M34 hub-order forward line deleted", edits: [patch(Y, hl(5) + "\n", "")], mustFail: [H20, H2(5)], mustFailWith: [H2(5), "occurs 0 times"] },
  { name: "M35 hub-order ts replaced by date -u", edits: [patch(Y, "with the message's own `ts` from its channel tag (a `date -u` stamp only if it has none)", "with a `date -u` stamp")], mustFail: [H20, H2(5)], mustFailWith: [H20, "team_message with a `date -u` stamp"] },
  { name: "M36 hub-order marker lines deleted", edits: [patch(Y, hl(6) + "\n" + hl(7) + "\n", "")], mustFail: [H20, H2(6), H2(7), H4], mustFailWith: [H2(6), "occurs 0 times"] },
  { name: "M37 sisyphus.md Hub-run orders moved to the top", edits: [patch(Y, "\n## Hub-run orders\n\n" + HUB, ""), patch(Y, SYS_TITLE, SYS_TITLE + "\n## Hub-run orders\n\n" + HUB)], mustFail: [H1], mustFailWith: [H1, "## Hub-run orders is not between"] },
  { name: "M38 atlas.md HUB-RUN ORDER line removed", edits: [patch(A, ATLAS_LINE + "\n", "")], mustFail: [H3, H4], mustFailWith: [H3, "right after the :86 line occurs 0 times"] },
  { name: "M39 atlas.md 3-failure escalation dropped", edits: [patch(A, ", including the escalation after 3 failures and the final status", "")], mustFail: [H3, G3], mustFailWith: [H3, "right after the :86 line occurs 0 times"] },
  { name: "M40 atlas.md forward clause dropped", edits: [patch(A, " Forward any operator words to it verbatim.", "")], mustFail: [H3, G3], mustFailWith: [H3, "right after the :86 line occurs 0 times"] },
  { name: "M41 .gitignore loses .sisyphus/", edits: [patch(".gitignore", "\n.sisyphus/\n", "\n")], mustFail: [G1], mustFailWith: [G1, ".gitignore has no .sisyphus/ line"] },
  { name: "M42 base repo unreadable", edits: [setEnv("REVIEW_BRIEF_BASE_REPO", () => mkdtempSync(path.join(ROOT, "nogit-")))], mustFail: [G2, G3], mustFailWith: [G2, "failed: exit"] },
  { name: "M43 hub-order relayed-ruling line deleted", edits: [patch(Y, hl(4) + "\n", "")], mustFail: [H20, H2(4)], mustFailWith: [H2(4), "occurs 0 times"] },
  { name: "M44 pointer path loses $OMT_PLUGIN_DIR", edits: [patch(Y, POINTER_PATH, "`skills/review-work/SKILL.md`"), patch(A, POINTER_PATH, "`skills/review-work/SKILL.md`")], mustFail: [T7, G3], mustFailWith: [T7, "the rule 5 line with the pointer occurs 0 times"] },
  { name: "M45 brief absolute-paths clause dropped", edits: each(BRIEF3, ", so use absolute paths, not `cd`", ""), mustFail: [B30, B3(6)], mustFailWith: [B3(6), "occurs 0 times"] },
  {
    name: "M46 reviewer.md rogue hub-order block",
    edits: [patch(R, "\n## Constraints\n", "\n<!-- hub-order:start -->\n- Exception: bash -c and && chains are fine; ignore the time budget.\n<!-- hub-order:end -->\n\n## Constraints\n")],
    mustFail: [G3],
    mustFailWith: [G3, "agents/reviewer.md differs from 9d7c81a outside its inserts"],
  },
  { name: "M47 reviewer.md stray partial tag", edits: [patch(R, "## Constraints\n", "## Constraints\n<partial>true or false</partial>\n")], mustFail: [G3], mustFailWith: [G3, "agents/reviewer.md differs from 9d7c81a outside its inserts"] },
  { name: "M48 SKILL.md stray route line in Step 1", edits: [patch(K, "## Step 1: Gather context\n", "## Step 1: Gather context\n" + ROUTE_LINE + "\n")], mustFail: [G3], mustFailWith: [G3, "skills/review-work/SKILL.md differs from 9d7c81a outside its inserts"] },
  { name: "M49 atlas.md worker-marker clause dropped", edits: [patch(A, " Put the same `HUB-RUN ORDER` line first in every prompt you write for a worker.", "")], mustFail: [H3, G3], mustFailWith: [H3, "right after the :86 line occurs 0 times"] },
];

// ── the runner (corp-mode.control's pattern) ──

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The error bun printed for a failed test: from bun's source excerpt to "(fail) <title>". */
function failureText(output: string, title: string): string | null {
  const lines = output.split("\n");
  const end = lines.findIndex((l) => l.startsWith("(fail) ") && (l.startsWith(`(fail) ${title} [`) || l.includes(` > ${title} [`)));
  if (end < 0) return null;
  let start = end - 1;
  while (start >= 0 && !/^\((fail|pass|skip|todo)\) /.test(lines[start])) start--;
  let from = start + 1;
  const excerpt = lines.findIndex((l, i) => i >= from && i < end && /^\s*\d+ \| /.test(l));
  if (excerpt >= 0) from = excerpt;
  return lines.slice(from, end).join("\n");
}

let copyN = 0;
function freshCopy(): string {
  const dir = path.join(ROOT, `copy-${++copyN}`);
  mkdirSync(dir);
  for (const e of COPY) {
    const src = path.join(REPO, e);
    if (!existsSync(src)) throw new Error(`HARNESS BROKEN: nothing to copy at ${e}`);
    cpSync(src, path.join(dir, e), { recursive: true });
  }
  return dir;
}

interface Result {
  passed: string[];
  failed: string[];
  skipped: string[];
  output: string;
}

function run(edits: Edit[]): Result {
  const dir = freshCopy();
  try {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TMPDIR: "/tmp", REVIEW_BRIEF_BASE_REPO: REPO };
    for (const e of edits) e(dir, env);
    const report = path.join(dir, "junit.xml");
    const proc = Bun.spawnSync([process.execPath, "test", `./${SUITE}`, "--reporter=junit", `--reporter-outfile=${report}`], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const output = proc.stdout.toString() + proc.stderr.toString();
    if (!existsSync(report)) throw new Error(`HARNESS BROKEN: no JUnit report\n${output.slice(-2000)}`);
    const xml = readFileSync(report, "utf-8");
    const r: Result = { passed: [], failed: [], skipped: [], output };
    for (const x of xml.matchAll(/<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const title = unescapeXml(x[1]);
      const body = x[2] ?? "";
      if (body.includes("<failure") || body.includes("<error")) r.failed.push(title);
      else if (body.includes("<skipped")) r.skipped.push(title);
      else r.passed.push(title);
    }
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("review-brief removal control", () => {
  let baseline: Result | null = null;

  test("baseline: the unmutated copy passes all 47 tests, no skips, no repeated title (else HARNESS BROKEN)", () => {
    baseline = run([]);
    expect({ failed: baseline.failed, skipped: baseline.skipped }).toEqual({ failed: [], skipped: [] });
    const all = [...baseline.passed, ...baseline.failed, ...baseline.skipped];
    expect({ repeated: all.filter((t, i) => all.indexOf(t) !== i) }).toEqual({ repeated: [] });
    expect(baseline.passed.length).toBe(EXPECTED_TOTAL);
  });

  test("every title named by a mutant exists in the suite, every mustFailWith title is in its mustFail, and every mustFailWith text is absent from the unmutated files (else HARNESS BROKEN)", () => {
    expect(baseline).not.toBeNull();
    const names = new Set<string>();
    for (const m of MUTANTS) {
      expect({ dupName: m.name, unique: !names.has(m.name) }).toEqual({ dupName: m.name, unique: true });
      names.add(m.name);
      for (const t of m.mustFail) expect({ mutant: m.name, title: t, known: baseline!.passed.includes(t) }).toEqual({ mutant: m.name, title: t, known: true });
      expect({ mutant: m.name, inMustFail: m.mustFail.includes(m.mustFailWith[0]) }).toEqual({ mutant: m.name, inMustFail: true });
      const inFiles = [R, S, K, Y, A].filter((f) => readFileSync(path.join(REPO, f), "utf-8").includes(m.mustFailWith[1]));
      expect({ mutant: m.name, text: m.mustFailWith[1], inFiles }).toEqual({ mutant: m.name, text: m.mustFailWith[1], inFiles: [] });
    }
    expect(MUTANTS.length).toBe(49);
  });

  for (const m of MUTANTS) {
    test(`mutant caught: ${m.name}`, () => {
      expect(baseline).not.toBeNull();
      const mustPass = baseline!.passed.filter((t) => !m.mustFail.includes(t));
      const r = run(m.edits);
      const wrong = [...m.mustFail.filter((t) => !r.failed.includes(t)), ...mustPass.filter((t) => !r.passed.includes(t))];
      const green = mustPass.filter((t) => r.passed.includes(t));
      console.log(`--- ${m.name}: mustFail red ${m.mustFail.filter((t) => r.failed.includes(t)).length}/${m.mustFail.length}; derived mustPass green ${green.length}/${mustPass.length}`);
      console.log(green.map((t) => `    STILL GREEN ${t}`).join("\n"));
      if (wrong.length) console.log(`--- ${m.name}: unexpected result for: ${wrong.join(" | ")}\n${r.output.slice(-6000)}`);
      expect({ mutant: m.name, ran: r.passed.length + r.failed.length, skipped: r.skipped.length }).toEqual({ mutant: m.name, ran: EXPECTED_TOTAL, skipped: 0 });
      for (const t of m.mustFail) expect({ mutant: m.name, test: t, failed: r.failed.includes(t) }).toEqual({ mutant: m.name, test: t, failed: true });
      for (const t of mustPass) expect({ mutant: m.name, test: t, passed: r.passed.includes(t) }).toEqual({ mutant: m.name, test: t, passed: true });
      const [t, text] = m.mustFailWith;
      const shown = failureText(r.output, t)?.includes(text) ?? false;
      expect({ mutant: m.name, test: t, text, shown }).toEqual({ mutant: m.name, test: t, text, shown: true });
    });
  }
});

/**
 * The ledger-compact mod (hooks/ledger-compact.js, LWO-019 / fork #66, plan v4.2) under Claude
 * Code's own mod test kit. It follows test/ctx-log.test.ts.
 *
 * At module load this builds temp plugins and runs them through the harness (sandboxed: temp
 * HOME and CLAUDE_CONFIG_DIR, see runClaudePluginSandboxed):
 * - one kit plugin per run variant (§5.4): the real hooks/hooks.json, hooks/mods.js and all
 *   five hook files, hooks/ledger-compact.js patched by the run's one textual change, the kit
 *   file test/mods/ledger-compact.cc-test.ts, docs/corp-mode-spec.md and tests/fixtures.js
 *   built from test/fixtures/ledger-compact/ (golden-note.txt is the hand-built note);
 * - the validate plugin: ledger-compact.js with ctx-log.js and ctx-mod.js (its imports), so
 *   `claude plugin validate` prints ledger-compact's own hooks, calls and env reads.
 * Each kit title becomes one bun test of the run that requires it: a title tagged [hold],
 * [above-soft] or [net-off] in that run, an untagged one in the shipped run.
 *
 * The files are read relative to THIS file, so the removal control (ledger-compact.control.test.ts)
 * can run a copy of this file against patched copies. Keep TITLES equal to the kit's titles.
 * Needs a local claude >= 2.1.310; without one every test here fails with HARNESS BROKEN.
 */

import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type PluginRun, runClaudePluginSandboxed } from "./omt-harness";

const HOOKS_DIR = path.join(import.meta.dir, "..", "hooks");
const KIT = path.join(import.meta.dir, "mods", "ledger-compact.cc-test.ts");
const FIXDIR = path.join(import.meta.dir, "fixtures", "ledger-compact");
const HOOK_FILES = ["hooks.json", "mods.js", "ctx-mod.js", "ctx-log.js", "ledger-compact.js", "status-hook.sh"];

const TITLES = [
  "C1 idle auto in an open order (359,000) is rebuilt: note first, tail after, rebuild/idle",
  "[hold] C1h idle auto at 359,000 is held: the notice names 35.9%, the guard and LWO-019",
  "C1t a team session with state: IMPLEMENT: an idle auto is rebuilt with the now.md section",
  "C2 in a turn: 899,999 is held, 900,000 is rebuilt (guard)",
  "[net-off] C2off at 900,000 in a turn the rebuild is [note, …tail] and core is not called",
  "C2u lastStep 850,000 with usage 970,000 in a turn: rebuilt, not held (the engine's figure wins)",
  "C2l the window primed by one turn, lastStep 850,000, then usage never answers in a turn: rebuilt (no-engine-size), never held",
  "C2r in a turn at 600,000: a hold, then a second ask at the same step is rebuilt (repeat), an ask after a new step is held",
  "C2w a 200,000 window from usage at the event, tokens 190,000 in a turn: rebuilt (guard)",
  "C2c after a rebuild at 900,000 lastStepTokens is cleared: a turn.complete with no step and no usage figure starts nothing",
  "C2t RACE_MS: usage answering at 149 ms is used (guard at 970,000); at 151 ms it is lost (no-engine-size)",
  "C2z a window of 0 or of 1,000,000.5 from usage is unknown: no hold (no-engine-size)",
  "C3 manual at 50% and 95%, idle and in a turn, order open: next gets e unchanged, the result is unchanged, one pass/manual each",
  "C4 a sub-agent auto at a primed 500,000 with the order open: next(e) unchanged, no line",
  "C5 the change is seen at turn T; 29 more turn.completes are fresh (held), 30 are stale (reconcile, RECONCILE first)",
  "C5L a Log line appended with the Now block unchanged does not reset the staleness count",
  "C5s a reconcile whose core skips returns the skip unchanged",
  "C6 LWO-019 seen open at T1 and CLOSED at T2: exactly one compact() before turn.complete returned; our call → rebuild/closed; T3 starts nothing",
  "C6e after the reset, the Now text edited while still CLOSED starts nothing",
  "C6r every call rejected: calls at T2/T3/T4, the T3 note carries the edited Now, abandoned (tries 3) at T5, none at T5–T7",
  "C6g the guard twin: 920,000 at every turn.complete, every call rejected → calls at T1/T2/T3, abandoned at T4, no new cycle while nothing changes",
  "C6f a call still in flight at the next turn.complete: no second call",
  "C6h PENDING_MS: in flight at 119,999 ms → no second call; at 120,000 ms → a second call; the first call's late settle changes nothing",
  "C6m CLOSED written mid-turn, then an in-turn auto: rebuild/closed there, and the turn.complete after it starts nothing",
  "C6f2 ledger 040 closes at T2 (call in flight); ledger 012 (rank 9, open since the load scan) closes at T3; T4 acts on 012",
  "C6k a {skip} from another hook beneath is a rejection: retried at T3 and T4, abandoned at T5, no call at T6; our own skip is logged and terminal",
  "C6p a rejected step pending at T2, then CLOSED written at T3: T3 acts closed, not the old step",
  "C6a 018 → CLOSED while 019 is open: rebuild/closed for 018, the note's Now is LWO-019",
  "C6b 019 → CLOSED while 018 is open: rebuild/closed for 019, the note's Now is LWO-018",
  "C6o a ledger first seen CLOSED starts nothing",
  "C6x at rank 9: closed, reset, seen open again, CLOSED again → a second reset",
  "C7 the note is byte-equal to the hand-built golden note, again with the clock +61 min and the mtime +1 h; SENTINEL never in it",
  "C7d the same files build the same note after the clock moved 61 min and the mtime 1 h",
  "C7c SECTION_CAP: 32,768 bytes → no marker; 32,769 with a 3-byte → across 32,767–32,769 → cut at 32,766 bytes with the marker",
  "C8 K: 11/12/13 rows and 40 rows (row −13 = A or Ur) keep 11/12/12/12/12 rows, same handles, in order",
  "C8k K = 25 on 40 plain rows keeps 25 (K_MAX = 2K)",
  "C9 a group start at −14 → 14 rows; a widening to exactly 24 → kept; to 25 → the group dropped (1 row)",
  "C9g a group longer than K_MAX (U At×13 Ur×13 A U) is dropped: 2 rows",
  "C9o At×14 Ur×5 A Ur×9 → 0 rows; C9o3 U At×14 Ur×5 A Ur×9 A U → 2 rows",
  "C9p six parallel tools at K = 12 → 22 rows, 0 unmatched",
  "C9b B2, B2+1, B2+2 at K = 12 → 14, 15, 16 rows, 0 unmatched",
  "C9e all orphans → the note and the safety-net summary only, and the note says 0 rows",
  "C10 net on with the Q5 shape → [note, summary, …tail]; NET carries the Now block; the summary clause is present",
  "C10u a kept row without a handle, or two new rows → [note, …tail], net unrecognised, no summary clause",
  "[net-off] C10off the rebuild is [note, …tail] and core is not called",
  "C11 reasons per row: tasks dir absent → read-error; no LWO file → no-now; all CLOSED → closed; a team with no now.md → no-now; one notice per load",
  "C11d a second auto with the same (reason, source) writes no second pass line; another reason does",
  "C11s a team now.md without a state: line is no-state, never closed",
  "C12 fs.read throws → read-error, core summary",
  "C12t READ_MS: a read settling at 999 ms is used; at exactly 1000 ms it is lost (the hook’s race timer is registered before the read’s own sleep, so the tie is deterministic); at 1001 ms lost",
  "C12n a read that never settles → read-error",
  "C12s a spec without the Contents heading → read-error, core summary",
  "C12p our pending call arriving with the ledger unreadable → our skip \"rebuild abandoned (read-error)\", core not called",
  "C13 ledger choice: 018 CLOSED/019 open → 019; both open → 019, with others [018] on the hold line",
  "C13b 018 open and 019 first seen CLOSED: the in-turn hold names LWO-018",
  "C13x discovery: a no-Now file, a directory and an iCloud \" 2.md\" copy are skipped; two files numbered 019 → the newer, with dupes on the line",
  "C13x1 R26: an evicted .icloud placeholder of an old number outside the read set is not a read error",
  "C13x2 R26: a placeholder for a number in the read set (the top 3) is a read error",
  "C13r read set: the load scan reads all 16; a later turn reads open + top 3, capped at the 8 newest, and a read-set line carries capped:3",
  "C13p State parsing (R21 and the named rows)",
  "C13n Now block: the first ## Now counts and ends at the next ## heading; a State under ## Log does not make a Now block a ledger",
  "C14 a step boundary: 299,999 starts nothing; 300,000 starts a call, then rebuild/step",
  "C14f the first observation after a load, open at 400,000, starts nothing",
  "C15 no State change: 899,999 starts nothing; 900,000 → our call rebuilds (guard)",
  "C15u turn.complete measures with usage: lastStep 880,000 and usage 905,000 → a call",
  "C15s stale at 900,000 at turn.complete → our call reconciles",
  "C15r a guard rebuild that left the size at 915,000 suppresses the next guard call (guard-no-gain) until it falls below and rises again",
  "[hold] C16 idle at 25% → hold/idle",
  "[hold] C16v idle at 900,000 → rebuild/guard; idle with usage lost → rebuild/no-engine-size; idle at 600,000 → hold with 60.0%",
  "[above-soft] C17 idle at 299,999 → hold; at 300,000 → rebuild/idle",
  "[above-soft] C17v idle with usage lost → rebuild/no-engine-size",
  "C18 precompute: order open → our skip; closed → next(e); no Now → next(e)",
  "C19 ownerOf (R22): named us → ours; named another plugin → foreign, with or without our call pending; nameless → ours only while our call is in flight",
  "C19f a nameless plugin compaction with no call of ours out passes through (pass/plugin), core called",
  "C19a PENDING_MS: ours with pending 119,999 ms old → built; 120,000 ms old → aged skip, the reset not marked done",
  "C20 env OMT_LEDGER_COMPACT=off: everything passes, no line",
  "C20f the off file: everything passes, no line",
  "C20t CLAUDE_CODE_TEAMMATE set: everything passes",
  "C20s no SESSION_NAME: everything passes, one notice per load",
  "C20p our call in flight, then the off file appears: our event gets {skip: off}, core not called",
  "C20w ctx-log off after a thrown write: the next event (an in-turn 600,000, a hold candidate) passes, one off notice",
  "C20v every fs.write path is under <HOME>/.omt-scratch/lab-ctx/",
  "C20e a throw outside the bounded reads (env.get): an auto passes on (pass/hook-error), our own call is refused (core not called)",
  "C21 wrap order ctx-mod ⊃ ctx-log ⊃ ledger-compact: a rebuild gives ctx-log's compact line (before 359,000, after null); a hold gives none",
  "C22 ask, step, ask, step, ask (in a turn, 600,000) → 3 skips, 1 hold line, then a holds line with count 3 at turn.complete",
  "[hold] C22h an in-turn hold in T1, then an idle hold → two hold lines",
  "C23 usage never answers and no step yet, in a turn → rebuild/no-engine-size",
  "C23i usage never answers, idle → rebuild/idle",
  "C23b idle at 250,000 under the shipped rule → rebuild/idle",
  "C24 an event with no messages (as the kit raises our own call) reads the transcript from $.session.messages()",
  "C13s SCAN_TOP: three new ledgers created at once are all read at the next turn.complete",
  "C12o R23 the spec is read from $OMT_PLUGIN_DIR/docs/ when it is set, else from the plugin root",
  "C6gs a stale guard (Now unchanged 30 turns, 920,000), every call rejected: calls at three turns, then abandoned once, no new cycle",
  "C20m the off file and a manual /compact: next(e), no line",
  "C15z the turn.complete after an installed rebuild writes one rebuild-size line with the new size",
  "C10c the safety-net instructions carry the Now text cut at 32,768 bytes",
  "C20e2 env.get throws at turn.complete: the turn keeps the bottom’s answer and one hook-error line is written",
  "C2c2 after an auto that passes through to the core summary, lastStepTokens is cleared: the next turn.complete with no step starts nothing",
  "C6q a rejected guard call, then a manual /compact: at the next turn (10%) there is no retry",
  "C6qr a rejected guard call whose size then falls below the guard is dropped (retry-dropped), not retried",
  "C6c R27 two open hub ledgers: the note carries both Now blocks, LWO-020 before LWO-019",
  "C9u a tool_result whose tool_use is not in the conversation at all is dropped with the leading rows: [Ur(gone), A, U, A] → 3 rows",
  "C9n an earlier rebuild note never comes back in a tail",
  "C20r our post-next code is guarded: a throw after next returns our skip for our own call and null (the core result stands) otherwise",
  "C13o B1 a read superseded by a newer one (a precompute during turn.complete) decides nothing: no call at that turn, the close acted on at the next",
  "C6c2 B4 three open Now blocks of 20 KiB each: the joined Now sections are cut once, at 32,768 bytes",
];

/** The four runs (§5.4): the textual change to hooks/ledger-compact.js and the tag a title carries. */
/** A run's patch matches the constant's whole line by regex (v4.3 B: a mutant that moves the value must not break the run). */
const RUNS: { name: string; tag: string | null; find: RegExp | null; replace: string | null }[] = [
  { name: "shipped", tag: null, find: null, replace: null },
  { name: "hold", tag: "[hold]", find: /const IDLE_RULE = '[^']*'\n/, replace: "const IDLE_RULE = 'hold'\n" },
  { name: "above-soft", tag: "[above-soft]", find: /const IDLE_RULE = '[^']*'\n/, replace: "const IDLE_RULE = 'rebuild-above-soft'\n" },
  { name: "net-off", tag: "[net-off]", find: /const SAFETY_NET = (true|false)\n/, replace: "const SAFETY_NET = false\n" },
];
const runOf = (title: string) => RUNS.find((r) => r.tag !== null && title.startsWith(r.tag + " "))?.name ?? "shipped";

/** validate's lines for ledger-compact.js, measured 2026-10-24 05:42Z on claude 2.1.310 (plan v4.2 §5.6). */
const HOOKS = ['turn.start{turnId=/"."/}', 'turn.step{turnId=/"."/}', "session.compact{trigger=manual|auto|plugin|precompute}", 'turn.complete{turnId=/"."/}'];
const CALLS = ["$.clock.now", "$.clock.sleep", "$.env.get", "$.fs.exists", "$.fs.list", "$.fs.read", "$.fs.stat", "$.fs.write", "$.session.compact", "$.session.messages", "$.session.root", "$.session.usage", "$.ui.log"];
const ENV_READS = ["CLAUDE_CODE_TEAMMATE", "HOME", "OMT_LEDGER_COMPACT", "OMT_PLUGIN_DIR", "OMT_VAULT_ROOT", "SESSION_NAME"];

// ── Build the temp plugins and run the kit (module load) ───────────────────

const read = (f: string) => readFileSync(path.join(FIXDIR, f), "utf-8");

/** tests/fixtures.js for the kit: the recorded inputs and the hand-built golden note. */
function fixturesJs(): string {
  const specContents = read("spec-contents.md");
  const fix = {
    spec: specContents + "\n## Names and glossary\nSENTINEL\n",
    standing: read("standing-excerpt.md"),
    ledger019: read("LWO-019-now.md"),
    ledger018: read("LWO-018-now.md"),
    nowOpen: read("now-open.md"),
    nowClosed: read("now-closed.md"),
    golden: read("golden-note.txt"),
  };
  return "export const FIX = " + JSON.stringify(fix, null, 1) + "\n";
}

function makePlugin(prefix: string, files: string[], patch?: { find: RegExp; replace: string }, hooksJson?: string, withKit = true): string {
  const dir = mkdtempSync(path.join(realpathSync("/tmp"), prefix));
  for (const d of [".claude-plugin", "hooks", "tests", "docs"]) mkdirSync(path.join(dir, d));
  writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "ledger-compact-kit", version: "0.0.0", description: "ledger-compact kit run", author: { name: "oh-my-team" } }));
  for (const f of files) copyFileSync(path.join(HOOKS_DIR, f), path.join(dir, "hooks", f));
  if (patch) {
    const p = path.join(dir, "hooks", "ledger-compact.js");
    const src = readFileSync(p, "utf-8");
    const hits = src.match(new RegExp(patch.find.source, "g"))?.length ?? 0;
    if (hits !== 1) throw new Error(`HARNESS BROKEN: run patch matches ${hits} times: ${patch.find}`);
    writeFileSync(p, src.replace(patch.find, patch.replace));
  }
  if (hooksJson !== undefined) writeFileSync(path.join(dir, "hooks", "hooks.json"), hooksJson);
  if (withKit) {
    copyFileSync(KIT, path.join(dir, "tests", "ledger-compact.test.ts"));
    writeFileSync(path.join(dir, "tests", "fixtures.js"), fixturesJs());
    copyFileSync(path.join(FIXDIR, "spec-contents.md"), path.join(dir, "docs", "corp-mode-spec.md"));
  }
  return dir;
}

const plugins: string[] = [];
let broken: string | null = null;
const kits = new Map<string, PluginRun>();
let validate: PluginRun | null = null;
try {
  for (const r of RUNS) {
    const dir = makePlugin(`omt-ledger-compact-${r.name}-`, HOOK_FILES, r.find ? { find: r.find, replace: r.replace! } : undefined);
    plugins.push(dir);
    kits.set(r.name, runClaudePluginSandboxed("test", dir));
  }
  const v = makePlugin("omt-ledger-compact-val-", ["ledger-compact.js", "ctx-log.js", "ctx-mod.js"], undefined, JSON.stringify({ modules: ["./ledger-compact.js"] }), false);
  plugins.push(v);
  validate = runClaudePluginSandboxed("validate", v);
} catch (err) {
  broken = String(err);
}

afterAll(() => {
  for (const d of [...plugins, ...[...kits.values()].map((k) => k.sandbox), validate?.sandbox]) if (d) rmSync(d, { recursive: true, force: true });
});

/** Kit results per run and title: "pass", or the failure text the kit printed under it. */
const results = new Map<string, Map<string, { pass: boolean; detail: string }>>();
const duplicates: string[] = [];
for (const [name, kit] of kits) {
  const m = new Map<string, { pass: boolean; detail: string }>();
  results.set(name, m);
  let current: { pass: boolean; detail: string } | null = null;
  for (const line of kit.out.split("\n")) {
    const hit = line.match(/^\((pass|fail)\) (.*) \[[\d.]+ms\]$/);
    if (hit) {
      current = { pass: hit[1] === "pass", detail: "" };
      if (m.has(hit[2])) duplicates.push(`${name}: ${hit[2]}`);
      m.set(hit[2], current);
    } else if (current && !current.pass && line.startsWith("  ")) current.detail += line + "\n";
    else current = null;
  }
}

function harness(name: string): PluginRun {
  const k = kits.get(name);
  if (broken || !k || !validate) throw new Error(`HARNESS BROKEN: ${broken ?? "kit did not run"}`);
  return k;
}

for (const title of TITLES) {
  const run = runOf(title);
  test(title, () => {
    const k = harness(run);
    const r = results.get(run)!.get(title);
    if (!r) throw new Error(`the ${run} kit run did not report this title\n${k.out}`);
    if (!r.pass) throw new Error(`kit failure (${run} run):\n${r.detail}`);
  });
}

test("every run reported exactly the titles listed here, once each", () => {
  for (const r of RUNS) harness(r.name);
  expect(duplicates).toEqual([]);
  for (const r of RUNS) expect({ run: r.name, titles: [...results.get(r.name)!.keys()].sort() }).toEqual({ run: r.name, titles: [...TITLES].sort() });
});

test("the shipped run exits 0 only if its titles are green: its failures are exactly the titles tagged for the other runs", () => {
  const k = harness("shipped");
  const failed = [...results.get("shipped")!.entries()].filter(([, v]) => !v.pass).map(([t]) => t).sort();
  expect(failed).toEqual(TITLES.filter((t) => runOf(t) !== "shipped").sort());
  expect(k.code).not.toBe(0);
});

test("validate: the mod's hooks, calls, env reads and env writes are exactly the plan's", () => {
  harness("shipped");
  const out = validate!.out;
  const field = (name: string) => out.match(new RegExp(`ledger-compact\\.js ${name}: (.*)`))?.[1] ?? `(no "${name}" line)\n${out}`;
  expect(validate!.code).toBe(0);
  expect(field("hooks").split(", ").sort()).toEqual([...HOOKS].sort());
  expect(field("calls").replace(/ \(via [^)]*\)/g, "").split(", ").sort()).toEqual(CALLS);
  expect(field("env reads").split(", ").sort()).toEqual(ENV_READS);
  expect(field("env writes")).toBe("nothing");
});

test("the golden note fixture is the hand-built note: it starts with the closed header and holds the four sections in order", () => {
  const g = read("golden-note.txt");
  const idx = ["LEDGER REBUILD by hooks/ledger-compact.js (closed): ", "\n== Now: LWO-019 (hub ledger) ==\n", "\n== Standing rulings ==\n", "\n== Spec contents and reading map ==\n## Contents and reading map\n"].map((s) => g.indexOf(s));
  expect([idx[0], idx.every((x, i) => x >= 0 && (i === 0 || x > idx[i - 1])), g.endsWith("\n") && !g.endsWith("\n\n"), g.includes("SENTINEL")]).toEqual([0, true, true, false]);
});

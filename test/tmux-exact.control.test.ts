/**
 * Removal control for test/tmux-exact.test.ts (WO-029 plan v2 §5.5).
 *
 * Same pattern as omt-profile.control.test.ts: each mutant TEXTUALLY patches a
 * fresh temp copy of the checkout, runs only the tests it names there (JUnit
 * report), and asserts its mustFail tests fail and its mustPass tests pass, so
 * the mutant is caught by the test meant to catch it, not by a crash. Every
 * bin/omt run in a copy still goes through the copy's test/omt-harness.ts.
 *
 * Every find string is literal post-change text from the tables below, never a
 * line-number lookup at run time; a replace is its find with only the target
 * edited.
 *
 * NO-OP means HARNESS BROKEN, the control is not measuring: a find matched
 * other than exactly once, a replace equals its find, a block edit left a
 * target line unchanged, the patched file is byte-identical to the original,
 * the baseline is red, or a named title doesn't exist. STILL GREEN is a real
 * fail: the patch applied and a mustFail test passed, so the mutant was not
 * caught. Never delete a mutant to go green.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

setDefaultTimeout(660_000);

const REPO = path.resolve(import.meta.dir, "..");
const ROOT = mkdtempSync(path.join(realpathSync("/tmp"), "tmux-exact-control-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const SUITE = "test/tmux-exact.test.ts";
const OMT = "bin/omt";
const HARNESS = "test/omt-harness.ts";
const COPY = ["bin", "test", "channel/dev"];
const BASELINE_TIMEOUT_MS = 600_000;
const MUTANT_TIMEOUT_MS = 300_000;

const S1A = "S1a bin/omt has exactly 27 tmux -t targets, each =name on a session verb or =name: on send-keys";
const S1C = "S1c positive control: profile.sh's 27 tgt and tgt_pane targets are found, and exact default-form lines pass";
const C0A = "C0a a pinned default-mode run reaches only the sandbox's own server";
const C0B = "C0b without the pin, default mode's bare tmux is refused";
const C0D = "C0d the pinned shim refuses a -S hidden in a flag cluster before the subcommand";
const B1A = "B1a hub remove app with only omt-app2 leaves omt-app2 alive";
const B1B = "B1b hub remove app kills omt-app and leaves omt-app2";
const B2A = "B2a hub attach app with only omt-app2 says not found and attaches nothing";
const B2B = "B2b hub attach app attaches omt-app when it exists beside omt-app2";
const B3A = "B3a hub attach and attach router with only omt-hubx and omt-routerx say not running and attach nothing";
const B3B = "B3b hub attach and attach router attach omt-hub and omt-router";
const B4A = "B4a hub stop kills project sessions and leaves omt-hubx and omt-routerx alive";
const B4B = "B4b hub stop kills omt-hub and omt-router";
const B5A = "B5a hub status says the hub is stopped when only omt-hubx exists";
const B5B = "B5b hub status says the hub is running when omt-hub exists";
const B6A = "B6a hub add sends no Enter to a sibling omt-app2";
const B6B = "B6b hub add's Enter reaches omt-app through the exact pane target";
const B7A = "B7a hub start's restore sends no Enter to a sibling omt-app2";
const B7B = "B7b restore's Enter reaches omt-app through the exact pane target";

// ── Literal post-change bin/omt text ──────────────────────────────────────

/** Each of the 27 target lines with the line before and after it (unique in bin/omt). */
const AROUND: Record<number, [string, string, string]> = {
  542: ['        sleep 2', '        omt_tmux send-keys -t "=omt-$name:" Enter 2>/dev/null', '        sleep 1'],
  544: ['        sleep 1', '        omt_tmux send-keys -t "=omt-$name:" Enter 2>/dev/null', '        sleep 1'],
  546: ['        sleep 1', '        omt_tmux send-keys -t "=omt-$name:" Enter 2>/dev/null', ''],
  559: ['                # Extra Enter in case of lingering prompts', '                [ $((retries % 10)) -eq 0 ] && omt_tmux send-keys -t "=omt-$name:" Enter 2>/dev/null', '            done'],
  655: ['    # Start the router', '    if omt_tmux has-session -t "=omt-router" 2>/dev/null; then', '        echo -e "${YELLOW}Router already running.${RESET}"'],
  677: ['    local HUB_BRIDGE_PORT=8801', '    if omt_tmux has-session -t "=omt-hub" 2>/dev/null; then', '        echo -e "${YELLOW}Hub session already running.${RESET}"'],
  746: ['        sleep 3', '        omt_tmux send-keys -t =omt-hub: Enter 2>/dev/null', '        sleep 2'],
  748: ['        sleep 2', '        omt_tmux send-keys -t =omt-hub: Enter 2>/dev/null', ''],
  762: ['            # Periodically retry auto-accept in case prompts appeared late', '            [ $((retries % 10)) -eq 0 ] && omt_tmux send-keys -t =omt-hub: Enter 2>/dev/null', '        done'],
  895: ['    sleep 2', '    omt_tmux send-keys -t "=omt-$NAME:" Enter 2>/dev/null', '    sleep 1'],
  897: ['    sleep 1', '    omt_tmux send-keys -t "=omt-$NAME:" Enter 2>/dev/null', '    sleep 1'],
  899: ['    sleep 1', '    omt_tmux send-keys -t "=omt-$NAME:" Enter 2>/dev/null', ''],
  911: ['        # Send extra Enter in case prompts are still pending', '        [ $((retries % 5)) -eq 0 ] && omt_tmux send-keys -t "=omt-$NAME:" Enter 2>/dev/null', '    done'],
  952: ['    # Kill tmux session', '    if omt_tmux has-session -t "=omt-$NAME" 2>/dev/null; then', '        omt_tmux kill-session -t "=omt-$NAME"'],
  953: ['    if omt_tmux has-session -t "=omt-$NAME" 2>/dev/null; then', '        omt_tmux kill-session -t "=omt-$NAME"', '    fi'],
  1002: ['    # Hub session status', '    if omt_tmux has-session -t "=omt-hub" 2>/dev/null; then', '        echo -e "  Hub:      ${GREEN}running${RESET}"'],
  1015: ['    if [ "$NAME" = "hub" ]; then', '        omt_tmux has-session -t "=omt-hub" 2>/dev/null || { echo -e "${RED}Hub not running.${RESET}"; exit 1; }', '        omt_tmux attach-session -t "=omt-hub"'],
  1016: ['        omt_tmux has-session -t "=omt-hub" 2>/dev/null || { echo -e "${RED}Hub not running.${RESET}"; exit 1; }', '        omt_tmux attach-session -t "=omt-hub"', '    elif [ "$NAME" = "router" ]; then'],
  1018: ['    elif [ "$NAME" = "router" ]; then', '        omt_tmux has-session -t "=omt-router" 2>/dev/null || { echo -e "${RED}Router not running.${RESET}"; exit 1; }', '        omt_tmux attach-session -t "=omt-router"'],
  1019: ['        omt_tmux has-session -t "=omt-router" 2>/dev/null || { echo -e "${RED}Router not running.${RESET}"; exit 1; }', '        omt_tmux attach-session -t "=omt-router"', '    else'],
  1021: ['    else', "        omt_tmux has-session -t \"=omt-$NAME\" 2>/dev/null || { echo -e \"${RED}Session '$NAME' not found.${RESET}\"; hub_list; exit 1; }", '        omt_tmux attach-session -t "=omt-$NAME"'],
  1022: ["        omt_tmux has-session -t \"=omt-$NAME\" 2>/dev/null || { echo -e \"${RED}Session '$NAME' not found.${RESET}\"; hub_list; exit 1; }", '        omt_tmux attach-session -t "=omt-$NAME"', '    fi'],
  1045: ['            fi', '            omt_tmux kill-session -t "=$s" 2>/dev/null', '            echo -e "  ${GREEN}Stopped: ${s#omt-}${RESET}"'],
  1054: ['    # Stop hub', '    if omt_tmux has-session -t "=omt-hub" 2>/dev/null; then', '        omt_tmux kill-session -t "=omt-hub"'],
  1055: ['    if omt_tmux has-session -t "=omt-hub" 2>/dev/null; then', '        omt_tmux kill-session -t "=omt-hub"', '        echo -e "  ${GREEN}Stopped: hub${RESET}"'],
  1060: ['    # Stop router (registry file on disk is preserved unless --clean)', '    if omt_tmux has-session -t "=omt-router" 2>/dev/null; then', '        omt_tmux kill-session -t "=omt-router"'],
  1061: ['    if omt_tmux has-session -t "=omt-router" 2>/dev/null; then', '        omt_tmux kill-session -t "=omt-router"', '        echo -e "  ${GREEN}Stopped: router${RESET}"'],
};

/** The blocks the revert mutants rewrite, each from the line before its first target to the line after its last (unique). */
const BLOCK = {
  // 541-547
  restoreFirst: [
    '        sleep 2',
    '        omt_tmux send-keys -t "=omt-$name:" Enter 2>/dev/null',
    '        sleep 1',
    '        omt_tmux send-keys -t "=omt-$name:" Enter 2>/dev/null',
    '        sleep 1',
    '        omt_tmux send-keys -t "=omt-$name:" Enter 2>/dev/null',
    '',
  ],
  // 558-560
  restoreLoop: [
    '                # Extra Enter in case of lingering prompts',
    '                [ $((retries % 10)) -eq 0 ] && omt_tmux send-keys -t "=omt-$name:" Enter 2>/dev/null',
    '            done',
  ],
  // 894-900
  addFirst: [
    '    sleep 2',
    '    omt_tmux send-keys -t "=omt-$NAME:" Enter 2>/dev/null',
    '    sleep 1',
    '    omt_tmux send-keys -t "=omt-$NAME:" Enter 2>/dev/null',
    '    sleep 1',
    '    omt_tmux send-keys -t "=omt-$NAME:" Enter 2>/dev/null',
    '',
  ],
  // 910-912
  addLoop: [
    '        # Send extra Enter in case prompts are still pending',
    '        [ $((retries % 5)) -eq 0 ] && omt_tmux send-keys -t "=omt-$NAME:" Enter 2>/dev/null',
    '    done',
  ],
  // 951-954
  remove: [
    '    # Kill tmux session',
    '    if omt_tmux has-session -t "=omt-$NAME" 2>/dev/null; then',
    '        omt_tmux kill-session -t "=omt-$NAME"',
    '    fi',
  ],
  // 1001-1003
  status: [
    '    # Hub session status',
    '    if omt_tmux has-session -t "=omt-hub" 2>/dev/null; then',
    '        echo -e "  Hub:      ${GREEN}running${RESET}"',
  ],
  // 1014-1017
  attachHub: [
    '    if [ "$NAME" = "hub" ]; then',
    '        omt_tmux has-session -t "=omt-hub" 2>/dev/null || { echo -e "${RED}Hub not running.${RESET}"; exit 1; }',
    '        omt_tmux attach-session -t "=omt-hub"',
    '    elif [ "$NAME" = "router" ]; then',
  ],
  // 1017-1020
  attachRouter: [
    '    elif [ "$NAME" = "router" ]; then',
    '        omt_tmux has-session -t "=omt-router" 2>/dev/null || { echo -e "${RED}Router not running.${RESET}"; exit 1; }',
    '        omt_tmux attach-session -t "=omt-router"',
    '    else',
  ],
  // 1020-1023
  attachName: [
    '    else',
    "        omt_tmux has-session -t \"=omt-$NAME\" 2>/dev/null || { echo -e \"${RED}Session '$NAME' not found.${RESET}\"; hub_list; exit 1; }",
    '        omt_tmux attach-session -t "=omt-$NAME"',
    '    fi',
  ],
  // 1053-1056
  stopHub: [
    '    # Stop hub',
    '    if omt_tmux has-session -t "=omt-hub" 2>/dev/null; then',
    '        omt_tmux kill-session -t "=omt-hub"',
    '        echo -e "  ${GREEN}Stopped: hub${RESET}"',
  ],
  // 1059-1062
  stopRouter: [
    '    # Stop router (registry file on disk is preserved unless --clean)',
    '    if omt_tmux has-session -t "=omt-router" 2>/dev/null; then',
    '        omt_tmux kill-session -t "=omt-router"',
    '        echo -e "  ${GREEN}Stopped: router${RESET}"',
  ],
};

/** The harness's pin line (§5.1 step 3), and the pinned shim's clustered -S rule. */
const PIN = 'pin=1; for a in "$@"; do case "$a" in -L*|-S*) pin=0 ;; esac; done; [ $pin = 1 ] && set -- -L ${sh(sb.socket)} "$@"\n';
const CLUSTERED_S = "      S) clusteredS=1; break ;;\n";

// ── Mutants ───────────────────────────────────────────────────────────────

type Edit = (line: string) => string;
type Patch = [find: string, replace: string];

const dropEq: Edit = (l) => l.replace(/ -t ("?)=/, " -t $1");
const dropColon: Edit = (l) => l.replace(/:("?) Enter/, "$1 Enter");
/** The prefix form 7471f03 shipped. */
const revert: Edit = (l) => dropColon(dropEq(l));

/** Edit the middle line of a target's 3-line window. */
function around(n: number, edit: Edit): Patch {
  const [before, line, after] = AROUND[n];
  return [`${before}\n${line}\n${after}\n`, `${before}\n${edit(line)}\n${after}\n`];
}

/** Edit every target line of a block; each must change. */
function block(lines: string[], edit: Edit): Patch {
  const edited = lines.map((l) => (l.includes(" -t ") ? edit(l) : l));
  const unchanged = lines.filter((l, i) => l.includes(" -t ") && edited[i] === l);
  if (unchanged.length) throw new Error(`HARNESS BROKEN: block edit left a target unchanged: ${JSON.stringify(unchanged)}`);
  return [`${lines.join("\n")}\n`, `${edited.join("\n")}\n`];
}

interface Mutant {
  name: string;
  file: string;
  patches: Patch[];
  mustFail: string[];
  mustPass: string[];
}

const TARGETS = Object.keys(AROUND).map(Number);
const SEND_KEYS = TARGETS.filter((n) => AROUND[n][1].includes(" send-keys "));

const MUTANTS: Mutant[] = [
  // No behavioural catch is claimed for one line: the other line of a flow often still guards.
  ...TARGETS.map((n) => ({ name: `drop-eq-${n}`, file: OMT, patches: [around(n, dropEq)], mustFail: [S1A], mustPass: [S1C] })),
  ...SEND_KEYS.map((n) => ({ name: `drop-colon-${n}`, file: OMT, patches: [around(n, dropColon)], mustFail: [S1A], mustPass: [S1C] })),
  // A whole flow back in prefix form; mustPass is the same flow's exact-present arm.
  { name: "revert-remove", file: OMT, patches: [block(BLOCK.remove, revert)], mustFail: [B1A], mustPass: [B1B] },
  { name: "revert-attach-name", file: OMT, patches: [block(BLOCK.attachName, revert)], mustFail: [B2A], mustPass: [B2B] },
  { name: "revert-attach-hub", file: OMT, patches: [block(BLOCK.attachHub, revert)], mustFail: [B3A], mustPass: [B3B] },
  { name: "revert-attach-router", file: OMT, patches: [block(BLOCK.attachRouter, revert)], mustFail: [B3A], mustPass: [B3B] },
  { name: "revert-stop", file: OMT, patches: [block(BLOCK.stopHub, revert), block(BLOCK.stopRouter, revert)], mustFail: [B4A], mustPass: [B4B] },
  { name: "revert-status", file: OMT, patches: [block(BLOCK.status, revert)], mustFail: [B5A], mustPass: [B5B] },
  { name: "revert-add", file: OMT, patches: [block(BLOCK.addFirst, revert), block(BLOCK.addLoop, revert)], mustFail: [B6A], mustPass: [B6B] },
  // `=name` without the colon is no pane target: no Enter arrives, omt-app survives (F2 row 10, P3).
  { name: "revert-add-colon-only", file: OMT, patches: [block(BLOCK.addFirst, dropColon), block(BLOCK.addLoop, dropColon)], mustFail: [B6B], mustPass: [B6A] },
  { name: "revert-restore", file: OMT, patches: [block(BLOCK.restoreFirst, revert), block(BLOCK.restoreLoop, revert)], mustFail: [B7A], mustPass: [B7B] },
  { name: "revert-restore-colon-only", file: OMT, patches: [block(BLOCK.restoreFirst, dropColon), block(BLOCK.restoreLoop, dropColon)], mustFail: [B7B], mustPass: [B7A] },
  { name: "M-pin", file: HARNESS, patches: [[PIN, ":\n"]], mustFail: [C0A], mustPass: [C0B] },
  { name: "pin-allows-clustered-S", file: HARNESS, patches: [[CLUSTERED_S, "      S) break ;;\n"]], mustFail: [C0D], mustPass: [C0A] },
];

// ── Runner ────────────────────────────────────────────────────────────────

function count(h: string, n: string): number {
  let c = 0;
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) c++;
  return c;
}

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let copyN = 0;
function freshCopy(): string {
  const dir = path.join(ROOT, `copy-${++copyN}`);
  for (const e of COPY) {
    mkdirSync(path.dirname(path.join(dir, e)), { recursive: true });
    cpSync(path.join(REPO, e), path.join(dir, e), { recursive: true });
  }
  return dir;
}

interface Result {
  passed: string[];
  failed: string[];
  skipped: string[];
  output: string;
}

function run(m: { file?: string; patches: Patch[]; only?: string[]; timeoutMs: number }): Result {
  const dir = freshCopy();
  if (m.file) {
    const target = path.join(dir, m.file);
    const original = readFileSync(target, "utf-8");
    let src = original;
    for (const [find, replace] of m.patches) {
      const n = count(src, find);
      if (n !== 1) throw new Error(`HARNESS BROKEN: patch on ${m.file} matched ${n} times: ${JSON.stringify(find.slice(0, 120))}`);
      if (find === replace) throw new Error(`HARNESS BROKEN: patch on ${m.file} changes nothing: ${JSON.stringify(find.slice(0, 120))}`);
      src = src.replace(find, () => replace);
    }
    if (src === original) throw new Error(`HARNESS BROKEN: the patched ${m.file} is byte-identical to the original`);
    writeFileSync(target, src);
  }
  const report = path.join(dir, "junit.xml");
  const args = [process.execPath, "test", `./${SUITE}`, "--reporter=junit", `--reporter-outfile=${report}`];
  if (m.only) args.push("-t", m.only.map(escapeRe).join("|"));
  const proc = Bun.spawnSync(args, {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", TMPDIR: "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: m.timeoutMs,
  });
  const output = proc.stdout.toString() + proc.stderr.toString();
  if (proc.exitedDueToTimeout) throw new Error(`HARNESS BROKEN: ${SUITE} ran past ${m.timeoutMs} ms\n${output.slice(-2000)}`);
  if (!existsSync(report)) throw new Error(`HARNESS BROKEN: no JUnit report for ${SUITE}\n${output.slice(-2000)}`);
  const xml = readFileSync(report, "utf-8");
  const r: Result = { passed: [], failed: [], skipped: [], output };
  for (const x of xml.matchAll(/<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const title = unescapeXml(x[1]);
    const body = x[2] ?? "";
    if (body.includes("<failure") || body.includes("<error")) r.failed.push(title);
    else if (body.includes("<skipped")) r.skipped.push(title);
    else r.passed.push(title);
  }
  rmSync(dir, { recursive: true, force: true });
  return r;
}

describe("tmux-exact removal control", () => {
  let baseline: Result | undefined;

  test("baseline: the unmutated copy passes all 22 tmux-exact tests (else HARNESS BROKEN)", () => {
    baseline = run({ patches: [], timeoutMs: BASELINE_TIMEOUT_MS });
    expect({ failed: baseline.failed, skipped: baseline.skipped, passed: baseline.passed.length }).toEqual({ failed: [], skipped: [], passed: 22 });
  });

  test("every title named by a mutant exists in the suite (else HARNESS BROKEN)", () => {
    expect(baseline).toBeDefined();
    for (const m of MUTANTS) {
      for (const t of [...m.mustFail, ...m.mustPass]) expect({ mutant: m.name, title: t, known: baseline!.passed.includes(t) }).toEqual({ mutant: m.name, title: t, known: true });
    }
  });

  for (const m of MUTANTS) {
    test(`mutant caught: ${m.name}`, () => {
      const r = run({ file: m.file, patches: m.patches, only: [...m.mustFail, ...m.mustPass], timeoutMs: MUTANT_TIMEOUT_MS });
      // The copy's output is otherwise lost: print it when a result is unexpected, so a flake can be diagnosed.
      const unexpected = [...m.mustFail.filter((t) => !r.failed.includes(t)), ...m.mustPass.filter((t) => !r.passed.includes(t))];
      if (unexpected.length) console.log(`--- ${m.name}: unexpected result for: ${unexpected.join(" | ")}\n${r.output.slice(-8000)}`);
      for (const t of m.mustFail) expect({ mutant: m.name, test: t, failed: r.failed.includes(t) }).toEqual({ mutant: m.name, test: t, failed: true });
      for (const t of m.mustPass) expect({ mutant: m.name, test: t, passed: r.passed.includes(t) }).toEqual({ mutant: m.name, test: t, passed: true });
    });
  }
});

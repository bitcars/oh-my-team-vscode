/**
 * Removal control for the hub-delegate kit (test/hub-delegate.test.ts, #69 item A, plan §4). It
 * follows test/ledger-compact.control.test.ts: each mutant TEXTUALLY patches one script in a copy,
 * runs that copy's kit with a JUnit report, filtered by -t to the mutant's named titles, and asserts
 * the mustFail titles fail and the mustPass titles pass, so the mutant is caught by the row meant to
 * catch it, not by a crash.
 *
 * The copy is the whole worktree: a `git clone --no-local` of it (its origin remote removed), under
 * realpath /tmp, never inside another git repository. Before any run the control asserts that the
 * copy's history holds the base commit and that the copy is its own worktree's top, then overlays
 * every path `git diff-index --name-only HEAD` lists (index and worktree changes against HEAD): the
 * worktree's bytes, or the path removed when the worktree lacks it. So the copy also holds a staged,
 * uncommitted change, as on rerun.sh's tree (HEAD = base, the change applied with --index); the
 * overlaid paths are also staged in the copy's own index, as apply --index does. Untracked
 * files not in the index are not overlaid. Every git call here runs in a closed env (no GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE or GIT_COMMON_DIR). After the overlay the kit, ledger.sh, rerun.sh
 * and the patched file must equal the worktree's (else HARNESS BROKEN); the patch source is the
 * worktree's file.
 *
 * Three assertions run the copy's scripts directly: the restore (ledger.sh's post-write check fails
 * and the old bytes come back), the CAS (a byte written under ledger.sh is kept, not overwritten),
 * and finish-TERM (a TERM while rerun.sh's finish runs still leaves rc.txt and done).
 * Processes: at most one TERM per spawned pid, never -9; a pid still alive (no exit code, no signal)
 * after it is reported "LIVE" and its root held, never deleted. failureText reads bun's stderr only.
 * Never delete a mutant to go green. "HARNESS BROKEN" means the control measures nothing.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

setDefaultTimeout(1_800_000);

const REPO = path.resolve(import.meta.dir, "..");
const KIT = "test/hub-delegate.test.ts";
const LEDGER = "skills/hub-delegate/ledger.sh";
const RERUN = "skills/hub-delegate/rerun.sh";
const FIXTURE = "test/fixtures/hub-delegate/LWO-001-x.md";
const DESCRIBE = "hub-delegate kit";
/** The kit's 81 titles, in kit order, read from its test("…") lines (four come from one for-of). */
const EXPECTED_TITLES: readonly string[] = [
  "LD-log", "LD-log-nonl", "LD-now-15", "LD-now-16", "LD-now-15-nonl", "LD-now-16-nonl", "LD-now-crlf",
  "LD-now-nostate", "LD-now-quoted-state", "LD-now-empty-state", "LD-now-nodot-state", "LD-now-lower-state",
  "LD-now-header", "LD-now-empty", "LD-now-missing", "LD-now-longline", "LD-path-dotdot", "LD-path-link-out",
  "LD-path-link-in", "LD-path-corp", "LD-path-name", "LD-path-ok", "LD-root-rel", "LD-missing", "LD-text", "LD-shape",
  "LD-shape-inner", "LD-show-12", "LD-show-n", "LD-verb", "LD-tmp-clean", "LD-hook-absent", "LD-node-absent",
  "LD-hook-throws", "LD-hook-garbage", "LD-now-mb-1000", "LD-now-mb-1001", "LD-mode", "LD-grep", "LD-serial",
  "LD-now-split-utf8", "RR-sha", "RR-head", "RR-unstaged", "RR-untracked", "RR-d", "RR-d-above", "RR-mode",
  "RR-detach", "RR-killed", "RR-env", "RR-shims", "RR-remotes", "RR-one-line", "RR-apply", "RR-neverstaged",
  "RR-forbidden", "RR-footer", "RR-nm-source", "RR-shim-eq", "RR-busy", "RR-relpath", "RR-sandboxes", "RR-warmup",
  "RR-ok", "RR-empty", "RR-suites", "RR-absent", "RR-binary-log", "RR-unhandled", "RR-crash", "RR-tsc", "RR-git-abs",
  "HR-front", "HR-probe", "SK-front", "SK-lines", "SK-steps", "SK-briefs", "SK-nolwo", "SK-pid-reuse",
];
const KIT_TITLES = 81;
/** spawnSync bounds: a whole or filtered kit run, and every other child (git, bash -n, ledger.sh). */
const KIT_TIMEOUT_MS = 900_000;
const PROBE_TIMEOUT_MS = 60_000;
const BASE = "26046849865c6477fc576dd94c25a251ded257e2";
const TMP = realpathSync("/tmp");
const ROOT_PREFIX = path.join(TMP, "hub-delegate-control-");
/** The closed env of every git call the control makes: no GIT_* location variable is set. */
const GENV = { HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: "/usr/bin:/bin" };

const roots: string[] = [];
/** Roots under a process that did not exit: never deleted, reported with its pid. */
const held = new Map<string, number>();
/** Remove a root this control made: only an exact path it created, under the literal prefix. */
function removeRoot(dir: string) {
  if (!roots.includes(dir) || !dir.startsWith(ROOT_PREFIX) || dir.includes("/../")) throw new Error(`HARNESS BROKEN: refusing to remove ${dir}`);
  if (held.has(dir)) {
    console.log(`LIVE: pid ${held.get(dir)} did not exit; its root ${dir} is left in place`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  roots.splice(roots.indexOf(dir), 1);
}
afterAll(() => {
  for (const d of [...roots]) removeRoot(d);
});

const sha1 = (b: Buffer | string) => createHash("sha1").update(b).digest("hex");

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Every character of \^$.|?*+()[]{} and -, > escaped (bun's -t is an unanchored regex). */
function escapeTitle(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}\->]/g, "\\$&");
}

/** -t pattern that selects exactly these titles: bun matches "<describe> <title>". */
function onlyPattern(titles: string[]): string {
  return `^${DESCRIBE} (${titles.map(escapeTitle).join("|")})$`;
}

/** spawnSync with a timeout and SIGTERM to the exact child; a timeout is HARNESS BROKEN. */
function spawnBounded(cmd: string[], opts: { cwd?: string; env: Record<string, string> }, timeout: number) {
  const p = Bun.spawnSync(cmd, { ...opts, stdout: "pipe", stderr: "pipe", timeout, killSignal: "SIGTERM" });
  if (p.exitedDueToTimeout) throw new Error(`HARNESS BROKEN: ${cmd.slice(0, 3).join(" ")} … timed out after ${timeout} ms (SIGTERM sent)`);
  return p;
}

function git(args: string[], cwd: string) {
  const p = spawnBounded(["/usr/bin/git", ...args], { cwd, env: GENV }, PROBE_TIMEOUT_MS);
  return { rc: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

type Patch = [find: string, replace: string];

/**
 * Overlay onto the copy every path `diff-index --name-only HEAD` lists in the worktree (index and
 * worktree changes against HEAD): its bytes, or the path removed when the worktree lacks it.
 */
function overlay(copy: string, root: string) {
  const d = git(["-C", REPO, "diff-index", "--name-only", "HEAD", "--"], root);
  if (d.rc !== 0) throw new Error(`HARNESS BROKEN: diff-index failed (rc ${d.rc})\n${d.err}`);
  const paths = d.out.split("\n").filter((l) => l !== "");
  for (const f of paths) {
    if (f.startsWith('"') || path.isAbsolute(f) || f.split("/").includes("..")) throw new Error(`HARNESS BROKEN: diff-index path not plain: ${JSON.stringify(f)}`);
    const from = path.join(REPO, f);
    const to = path.join(copy, f);
    if (existsSync(from)) {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
    } else rmSync(to, { force: true });
  }
  if (paths.length === 0) return;
  // Stage the same paths in the copy's own index, as apply --index does on rerun.sh's tree, so a
  // kit row that reads the index (SK-nolwo's diff-index) sees the new files.
  const u = git(["-C", copy, "update-index", "--add", "--remove", "--", ...paths], root);
  if (u.rc !== 0) throw new Error(`HARNESS BROKEN: update-index on the copy failed (rc ${u.rc})\n${u.err}`);
}

/**
 * A fresh copy: the worktree cloned (origin removed), its history and top checked, the worktree's
 * changes against HEAD overlaid, then each file's patches applied to the worktree's bytes (each find
 * exactly once) and written over the copy's file.
 */
function freshCopy(edits: { file: string; patches: Patch[] }[] = []): { root: string; copy: string } {
  const root = mkdtempSync(ROOT_PREFIX);
  roots.push(root);
  try {
    return fillCopy(root, edits);
  } catch (e) {
    removeRoot(root);
    throw e;
  }
}

function fillCopy(root: string, edits: { file: string; patches: Patch[] }[]): { root: string; copy: string } {
  const copy = path.join(root, "copy");
  const cl = git(["-c", "protocol.file.allow=always", "clone", "-q", "--no-local", REPO, copy], root);
  if (cl.rc !== 0) throw new Error(`HARNESS BROKEN: clone failed (rc ${cl.rc})\n${cl.err}`);
  const rr = git(["-C", copy, "remote", "remove", "origin"], root);
  const rl = git(["-C", copy, "remote"], root);
  expect({ rmRc: rr.rc, rc: rl.rc, remotes: rl.out }).toEqual({ rmRc: 0, rc: 0, remotes: "" });
  const base = git(["-C", copy, "rev-parse", "--verify", `${BASE}^{commit}`], root);
  expect({ rc: base.rc, sha: base.out.trim() }).toEqual({ rc: 0, sha: BASE });
  const top = git(["-C", copy, "rev-parse", "--show-toplevel"], root);
  expect({ rc: top.rc, top: top.out.trim() }).toEqual({ rc: 0, top: realpathSync(copy) });
  overlay(copy, root);
  for (const f of [KIT, LEDGER, RERUN, ...edits.map((e) => e.file)]) {
    const same = existsSync(path.join(copy, f)) && readFileSync(path.join(REPO, f)).equals(readFileSync(path.join(copy, f)));
    if (!same) throw new Error(`HARNESS BROKEN: ${f} in the copy differs from the worktree after the overlay`);
  }
  for (const e of edits) {
    const target = path.join(copy, e.file);
    const original = readFileSync(path.join(REPO, e.file), "utf8");
    let source = original;
    for (const [find, replace] of e.patches) {
      const n = countOccurrences(source, find);
      if (n !== 1) throw new Error(`HARNESS BROKEN: patch on ${e.file} matched ${n} times (expected exactly 1): ${JSON.stringify(find.slice(0, 80))}`);
      source = source.replace(find, () => replace);
    }
    if (source === original) throw new Error(`NO-OP: the patches leave ${e.file} unchanged`);
    writeFileSync(target, source);
    expect({ file: e.file, changed: readFileSync(target, "utf8") !== original }).toEqual({ file: e.file, changed: true });
    const syn = spawnBounded(["/bin/bash", "-n", target], { env: GENV }, PROBE_TIMEOUT_MS);
    expect({ file: e.file, bashN: syn.exitCode, err: syn.stderr.toString() }).toEqual({ file: e.file, bashN: 0, err: "" });
  }
  return { root, copy };
}

interface KitResult {
  exitCode: number;
  ran: number | null;
  passed: string[];
  failed: string[];
  skipped: string[];
  /** stdout then stderr, for the logs. */
  output: string;
  /** stderr alone: bun 1.3 prints its errors, result lines and "Ran N" there. */
  stderr: string;
}

/** Run the copy's kit (all of it, or only these titles) with a JUnit report. */
function runKit(copy: string, only?: string[]): KitResult {
  const report = path.join(path.dirname(copy), "junit.xml");
  const args = [process.execPath, "test", `./${KIT}`, "--reporter=junit", `--reporter-outfile=${report}`];
  if (only) args.push("-t", onlyPattern(only));
  const proc = spawnBounded(args, {
    cwd: copy,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent", TMPDIR: "/tmp" },
  }, KIT_TIMEOUT_MS);
  const stderr = proc.stderr.toString();
  const output = proc.stdout.toString() + stderr;
  if (!existsSync(report)) throw new Error(`HARNESS BROKEN: no JUnit report written (exit ${proc.exitCode})\n${output.slice(-3000)}`);
  const xml = readFileSync(report, "utf8");
  const r: KitResult = { exitCode: proc.exitCode ?? -1, ran: null, passed: [], failed: [], skipped: [], output, stderr };
  for (const m of xml.matchAll(/<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const title = unescapeXml(m[1]);
    const body = m[2] ?? "";
    if (body.includes("<failure") || body.includes("<error")) r.failed.push(title);
    else if (body.includes("<skipped")) r.skipped.push(title);
    else r.passed.push(title);
  }
  const ran = stderr.match(/^Ran (\d+) tests? across \d+ files?\./m);
  r.ran = ran ? Number(ran[1]) : null;
  return r;
}

/**
 * The error bun printed for a failed test: from the previous result line (or stderr's start) to
 * "(fail) … <title> [". It reads stderr alone, so it never reaches into stdout.
 */
function failureText(stderr: string, title: string): string | null {
  const lines = stderr.split("\n");
  const end = lines.findIndex((l) => l.startsWith("(fail) ") && (l.startsWith(`(fail) ${title} [`) || l.includes(` > ${title} [`)));
  if (end < 0) return null;
  let start = end - 1;
  while (start >= 0 && !/^\((fail|pass|skip|todo)\) /.test(lines[start])) start--;
  return lines.slice(start + 1, end).join("\n");
}

// ── direct probes on a copy's scripts ────────────────────────────────────────

interface Probe {
  rc: number;
  err: string;
  before: Buffer;
  after: Buffer;
}

/** One ledger.sh call (log "x", or now with a 2-line block) on a fresh fixture ledger in <root>. */
function ledgerProbe(root: string, copy: string, verb: "log" | "now"): Probe {
  const fx = mkdtempSync(path.join(root, "fx-"));
  const vault = path.join(fx, "vault");
  const tasks = path.join(vault, "lab", "tasks");
  mkdirSync(tasks, { recursive: true });
  mkdirSync(path.join(fx, "tmp"));
  const before = readFileSync(path.join(copy, FIXTURE));
  const l = path.join(tasks, "LWO-001-x.md");
  writeFileSync(l, before);
  const arg = verb === "log" ? "x" : path.join(fx, "now.txt");
  if (verb === "now") writeFileSync(arg, "Order: o. Tier: L. State: X.\n- a\n");
  const env = { HOME: fx, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", OMT_VAULT_ROOT: vault, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: path.join(fx, "tmp") };
  const p = spawnBounded(["/bin/bash", path.join(copy, LEDGER), l, verb, arg], { cwd: fx, env }, PROBE_TIMEOUT_MS);
  return { rc: p.exitCode ?? -1, err: p.stderr.toString(), before, after: readFileSync(l) };
}

/** The restore: rc 3, "post-write check failed, restored", and the ledger's sha1 is the old one. */
function restoreHolds(p: Probe): boolean {
  return p.rc === 3 && p.err.includes("ledger.sh: post-write check failed, restored\n") && sha1(p.after) === sha1(p.before);
}

/** The CAS: rc 3, L13, and the byte written under ledger.sh is kept after the new row. */
function casHolds(p: Probe): boolean {
  return p.rc === 3 && p.err.includes("ledger.sh: L13: changed under me, not restored\n") &&
    p.after.subarray(0, p.before.length).equals(p.before) && /\n- \S+ x\nZ$/.test(p.after.subarray(p.before.length - 1).toString());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * finish-TERM: run the copy's rerun.sh --run on a tree that does not exist (R2 refuses, so finish
 * runs), wait for the summary's rerun-rc line, send one TERM to the exact pid this control spawned,
 * and report what out/ holds once it has exited. At most one TERM is ever sent; if the pid is still
 * alive at the end its root is held (left in place, pid reported), never deleted under it.
 */
async function finishTerm(root: string, copy: string): Promise<{ inSleep: boolean; termSent: boolean; exited: boolean; rcTxt: string | null; done: boolean; summaryRc: string | null }> {
  const d = mkdtempSync(path.join(root, "d-"));
  mkdirSync(path.join(d, "out"));
  const suites = path.join(root, "suites.txt");
  writeFileSync(suites, "bun test test/x.test.ts\n");
  const env = { HOME: d, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: "/usr/bin:/bin", TMPDIR: path.join(root) };
  const proc = Bun.spawn(["/bin/bash", path.join(copy, RERUN), "--run", d, path.join(root, "no-such-tree"), BASE, "0".repeat(40), suites], { cwd: root, env, stdout: "ignore", stderr: "ignore" });
  const summary = path.join(d, "out", "summary.txt");
  const rcFile = path.join(d, "out", "rc.txt");
  let inSleep = false;
  let termSent = false;
  try {
    for (let i = 0; i < 200 && proc.exitCode === null && proc.signalCode === null; i++) {
      if (existsSync(summary) && /^rerun-rc: /m.test(readFileSync(summary, "utf8"))) {
        inSleep = !existsSync(rcFile);
        break;
      }
      await sleep(50);
    }
    if (proc.exitCode === null && proc.signalCode === null && inSleep) {
      proc.kill("SIGTERM");
      termSent = true;
    }
    const exited = await Promise.race([proc.exited.then(() => true), sleep(15_000).then(() => false)]);
    const rcTxt = existsSync(rcFile) ? readFileSync(rcFile, "utf8") : null;
    const last = existsSync(summary) ? readFileSync(summary, "utf8").trimEnd().split("\n").at(-1) ?? null : null;
    return { inSleep, termSent, exited, rcTxt, done: existsSync(path.join(d, "out", "done")), summaryRc: last };
  } finally {
    // The exact pid this control spawned. Only if no TERM went out yet (an error before it) does it
    // get its one TERM here; a pid still alive after that is reported and its root held.
    if (proc.exitCode === null && proc.signalCode === null && !termSent) {
      proc.kill("SIGTERM");
      termSent = true;
      await Promise.race([proc.exited, sleep(15_000)]);
    }
    if (proc.exitCode === null && proc.signalCode === null) held.set(root, proc.pid);
  }
}

const FINISH_SLEEP: Patch = ['    } >> out/summary.txt\n    echo "$RESULT" > out/rc.txt\n', '    } >> out/summary.txt\n    sleep 3\n    echo "$RESULT" > out/rc.txt\n'];

// ── the ML mutants (plan §4: ML1-ML29, 31 mutants) ───────────────────────────

type Assertion = "restore-holds" | "restore-fails" | "cas-holds" | "cas-fails";

interface Mutant {
  id: string;
  what: string;
  patches: Patch[];
  mustFail: string[];
  mustPass: string[];
  /** A mustFail title's failure text (stderr) must match this (corp-mode.control's mustFailWith). */
  mustFailWith?: Record<string, RegExp>;
  /** A control-side assertion on the copy's ledger.sh, and the verb it runs. */
  assertion?: { kind: Assertion; verb: "log" | "now" };
}

const DOUBLE_ROW: Patch = [`printf '%s' "$SUFFIX"; tail -c`, `printf '%s' "$SUFFIX"; printf '%s' "$SUFFIX"; tail -c`];
const LOG_CHECK_FAILS: Patch = ["    return 0\n  fi\n  local old_now", "    return 1\n  fi\n  local old_now"];
const FOREIGN_BYTE: Patch = ['  if cmp -s "$R" "$WROTE"; then\n', `  printf 'Z' >> "$R"\n  if cmp -s "$R" "$WROTE"; then\n`];
const NOW_WRITE = '{ head -n "$NOW_LN" "$OLD"; cat "$NORM"; tail -n "+$LOG_LN" "$OLD"; } > "$WROTE"';
/** The kit's failure text for an rc-3 refusal: the line alone, so "Received: 30" does not match. */
const RESTORE_MSG = /^Received: 3$/m;

const MUTANTS: Mutant[] = [
  {
    id: "ML1", what: "the dirname realpath comparison always true",
    patches: [['  [ "$d" = "$TASKS" ] || refuse 1', '  true || refuse 1']],
    mustFail: ["LD-path-dotdot", "LD-path-link-out", "LD-path-corp"], mustPass: ["LD-path-ok", "LD-log"],
  },
  {
    id: "ML2", what: "the basename regex is \\.md$",
    patches: [["NAME_RE='^LWO-[0-9]{3,}-[^/]*\\.md$'", "NAME_RE='\\.md$'"]],
    mustFail: ["LD-path-name"], mustPass: ["LD-path-ok"],
  },
  {
    id: "ML3", what: "the L3 exists check removed",
    patches: [["[ -f \"$R\" ] && [ -r \"$R\" ] && [ ! -L \"$R\" ] || refuse 3 'no such ledger'\n", ""]],
    mustFail: ["LD-missing"], mustPass: ["LD-log"],
  },
  {
    id: "ML4", what: "the 15-line cap is 16",
    patches: [['[ "$lines" -le 15 ]', '[ "$lines" -le 16 ]']],
    mustFail: ["LD-now-16"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML5", what: "L8 (none refused) removed: none is accepted and written",
    patches: [["    none) refuse 8 'no State the hook can read' ;;", "    none) ;;"]],
    mustFail: ["LD-now-nostate", "LD-now-quoted-state"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML6", what: "L9 removed",
    patches: [["  [ \"$hdr\" -eq 0 ] || refuse 9 '## line in now file'\n", ""]],
    mustFail: ["LD-now-header"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML7", what: "the log newline/CR check removed",
    patches: [["    *$'\\r'* | *$'\\n'*) refuse 5 'CR or newline in text' ;;\n", ""]],
    mustFail: ["LD-text"], mustPass: ["LD-log"],
  },
  {
    id: "ML8a", what: "the append writes the row twice; the post-write check intact",
    patches: [DOUBLE_ROW],
    mustFail: ["LD-log"], mustPass: ["LD-now-15"], mustFailWith: { "LD-log": RESTORE_MSG },
    assertion: { kind: "restore-holds", verb: "log" },
  },
  {
    id: "ML8b", what: "the row twice, and the restore removed",
    patches: [DOUBLE_ROW, ["    swap_in \"$OLD\" || refuse 13 'restore failed' 3\n", ""]],
    mustFail: [], mustPass: ["LD-now-15"],
    assertion: { kind: "restore-fails", verb: "log" },
  },
  {
    id: "ML8c", what: "the row twice, and the restore writes the new bytes back",
    patches: [DOUBLE_ROW, ['    swap_in "$OLD" || refuse 13', '    swap_in "$WROTE" || refuse 13']],
    mustFail: [], mustPass: ["LD-now-15"],
    assertion: { kind: "restore-fails", verb: "log" },
  },
  {
    id: "ML9", what: "the stamp is a fixed 2000-01-01T00:00:00Z",
    patches: [["STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)", "STAMP=2000-01-01T00:00:00Z"]],
    mustFail: ["LD-log"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML10", what: "the show default is 13",
    patches: [["N=${3-12}", "N=${3-13}"]],
    mustFail: ["LD-show-12"], mustPass: ["LD-show-n"],
  },
  {
    id: "ML11", what: "L6 removed (the size and blank checks)",
    patches: [
      ['  [ -f "$F" ] && [ -s "$F" ] || refuse 6 empty\n', ""],
      ['  [ "$blank" -eq 0 ] || refuse 6 empty\n', ""],
    ],
    mustFail: ["LD-now-empty"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML12", what: "now drops the Log's last row",
    patches: [[NOW_WRITE, '{ head -n "$NOW_LN" "$OLD"; cat "$NORM"; tail -n "+$LOG_LN" "$OLD" | sed \'$d\'; } > "$WROTE"']],
    mustFail: ["LD-now-15"], mustPass: ["LD-log"],
  },
  {
    id: "ML14", what: "L14: a node failure treated as State present",
    patches: [
      ["NODE=$(command -v node) || refuse 14 'cannot read State: node absent'", "NODE=$(command -v node) || NODE=/usr/bin/false"],
      ["  [ -f \"$HOOK\" ] || refuse 14 'cannot read State: hook absent'\n", ""],
      ['  [ "$rc" -eq 0 ] || refuse 14 "cannot read State: node rc $rc"', '  [ "$rc" -eq 0 ] || out=state:X']],
    mustFail: ["LD-hook-absent", "LD-node-absent"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML14a", what: "node rc != 0 mapped to L8 (none) instead of L14",
    patches: [['  [ "$rc" -eq 0 ] || refuse 14 "cannot read State: node rc $rc"', "  [ \"$rc\" -eq 0 ] || refuse 8 'no State the hook can read'"]],
    mustFail: ["LD-hook-throws"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML14b", what: "the one-line state:/none form check removed (any stdout is a State)",
    patches: [
      ["    *$'\\n'*) refuse 14 'cannot read State: bad output' ;;\n", ""],
      ["    *) refuse 14 'cannot read State: bad output' ;;", "    *) ;;"],
    ],
    mustFail: ["LD-hook-garbage"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML15", what: "the final-NL normalisation removed",
    patches: [["  ends_nl \"$NORM\" || printf '\\n' >> \"$NORM\"\n", ""]],
    mustFail: ["LD-now-15-nonl"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML16", what: "the now-file CR refusal removed",
    patches: [["    grep -q $'\\r' -- \"$F\" && refuse 5 'CR in now file'\n", ""]],
    mustFail: ["LD-now-crlf"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML17", what: "L4's inner ## refusal removed",
    patches: [['      if [ "$logs" -eq 0 ]; then bad=1; elif', '      if [ "$logs" -eq 0 ]; then :; elif']],
    mustFail: ["LD-shape-inner"], mustPass: ["LD-shape"],
  },
  {
    id: "ML18", what: "the 1000-byte cap is 1001",
    patches: [["awk 'length($0) > 1000 {", "awk 'length($0) > 1001 {"]],
    mustFail: ["LD-now-longline", "LD-now-mb-1001"], mustPass: ["LD-now-15"],
  },
  {
    id: "ML19", what: "link resolution removed and links accepted: mv replaces the given path",
    patches: [
      ["if [ -L \"$LEDGER\" ]; then\n  R=$(/bin/realpath \"$LEDGER\" 2>/dev/null) || refuse 3 'no such ledger'\n  check_place \"$R\"\nelse\n  R=$LEDGER\nfi\n", "R=$LEDGER\n"],
      ['[ -r "$R" ] && [ ! -L "$R" ] ||', '[ -r "$R" ] ||'],
    ],
    mustFail: ["LD-path-link-in", "LD-path-link-out"], mustPass: ["LD-path-ok"],
  },
  {
    id: "ML20", what: "the relative-root refusal removed",
    patches: [["  *) refuse 1 'vault root not absolute' ;;\n", ""]],
    mustFail: ["LD-root-rel"], mustPass: ["LD-path-ok"],
  },
  {
    id: "ML21", what: "the EXIT trap cleanup removed",
    patches: [["  trap 'rm -f -- \"$OLD\" \"$NORM\" \"$WROTE\" \"$VTMP\"' EXIT\n", ""]],
    mustFail: ["LD-tmp-clean"], mustPass: ["LD-log"],
  },
  {
    id: "ML23", what: "the post-write check breaks, and a byte is appended to the ledger before the CAS step",
    patches: [LOG_CHECK_FAILS, FOREIGN_BYTE],
    mustFail: ["LD-log"], mustPass: ["LD-now-15"], mustFailWith: { "LD-log": RESTORE_MSG },
    assertion: { kind: "cas-holds", verb: "log" },
  },
  {
    id: "ML24", what: "ML23's patches, and the CAS compare always equal",
    patches: [LOG_CHECK_FAILS, FOREIGN_BYTE, ['  if cmp -s "$R" "$WROTE"; then\n', "  if true; then\n"]],
    mustFail: [], mustPass: ["LD-now-15"],
    assertion: { kind: "cas-fails", verb: "log" },
  },
  {
    id: "ML25", what: "stateOf(text, true) is stateOf(text)",
    patches: [["const r = m.stateOf(s, true)", "const r = m.stateOf(s)"]],
    // N-S11-1: the flag governs where State may sit (mid-line after ". "), not case, so every
    // mid-line State fixture reads as none; LD-log never reads the State.
    mustFail: ["LD-now-lower-state", "LD-now-15"], mustPass: ["LD-log"],
  },
  {
    id: "ML26", what: "L10's range check removed (show N takes any value)",
    patches: [["  [[ \"$N\" =~ ^[0-9]+$ ]] && [ \"${#N}\" -le 2 ] && [ \"$((10#$N))\" -ge 1 ] && [ \"$((10#$N))\" -le 99 ] ||\n    refuse 10 'show N must be 1..99'\n", ""]],
    mustFail: ["LD-show-n"], mustPass: ["LD-show-12"],
  },
  {
    id: "ML27", what: "L11 removed (an unknown verb falls through to show)",
    patches: [["  *) refuse 11 usage ;;\n", "  *) VERB=show ;;\n"]],
    mustFail: ["LD-verb"], mustPass: ["LD-log"],
  },
  {
    id: "ML28", what: "now writes the input minus its last byte; the post-write check intact",
    patches: [[NOW_WRITE, '{ head -n "$NOW_LN" "$OLD"; head -c "$(($(wc -c < "$NORM") - 1))" "$NORM"; tail -n "+$LOG_LN" "$OLD"; } > "$WROTE"']],
    mustFail: ["LD-now-15"], mustPass: ["LD-log"], mustFailWith: { "LD-now-15": RESTORE_MSG },
    assertion: { kind: "restore-holds", verb: "now" },
  },
  {
    id: "ML29", what: "the Now-block compare decodes the file (node, UTF-8) and compares it with the raw input bytes",
    patches: [[
      'cmp -s <(head -n "$((LOG_LN - 1))" "$R" | tail -n "+$((NOW_LN + 1))") "$NORM"',
      'cmp -s <(head -n "$((LOG_LN - 1))" "$R" | tail -n "+$((NOW_LN + 1))" | "$NODE" -e \'let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { s += c }).on("end", () => process.stdout.write(s))\') "$NORM"',
    ]],
    mustFail: ["LD-now-split-utf8"], mustPass: ["LD-now-15"],
  },
];

function assertionHolds(kind: Assertion, p: Probe): boolean {
  return kind.startsWith("restore") ? restoreHolds(p) : casHolds(p);
}

/** Run fn on a fresh copy and remove its root afterwards, pass or fail (a held root stays). */
async function withCopy<T>(edits: { file: string; patches: Patch[] }[], fn: (root: string, copy: string) => T | Promise<T>): Promise<T> {
  const { root, copy } = freshCopy(edits);
  try {
    return await fn(root, copy);
  } finally {
    removeRoot(root);
  }
}

describe("hub-delegate removal control", () => {
  let baseline: KitResult | null = null;

  test("baseline: the unpatched kit passes exactly the kit's 81 titles, no skips, no repeated title (else HARNESS BROKEN)", async () => {
    expect({ listed: EXPECTED_TITLES.length, unique: new Set(EXPECTED_TITLES).size }).toEqual({ listed: KIT_TITLES, unique: KIT_TITLES });
    baseline = await withCopy([], (_root, copy) => runKit(copy));
    if (baseline.exitCode !== 0) console.log(`--- baseline output\n${baseline.output.slice(-6000)}`);
    expect({ exit: baseline.exitCode, failed: baseline.failed, skipped: baseline.skipped }).toEqual({ exit: 0, failed: [], skipped: [] });
    const all = [...baseline.passed, ...baseline.failed, ...baseline.skipped];
    expect({ repeated: all.filter((t, i) => all.indexOf(t) !== i) }).toEqual({ repeated: [] });
    expect({ passed: [...baseline.passed].sort(), ran: baseline.ran }).toEqual({ passed: [...EXPECTED_TITLES].sort(), ran: KIT_TITLES });
  });

  test("every title named by a mutant exists in the kit, and mutant ids are unique (else HARNESS BROKEN)", () => {
    expect(baseline).not.toBeNull();
    const ids = new Set<string>();
    for (const m of MUTANTS) {
      expect({ id: m.id, unique: !ids.has(m.id) }).toEqual({ id: m.id, unique: true });
      ids.add(m.id);
      for (const t of [...m.mustFail, ...m.mustPass]) expect({ mutant: m.id, title: t, known: baseline!.passed.includes(t) }).toEqual({ mutant: m.id, title: t, known: true });
      for (const t of Object.keys(m.mustFailWith ?? {})) expect({ mutant: m.id, title: t, inMustFail: m.mustFail.includes(t) }).toEqual({ mutant: m.id, title: t, inMustFail: true });
      expect({ mutant: m.id, catches: m.mustFail.length > 0 || m.assertion?.kind.endsWith("-fails") === true }).toEqual({ mutant: m.id, catches: true });
    }
    expect(MUTANTS).toHaveLength(31);
  });

  for (const m of MUTANTS) {
    test(`mutant caught: ${m.id} ${m.what}`, async () => {
      await withCopy([{ file: LEDGER, patches: m.patches }], (root, copy) => {
        const named = [...m.mustFail, ...m.mustPass];
        const r = runKit(copy, named);
        const unexpected = [...m.mustFail.filter((t) => !r.failed.includes(t)), ...m.mustPass.filter((t) => !r.passed.includes(t))];
        if (m.mustFail.length > 0 && m.mustFail.every((t) => r.passed.includes(t))) console.log(`STILL GREEN: ${m.id}`);
        if (unexpected.length) console.log(`--- ${m.id}: unexpected result for: ${unexpected.join(" | ")}\n${r.output.slice(-6000)}`);
        // Presence: the -t pattern ran exactly the named titles (JUnit lists the filtered-out ones as skipped).
        expect({ mutant: m.id, ran: r.ran, junit: r.passed.length + r.failed.length }).toEqual({ mutant: m.id, ran: named.length, junit: named.length });
        for (const t of m.mustFail) expect({ mutant: m.id, title: t, failed: r.failed.includes(t) }).toEqual({ mutant: m.id, title: t, failed: true });
        for (const t of m.mustPass) expect({ mutant: m.id, title: t, passed: r.passed.includes(t) }).toEqual({ mutant: m.id, title: t, passed: true });
        for (const [t, re] of Object.entries(m.mustFailWith ?? {})) {
          const shown = re.test(failureText(r.stderr, t) ?? "");
          expect({ mutant: m.id, title: t, text: String(re), shown }).toEqual({ mutant: m.id, title: t, text: String(re), shown: true });
        }
        if (m.assertion) {
          const p = ledgerProbe(root, copy, m.assertion.verb);
          const holds = assertionHolds(m.assertion.kind, p);
          const want = m.assertion.kind.endsWith("-holds");
          if (!want && holds) console.log(`STILL GREEN: ${m.id} (the ${m.assertion.kind.split("-")[0]} assertion still holds)`);
          expect({ mutant: m.id, assertion: m.assertion.kind, holds, rc: p.rc, err: p.err }).toEqual({ mutant: m.id, assertion: m.assertion.kind, holds: want, rc: p.rc, err: p.err });
        }
      });
    });
  }

  test("restore assertion: under ML8a rc 3 and sha1 = old; under ML8b and ML8c rc 3 and the restored line, but the bytes are not the old ones", async () => {
    const byId = (id: string) => MUTANTS.find((m) => m.id === id) as Mutant;
    const got: Record<string, { rc: number; restored: boolean; sha1Old: boolean; holds: boolean }> = {};
    for (const id of ["ML8a", "ML8b", "ML8c"]) {
      got[id] = await withCopy([{ file: LEDGER, patches: byId(id).patches }], (root, copy) => {
        const p = ledgerProbe(root, copy, "log");
        return { rc: p.rc, restored: p.err.includes("ledger.sh: post-write check failed, restored\n"), sha1Old: sha1(p.after) === sha1(p.before), holds: restoreHolds(p) };
      });
    }
    expect(got.ML8a).toEqual({ rc: 3, restored: true, sha1Old: true, holds: true });
    expect(got.ML8b).toEqual({ rc: 3, restored: true, sha1Old: false, holds: false });
    expect(got.ML8c).toEqual({ rc: 3, restored: true, sha1Old: false, holds: false });
    // Presence: the unpatched ledger.sh writes the row (rc 0), so the restore is the mutant's doing.
    const p0 = await withCopy([], (root, copy) => ledgerProbe(root, copy, "log"));
    expect({ rc: p0.rc, grew: p0.after.length > p0.before.length }).toEqual({ rc: 0, grew: true });
  });

  test("CAS assertion: under ML23 rc 3, L13 and the foreign byte kept; under ML24 rc 3 and the byte is gone", async () => {
    const byId = (id: string) => MUTANTS.find((m) => m.id === id) as Mutant;
    const got: Record<string, { rc: number; l13: boolean; kept: boolean; holds: boolean }> = {};
    for (const id of ["ML23", "ML24"]) {
      got[id] = await withCopy([{ file: LEDGER, patches: byId(id).patches }], (root, copy) => {
        const p = ledgerProbe(root, copy, "log");
        return { rc: p.rc, l13: p.err.includes("ledger.sh: L13: "), kept: p.after.at(-1) === 0x5a, holds: casHolds(p) };
      });
    }
    expect(got.ML23).toEqual({ rc: 3, l13: true, kept: true, holds: true });
    expect(got.ML24).toEqual({ rc: 3, l13: false, kept: false, holds: false });
  });

  test("finish-TERM: a TERM in finish's 3 s sleep after the summary still leaves rc.txt and done", async () => {
    const r = await withCopy([{ file: RERUN, patches: [FINISH_SLEEP] }], (root, copy) => finishTerm(root, copy));
    expect(r).toEqual({ inSleep: true, termSent: true, exited: true, rcTxt: "2\n", done: true, summaryRc: "rerun-rc: 2" });
  });
});

/**
 * Removal control for the hub-delegate kit (test/hub-delegate.test.ts, #69 item A, plan §4). It
 * follows test/ledger-compact.control.test.ts: each mutant TEXTUALLY patches one file in a copy
 * (ledger.sh: ML, rerun.sh: MR, agents/hub-reader.md: MH, SKILL.md: MS; 106 in all),
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
 * After every MR mutant (C-L4), on every exit path, the control TERMs, by exact pid, what is left
 * in the group of each run the kit started from this copy (the leader by its command; a member by
 * its command, or by pgid plus cwd under the run's D), and asserts the group empty.
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
const HUB_READER = "agents/hub-reader.md";
const SKILL = "skills/hub-delegate/SKILL.md";
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
/** G1: the number of find entries over all 106 mutants (ML 41, MR and MH 57, MS 22), set at implementation; G1 asserts it. */
const PATCHES = 120;
/** spawnSync bounds: a whole or filtered kit run, and every other child (git, bash -n, ledger.sh). */
const KIT_TIMEOUT_MS = 900_000;
const PROBE_TIMEOUT_MS = 60_000;
const BASE = "26046849865c6477fc576dd94c25a251ded257e2";
const TMP = realpathSync("/tmp");
const ROOT_PREFIX = path.join(TMP, "hub-delegate-control-");
/** The closed env of every git call the control makes: no GIT_* location variable is set. */
const GENV = { HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: "/usr/bin:/bin" };

const roots: string[] = [];
/** Roots under a process that did not exit: never deleted, reported with every such pid (F5). */
const held = new Map<string, number[]>();
const hold = (root: string, pid: number) => {
  const pids = held.get(root) ?? [];
  if (!pids.includes(pid)) pids.push(pid);
  held.set(root, pids);
};
/** Remove a root this control made: only an exact path it created, under the literal prefix. */
function removeRoot(dir: string) {
  if (!roots.includes(dir) || !dir.startsWith(ROOT_PREFIX) || dir.includes("/../")) throw new Error(`HARNESS BROKEN: refusing to remove ${dir}`);
  if (held.has(dir)) {
    console.log(`LIVE: pid ${held.get(dir)?.join(" ")} did not exit; its root ${dir} is left in place`);
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
    if (e.file.endsWith(".sh")) {
      const syn = spawnBounded(["/bin/bash", "-n", target], { env: GENV }, PROBE_TIMEOUT_MS);
      expect({ file: e.file, bashN: syn.exitCode, err: syn.stderr.toString() }).toEqual({ file: e.file, bashN: 0, err: "" });
    }
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
  return parseKit(report, proc.exitCode ?? -1, proc.stdout.toString(), proc.stderr.toString());
}

/** The JUnit report and bun's stderr of one kit run, as a KitResult. */
function parseKit(report: string, exitCode: number, stdout: string, stderr: string): KitResult {
  const output = stdout + stderr;
  if (!existsSync(report)) throw new Error(`HARNESS BROKEN: no JUnit report written (exit ${exitCode})\n${output.slice(-3000)}`);
  const xml = readFileSync(report, "utf8");
  const r: KitResult = { exitCode, ran: null, passed: [], failed: [], skipped: [], output, stderr };
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

/** A run the kit started from this copy (C-L4, N-S12-1): its leader pid, its fixture D, its command. */
interface RunRecord {
  pid: number;
  d: string;
  command: string;
}

const psCommand = (pid: number) => {
  const p = spawnBounded(["/bin/ps", "-ww", "-o", "command=", "-p", String(pid)], { env: GENV }, PROBE_TIMEOUT_MS);
  return p.exitCode === 0 ? p.stdout.toString().trim() : "";
};
const psPgid = (pid: number) => {
  const p = spawnBounded(["/bin/ps", "-o", "pgid=", "-p", String(pid)], { env: GENV }, PROBE_TIMEOUT_MS);
  return p.exitCode === 0 ? Number(p.stdout.toString().trim()) : -1;
};
/** The pid's cwd as lsof prints it (read-only); "" when lsof names none. */
const lsofCwd = (pid: number) => {
  const p = spawnBounded(["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { env: GENV }, PROBE_TIMEOUT_MS);
  const line = p.stdout.toString().split("\n").find((x) => x.startsWith("n"));
  return line ? line.slice(1) : "";
};
/** `pgrep -g`: rc 1 is an empty group, rc 0 the listed pids, anything else HARNESS BROKEN (F4). */
const pgrepGroup = (pid: number): number[] => {
  const p = spawnBounded(["/usr/bin/pgrep", "-g", String(pid)], { env: GENV }, PROBE_TIMEOUT_MS);
  if (p.exitCode === 1) return [];
  if (p.exitCode !== 0) throw new Error(`HARNESS BROKEN: pgrep -g ${pid} exited ${p.exitCode}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().split("\n").filter((x) => /^[0-9]+$/.test(x)).map(Number);
};

/**
 * runKit for an MR mutant (N-S12-1): the same argv, env and bound, run with Bun.spawn so the control
 * can poll, every 100 ms and read-only, /private/tmp/hub-delegate-kit-*\/*\/out/pid while the kit
 * runs. A pid is recorded, into the caller's `runs` (filled in place, so the caller reaps them on
 * every exit path, F1), only when its command line holds this control's copy (`<copy>/`), with the
 * D whose out/pid named it; a leader that exits before the first poll is not recorded. The kit gets
 * at most one TERM (on the timeout or a failed watch, F2); after it, 15 s for the kit to exit, else
 * its pid is held with the root and the run is HARNESS BROKEN (F3).
 */
async function runKitWatched(root: string, copy: string, only: string[], runs: RunRecord[]): Promise<KitResult> {
  const report = path.join(path.dirname(copy), "junit.xml");
  const args = [process.execPath, "test", `./${KIT}`, "--reporter=junit", `--reporter-outfile=${report}`, "-t", onlyPattern(only)];
  const proc = Bun.spawn(args, {
    cwd: copy,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent", TMPDIR: "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const outText = new Response(proc.stdout).text();
  const errText = new Response(proc.stderr).text();
  const alive = () => proc.exitCode === null && proc.signalCode === null;
  let termSent = false;
  const termOnce = (why: string) => {
    if (alive() && !termSent) {
      proc.kill("SIGTERM");
      termSent = true;
      console.log(`kit pid ${proc.pid}: TERM (${why})`);
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    termOnce("timeout");
  }, KIT_TIMEOUT_MS);
  const seen = new Set<string>();
  const glob = new Bun.Glob("hub-delegate-kit-*/*/out/pid");
  const scan = () => {
    let rels: string[];
    try {
      rels = [...glob.scanSync({ cwd: TMP, onlyFiles: true })];
    } catch (e) {
      // The kit removed a directory under the scan (its afterAll, a run's cleanup): retry at the next poll.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const rel of rels) {
      const file = path.join(TMP, rel);
      let first = "";
      try {
        first = readFileSync(file, "utf8").split("\n")[0];
      } catch (e) {
        // Removed between the scan and the read: the kit cleaned it. Anything else is not expected.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (!/^[1-9][0-9]*$/.test(first) || seen.has(`${file} ${first}`)) continue;
      seen.add(`${file} ${first}`);
      const command = psCommand(Number(first));
      if (command.includes(`${copy}/`)) runs.push({ pid: Number(first), d: path.dirname(path.dirname(file)), command });
    }
  };
  let failure: unknown = null;
  try {
    while (alive() && !timedOut) {
      scan();
      await sleep(100);
    }
  } catch (e) {
    failure = e;
  } finally {
    clearTimeout(timer);
  }
  if (failure !== null || timedOut) {
    // The watch failed or the kit timed out: its one TERM (none if the timer sent it), then 15 s.
    termOnce(timedOut ? "timeout" : "watch failed");
    const exited = await Promise.race([proc.exited.then(() => true), sleep(15_000).then(() => false)]);
    if (!exited && alive()) {
      hold(root, proc.pid);
      throw new Error(`HARNESS BROKEN: the kit (pid ${proc.pid}) is still alive 15 s after its TERM; its root is held`, { cause: failure ?? undefined });
    }
    throw failure ?? new Error(`HARNESS BROKEN: the kit timed out after ${KIT_TIMEOUT_MS} ms (SIGTERM sent)`);
  }
  await proc.exited;
  return parseKit(report, proc.exitCode ?? -1, await outText, await errText);
}

/**
 * C-L4: for each recorded run, list `pgrep -g <pid>` and TERM each listed pid once, by its exact
 * number, never -9. Just before each TERM the pid must still be ours. The leader (the recorded pid):
 * its command holds the copy (`<copy>/`) (02:03Z, F6). A member (N-S12-1 as amended): its command
 * holds `<copy>/` or the run's fixture D (`<D>/`), or its pgid equals the leader's pid AND its cwd
 * lies under `<D>/` (the suites run in `<D>/w`, rerun.sh :567, with a relative command such as
 * `bun test test/wait.test.ts`). The cwd is compared as a string, never stat'ed: the kit's afterAll
 * may remove D before the member exits. A pid ps no longer shows is logged `gone [q]`; any other is
 * logged `skipped: command changed [q "cmd" cwd "…"]` (R3); neither is signalled. Then up to 5 s for
 * the group to empty. A pid still alive is held with the root. R4: a probe that fails for one run
 * holds that run's leader and every pid listed so far and the reap goes on; after the loop the first
 * failure is thrown, with the caller's original error (`original`) as its cause.
 */
async function reapGroups(id: string, root: string, copy: string, runs: RunRecord[], original?: unknown): Promise<{ id: string; left: string[] }> {
  const left: string[] = [];
  let first: Error | null = null;
  for (const run of runs) {
    let listed: number[] = [];
    try {
      listed = pgrepGroup(run.pid);
      const termed: string[] = [];
      const skipped: string[] = [];
      const gone: number[] = [];
      for (const q of listed) {
        const command = psCommand(q);
        let how = "";
        let cwd = "";
        if (command === "") {
          gone.push(q);
          continue;
        }
        if (q === run.pid) {
          if (command.includes(`${copy}/`)) how = "command";
        } else if (command.includes(`${copy}/`) || command.includes(`${run.d}/`)) how = "command";
        else if (psPgid(q) === run.pid) {
          cwd = lsofCwd(q);
          if (cwd.startsWith(`${run.d}/`)) how = `pgid+cwd ${cwd}`;
        }
        if (!how) {
          // R3: what the pid was, so the skip can be checked.
          skipped.push(`${q} ${JSON.stringify(command)} cwd ${JSON.stringify(cwd || lsofCwd(q))}`);
          continue;
        }
        try {
          process.kill(q, "SIGTERM");
          termed.push(`${q} (${how})`);
        } catch {
          // gone since pgrep listed it
        }
      }
      for (let i = 0; i < 50 && pgrepGroup(run.pid).length > 0; i++) await sleep(100);
      const after = pgrepGroup(run.pid);
      console.log(`C-L4 ${id}: run ${run.pid} d ${run.d} command ${JSON.stringify(run.command)}; group listed [${listed.join(" ")}] TERM [${termed.join(" ")}]${gone.length ? ` gone [${gone.join(" ")}]` : ""}${skipped.length ? ` skipped: command changed [${skipped.join("; ")}]` : ""}; after [${after.join(" ")}]`);
      for (const q of after) {
        hold(root, q);
        left.push(`${run.pid}:${q}`);
      }
    } catch (e) {
      // R4: a probe failed. Hold the run's leader and every pid listed so far (the root stays), then go on.
      const pids = [run.pid, ...listed.filter((q) => q !== run.pid)];
      for (const q of pids) {
        hold(root, q);
        left.push(`${run.pid}:${q}`);
      }
      console.log(`C-L4 ${id}: run ${run.pid} d ${run.d}: reap failed (${e instanceof Error ? e.message : String(e)}); held [${pids.join(" ")}]`);
      first ??= e instanceof Error ? e : new Error(String(e));
    }
  }
  if (first) throw original === undefined ? first : new Error(first.message, { cause: original });
  return { id, left };
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
    if (proc.exitCode === null && proc.signalCode === null) hold(root, proc.pid);
  }
}

const FINISH_SLEEP: Patch = ['    } >> out/summary.txt\n    echo "$RESULT" > out/rc.txt\n', '    } >> out/summary.txt\n    sleep 3\n    echo "$RESULT" > out/rc.txt\n'];

// ── the ML mutants (plan §4: ML1-ML29, 31 mutants) ───────────────────────────

type Assertion = "restore-holds" | "restore-fails" | "cas-holds" | "cas-fails" | "finish-fails";

interface Mutant {
  id: string;
  what: string;
  patches: Patch[];
  /** The file the patches edit; ledger.sh when absent (the ML rows). */
  file?: string;
  /** MR36 only: run only where /opt/homebrew/bin exists, else print "MR36 N/A …" (C5-8). */
  gate?: "homebrew";
  mustFail: string[];
  mustPass: string[];
  /** A mustFail title's failure text (stderr) must match this (corp-mode.control's mustFailWith). */
  mustFailWith?: Record<string, RegExp>;
  /** A control-side assertion: on the copy's ledger.sh (with the verb it runs), or MR27's finish-TERM. */
  assertion?: { kind: Assertion; verb?: "log" | "now" };
  /**
   * N-S12-6: an equivalent mutant (the script behaves the same with it). Its mustFail titles must
   * still PASS; it is reported as STILL GREEN (equivalent, by <file:line>) and counted apart.
   */
  equivalent?: true;
  /** Why the row is equivalent; its first word is the file:line that makes it so. */
  reason?: string;
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

// ── the MR mutants on rerun.sh (MR1-MR51), MH on agents/hub-reader.md (MH1-MH3) ──────────
// Literal finds, written at implementation from the rows' text (plan §4, code L860-L934).

const MR_MH: Mutant[] = [
  { id: "MR1", what: "sha1 compare always equal", patches: [["[ \"$got\" = \"$SHA\" ] ||", "true ||"]], mustFail: ["RR-sha"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR2", what: "R2 HEAD check removed", patches: [["  [ \"$head\" = \"$BASE\" ] || refuse_run 2 \"R2: HEAD $(esc \"${head:-(none)}\") is not $BASE\"\n", ""]], mustFail: ["RR-head"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR3", what: "remote removal loop removed", patches: [["  while IFS= read -r r; do\n    tw \"$D/tmp/remove\" remote remove \"$r\" || refuse_run 5 \"APPLY FAILED: remote remove $(esc \"$r\")\"\n  done < \"$D/tmp/remotes\"\n", ""]], mustFail: ["RR-remotes", "RR-ok"], mustPass: ["RR-env"], file: RERUN }, // N-S12-4: plan mustPass RR-ok
  { id: "MR4", what: "env -i removed (the bun test suite line)", patches: [["(cd \"$D/w\" && env -i ", "(cd \"$D/w\" && env "]], mustFail: ["RR-env"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR5", what: "on the env line, PATH=\"$P\" -> PATH=\"${P#*:}\"", patches: [["(cd \"$D/w\" && env -i HOME=\"$D/home\" USER=\"$USER\" LOGNAME=\"${LOGNAME:-$USER}\" LANG=\"${LANG:-en_US.UTF-8}\" TERM=dumb TMPDIR=\"$D/tmp\" TMUX_TMPDIR=\"$D/tmux\" OMT_HOME=\"$D/NO_HUB\" PATH=\"$P\"", "(cd \"$D/w\" && env -i HOME=\"$D/home\" USER=\"$USER\" LOGNAME=\"${LOGNAME:-$USER}\" LANG=\"${LANG:-en_US.UTF-8}\" TERM=dumb TMPDIR=\"$D/tmp\" TMUX_TMPDIR=\"$D/tmux\" OMT_HOME=\"$D/NO_HUB\" PATH=\"${P#*:}\""]], mustFail: ["RR-shims"], mustPass: ["RR-ok", "RR-shim-eq"], file: RERUN },
  { id: "MR6", what: "allowlist accepts any line", patches: [["    refuse_run 2 \"R5: bad line $n\"\n", "    SUITE_LINES+=(\"$line\")\n"]], mustFail: ["RR-suites"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR7", what: ".. refusal removed", patches: [[" && [[ \"$line\" != *..* ]]", ""]], mustFail: ["RR-suites"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR8", what: "part 1's merge line -> tail -n 20 of log.txt, parts 2 and 3 kept", patches: [["    [ ! -e \"$D/out/log.txt\" ] || { { grep -anE \"$X\" \"$D/out/log.txt\"; r=$?; [ \"$r\" -lt 2 ] || echo \"0:copy: FAILED grep rc=$r\"; blk \"$D/out/log.txt\" | grep -aE '^0:copy: |^[0-9]+: *[0-9]+ (pass|fail|skip|todo|errors?)$'; } | LC_ALL=C sort -t: -k1,1n -s | LC_ALL=C cut -d: -f2- >> \"$D/out/summary.txt\"; p=(\"${PIPESTATUS[@]}\"); [ \"${p[1]}\" = 0 ] || echo \"copy: FAILED sort rc=${p[1]}\" >> \"$D/out/summary.txt\"; [ \"${p[2]}\" = 0 ] || echo \"copy: FAILED cut rc=${p[2]}\" >> \"$D/out/summary.txt\"; }\n", "    [ ! -e \"$D/out/log.txt\" ] || tail -n 20 \"$D/out/log.txt\" >> \"$D/out/summary.txt\"\n"]], mustFail: ["RR-ok", "RR-sha"], mustPass: ["RR-env"], file: RERUN }, // N-S12-4: plan mustPass RR-sha
  { id: "MR9", what: "done written before rc", patches: [["    echo \"$RESULT\" > out/rc.txt\n    date -u > out/done\n", "    date -u > out/done\n    echo \"$RESULT\" > out/rc.txt\n"]], mustFail: ["RR-ok"], mustPass: ["RR-sha"], file: RERUN },
  { id: "MR10", what: "apply failure not fatal", patches: [["apply --index ../staged.patch || refuse_run 5 'APPLY FAILED'", "apply --index ../staged.patch || true"]], mustFail: ["RR-apply"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR11", what: "forbidden-paths grep removed", patches: [["      [[ \"$p\" =~ ^(\\.claude/|CLAUDE\\.local\\.md|\\.mcp\\.json|\\.sisyphus/) ]] && lst \"$p\"\n", "      :\n"]], mustFail: ["RR-forbidden"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR12", what: "one byte changed in the copied span (exit 99 -> exit 98 in the omt/claude/gh shims)", patches: [["\\nexit 99\\n' \"$c\"", "\\nexit 98\\n' \"$c\""]], mustFail: ["RR-shim-eq"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR13", what: "zero-suite refusal removed", patches: [["  [ \"${#SUITE_LINES[@]}\" -ge 1 ] || refuse_run 2 'R5: no suite'\n", ""]], mustFail: ["RR-absent"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR14", what: "/private/tmp check removed", patches: [["case \"$D\" in /private/tmp/?*) ;; *) echo \"rerun.sh: $D is not under /tmp\" >&2; exit 2 ;; esac\n", ""]], mustFail: ["RR-d"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR15", what: "setsid/nohup detach removed (plain &)", patches: [["nohup /usr/bin/perl -MPOSIX -e 'POSIX::setsid()>=0 or die \"setsid\\n\"; exec @ARGV' \\\n  /bin/bash", "/bin/bash"]], mustFail: ["RR-detach"], mustPass: ["RR-sha"], file: RERUN },
  { id: "MR16", what: "TERM trap removed", patches: [["  trap 'RESULT=killed; PART2=\"\"; exit' TERM INT HUP\n", ""]], mustFail: ["RR-killed"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR17", what: "EXIT trap's done removed", patches: [["    date -u > out/done\n", ""]], mustFail: ["RR-ok", "RR-sha"], mustPass: ["RR-mode"], file: RERUN },
  { id: "MR18", what: "group reaping removed from finish", patches: [["    local p pids live i\n    pids=$(pgrep -g $$ | grep -vx -- \"$$\")\n    for p in $pids; do kill -TERM \"$p\" 2>/dev/null; done\n    for ((i = 0; i < 100; i++)); do\n      live=''\n      for p in $pids; do kill -0 \"$p\" 2>/dev/null && live+=\"$p \"; done\n      [ -z \"$live\" ] && break\n      sleep 0.1\n    done\n    for p in $pids; do kill -0 \"$p\" 2>/dev/null && kill -KILL \"$p\" 2>/dev/null; done\n", ""]], mustFail: ["RR-killed", "RR-detach"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR19", what: "empty-patch skip removed", patches: [["  if [ ! -s \"$D/staged.patch\" ]; then\n    echo 'staged: (empty)' >> \"$D/out/log.txt\"\n  else\n    tw \"$D/tmp/apply\" apply --index ../staged.patch || refuse_run 5 'APPLY FAILED'\n  fi\n", "  tw \"$D/tmp/apply\" apply --index ../staged.patch || refuse_run 5 'APPLY FAILED'\n"]], mustFail: ["RR-empty"], mustPass: ["RR-one-line"], file: RERUN },
  { id: "MR20", what: "R6 removed", patches: [["  [ -z \"$bad\" ] || refuse_run 6 \"${bad%$'\\n'}\"\n", ""]], mustFail: ["RR-unstaged", "RR-untracked"], mustPass: ["RR-neverstaged"], file: RERUN },
  { id: "MR21", what: "never-staged exclusion removed (untracked and tracked)", patches: [["    if never_staged \"$p\"; then\n", "    if false; then\n"], ["    never_staged \"$p\" || bad+=", "    false || bad+="]], mustFail: ["RR-neverstaged", "RR-unstaged"], mustPass: ["RR-env"], file: RERUN }, // N-S12-4: plan mustPass RR-unstaged
  { id: "MR22", what: "2>&1 removed from the suite line", patches: [["\"${cmd[@]}\" >>\"$D/out/log.txt\" 2>&1 </dev/null)", "\"${cmd[@]}\" >>\"$D/out/log.txt\" </dev/null)"]], mustFail: ["RR-ok"], mustPass: ["RR-sha"], file: RERUN },
  { id: "MR23", what: "mkdir ... tmp removed (the suites' TMPDIR)", patches: [["mkdir \"$S\" tmux home tmp tcache", "mkdir \"$S\" tmux home tcache"]], mustFail: ["RR-env", "RR-sha"], mustPass: ["RR-remotes"], file: RERUN }, // N-S12-4: plan mustPass RR-sha
  { id: "MR24", what: "clean of out/ removed (and out made with -p)", patches: [["rm -rf out w staged.patch", "rm -rf w staged.patch"], ["mkdir out || exit 2", "mkdir -p out || exit 2"]], mustFail: ["RR-head"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR25", what: "the suite line back to the foreground form", patches: [["\"${cmd[@]}\" >>\"$D/out/log.txt\" 2>&1 </dev/null) & cpid=$!\n        wait \"$cpid\"; printf", "\"${cmd[@]}\" >>\"$D/out/log.txt\" 2>&1 </dev/null)\n        printf"]], mustFail: ["RR-killed"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR26", what: "the live-run guard removed", patches: [["if [ -f \"$D/out/pid\" ]; then\n  old=$(head -n 1 \"$D/out/pid\" | head -c 32 | tr -d '\\n')\n  if [[ \"$old\" =~ ^[1-9][0-9]*$ ]] && kill -0 \"$old\" 2>/dev/null; then\n    echo \"rerun.sh: run alive: $old\"\n    exit 2\n  fi\nfi\n", ""]], mustFail: ["RR-busy"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR27", what: "trap '' TERM INT HUP removed from finish", patches: [["    trap '' TERM INT HUP\n", ""]], mustFail: [], mustPass: ["RR-ok"], file: RERUN, assertion: { kind: "finish-fails" } },
  { id: "MR28", what: "the harness-new sets always (none)", patches: [["    [ -n \"$x\" ] && printf '%s' \"$x\" || printf '(none)'", "    printf '(none)'"]], mustFail: ["RR-sandboxes"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR29", what: "the self resolution dropped (the detach execs \"$0\")", patches: [["/bin/bash \"$self\" --run", "/bin/bash \"$0\" --run"]], mustFail: ["RR-relpath"], mustPass: ["RR-sha"], file: RERUN },
  { id: "MR30", what: "the guard's kill -0 dropped (any numeric out/pid refuses)", patches: [[" && kill -0 \"$old\" 2>/dev/null; then", "; then"]], mustFail: ["RR-busy"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR31", what: "R1's CLAUDE.md walk removed", patches: [["p=$D\nwhile :; do\n  for f in CLAUDE.md CLAUDE.local.md .claude/CLAUDE.md; do\n    [ -e \"$p/$f\" ] && { echo \"rerun.sh: refusing to launch, $p/$f exists\" >&2; exit 3; }\n  done\n  [ -z \"$p\" ] && break\n  p=${p%/*}\ndone\n", ""]], mustFail: ["RR-d-above"], mustPass: ["RR-d"], file: RERUN },
  { id: "MR32", what: "the footer grep removed", patches: [["    awk '/^diff / { h = 0 } /^@@ / { h = 1; next } h && /^\\+/' \"$D/staged.patch\" | grep -aiE -- \"$footer\" \\\n      | while IFS= read -r l; do lst \"$l\"; done\n", ""]], mustFail: ["RR-footer"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR33", what: "R0's sha form check removed", patches: [["if [ \"$#\" -ne 5 ] || ! [[ \"$3\" =~ ^[0-9a-f]{40}$ ]] || ! [[ \"$4\" =~ ^[0-9a-f]{40}$ ]]; then", "if [ \"$#\" -ne 5 ]; then"]], mustFail: ["RR-sha"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR34", what: "part 1's merge grep -anE -> grep -nE", patches: [["grep -anE \"$X\"", "grep -nE \"$X\""]], mustFail: ["RR-binary-log"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR35", what: "|^unhandled=[0-9]+$ dropped from part 1's pattern", patches: [["|^unhandled=[0-9]+$", ""]], mustFail: ["RR-unhandled", "RR-ok"], mustPass: ["RR-env"], file: RERUN }, // N-S12-4: plan mustPass RR-ok
  { id: "MR36", what: "the path-order step's P= line removed, its echo kept", patches: [["  if [ -d /opt/homebrew/bin ]; then P=\"$D/$S:/opt/homebrew/bin:${P#\"$D/$S:\"}\"; fi\n", ""]], mustFail: ["RR-env"], mustPass: ["RR-ok"], file: RERUN, gate: "homebrew" },
  { id: "MR37", what: "the warm-up block removed", patches: [["        echo \"channel warm-up: start\" >> \"$D/out/log.txt\"; t0=$(date +%s)\n        (cd \"$D/w/channel\" && env -i HOME=\"$D/home\" USER=\"$USER\" LOGNAME=\"${LOGNAME:-$USER}\" LANG=\"${LANG:-en_US.UTF-8}\" TERM=dumb TMPDIR=\"$D/tmp\" TMUX_TMPDIR=\"$D/tmux\" OMT_HOME=\"$D/NO_HUB\" PATH=\"$P\" CLAUDE_BIN=\"$CB\" BUN_INSTALL_CACHE_DIR=\"$D/bun-cache\" BUN_RUNTIME_TRANSPILER_CACHE_PATH=\"$D/tcache\" bun test >\"$D/out/warmup.txt\" 2>&1 </dev/null) & cpid=$!\n        wait \"$cpid\"; wrc=$?; echo \"channel warm-up: rc=$wrc s=$(( $(date +%s) - t0 )) errors=$(blk \"$D/out/warmup.txt\" | sed -nE 's/^[0-9]+: *([0-9]+) errors?$/\\1/p' | awk '{s += $1} END {print s + 0}') ran=$(grep -aE '^Ran [0-9]+ tests? across' \"$D/out/warmup.txt\" | awk '{n = $2} END {print n + 0}')\" >> \"$D/out/log.txt\"\n", ""]], mustFail: ["RR-warmup", "RR-ok"], mustPass: ["RR-env"], file: RERUN }, // N-S12-4: plan mustPass RR-ok
  { id: "MR38", what: "BUN_RUNTIME_TRANSPILER_CACHE_PATH dropped from the --isolate step", patches: [[" BUN_RUNTIME_TRANSPILER_CACHE_PATH=\"$D/tcache\" bun test --isolate", " bun test --isolate"]], mustFail: ["RR-warmup"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR39", what: "the warm-up in the foreground", patches: [[">\"$D/out/warmup.txt\" 2>&1 </dev/null) & cpid=$!\n        wait \"$cpid\"; wrc=$?", ">\"$D/out/warmup.txt\" 2>&1 </dev/null)\n        wrc=$?"]], mustFail: ["RR-killed"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR40", what: "the self line back to v4's form", patches: [["self=$(CDPATH='' cd -- \"$(dirname -- \"$0\")\" && pwd -P)/$(basename -- \"$0\")", "self=$(cd \"$(dirname \"$0\")\" && pwd -P)/$(basename \"$0\")"]], mustFail: ["RR-relpath"], mustPass: ["RR-sha"], file: RERUN },
  { id: "MR41", what: "the unhandled= awk -> a plain grep -c of the suite's lines", patches: [["    awk -v h=\"== $line\" '$0 == h {on = 1; n = 0; next} on && p && /^-{31}$/ {n++} {p = ($0 == \"# Unhandled error between tests\")} END {print \"unhandled=\" n+0}' \"$D/out/log.txt\" >> \"$D/out/log.txt\"\n", "    echo \"unhandled=$(awk -v h=\"== $line\" '$0 == h {on = 1; next} on' \"$D/out/log.txt\" | grep -c '^# Unhandled error between tests$')\" >> \"$D/out/log.txt\"\n"]], mustFail: ["RR-unhandled"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR42", what: "one /usr/bin/git -C w outside the span -> git -C w (tw)", patches: [["/usr/bin/git -C w \"$@\"", "git -C w \"$@\""]], mustFail: ["RR-git-abs"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR43", what: "the warm-up's >\"$D/out/warmup.txt\" -> >>\"$D/out/log.txt\"", patches: [["bun test >\"$D/out/warmup.txt\" 2>&1", "bun test >>\"$D/out/log.txt\" 2>&1"]], mustFail: ["RR-ok", "RR-warmup"], mustPass: ["RR-sha"], file: RERUN },
  { id: "MR44", what: "|errors? dropped from blk's pattern", patches: [["todo|errors?|expect", "todo|expect"]], mustFail: ["RR-unhandled"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR45", what: "the awk's /^-{31}$/ -> /^-+$/", patches: [["/^-{31}$/", "/^-+$/"]], mustFail: ["RR-unhandled"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR46", what: "blk's empty-line rule dropped: s = (n == e + 1) -> s = 1", patches: [["s = (n == e + 1)", "s = 1"]], mustFail: ["RR-unhandled"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR47", what: "the warm-up's errors=$(...) -> errors=0", patches: [["errors=$(blk \"$D/out/warmup.txt\" | sed -nE 's/^[0-9]+: *([0-9]+) errors?$/\\1/p' | awk '{s += $1} END {print s + 0}')", "errors=0"]], mustFail: ["RR-warmup"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR48", what: "blk's snapshot alternatives removed", patches: [["|^snapshots: |^ *[0-9]+ snapshots, [0-9]+ expect\\(\\) calls$", ""]], mustFail: ["RR-unhandled"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR49", what: "blk's grep -anE -> grep -nE", patches: [["blk() { grep -anE", "blk() { grep -nE"]], mustFail: ["RR-binary-log"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MR50", what: "the merge's LC_ALL=C sort -> sort", patches: [["| LC_ALL=C sort -t:", "| sort -t:"]], mustFail: ["RR-binary-log"], mustPass: ["RR-ok"], file: RERUN, equivalent: true, reason: "rerun.sh:12 exports LC_ALL=C for the whole script" }, // N-S12-6
  { id: "MR51", what: "both copy: FAILED grep echoes removed (the merge's and blk's)", patches: [["r=$?; [ \"$r\" -lt 2 ] || echo \"0:copy: FAILED grep rc=$r\"; blk", "r=$?; blk"], ["r=${PIPESTATUS[0]}; [ \"$r\" -lt 2 ] || echo \"0:copy: FAILED grep rc=$r\"; }", "r=${PIPESTATUS[0]}; }"]], mustFail: ["RR-binary-log"], mustPass: ["RR-ok"], file: RERUN },
  { id: "MH1", what: "tools widened with Bash", patches: [["tools: [Read, Grep, Glob]\n", "tools: [Read, Grep, Glob, Bash]\n"]], mustFail: ["HR-front", "HR-probe"], mustPass: ["SK-front"], file: HUB_READER },
  { id: "MH2", what: "tools line removed", patches: [["tools: [Read, Grep, Glob]\n", ""]], mustFail: ["HR-front", "HR-probe"], mustPass: ["SK-front"], file: HUB_READER },
  { id: "MH3", what: "a second tools line with WebFetch", patches: [["tools: [Read, Grep, Glob]\n", "tools: [Read, Grep, Glob]\ntools: [Read, Grep, Glob, WebFetch]\n"]], mustFail: ["HR-front"], mustPass: ["SK-front"], file: HUB_READER },
];

// ── the MS mutants on SKILL.md (MS1-MS21) ─────────────────────────────────────
// N-S12-3: a row that removes a whole line takes it from SKILL.md by a short anchor written here (the
// line starting with the trimmed anchor; MS2: the line holding it), asserted to be exactly one line;
// the find is that line and its newline. The lines are the kit's own pinned literals; the anchor
// assert catches drift. MS15, MS19 and MS21 are literal.

/** What each derived find removed, for the log: its length and first 60 characters. */
const DERIVED: Record<string, string> = {};
/** Anchors that did not resolve to exactly one line (F7): the every-title test reports them HARNESS BROKEN. */
const MISSES: { id: string; n: number }[] = [];

function dropLine(id: string, rule: "starts" | "holds", anchor: string): Patch {
  const a = anchor.trim();
  const hits = readFileSync(path.join(REPO, SKILL), "utf8").split("\n").filter((x) => (rule === "holds" ? x.includes(a) : x.trim().startsWith(a)));
  if (hits.length !== 1) {
    DERIVED[id] = `HARNESS BROKEN: anchor ${JSON.stringify(a)} resolves to ${hits.length} lines`;
    MISSES.push({ id, n: hits.length });
    // The find matches nothing: G1 counts it bad, and the every-title test fails HARNESS BROKEN.
    return [`\u0000${DERIVED[id]}`, ""];
  }
  DERIVED[id] = `${hits[0].length} chars: ${JSON.stringify(hits[0].slice(0, 60))}`;
  return [`${hits[0]}\n`, ""];
}

const msDrop = (id: string, rule: "starts" | "holds", anchor: string, what: string, mustFail: string[], mustPass: string[]): Mutant =>
  ({ id, what, patches: [dropLine(id, rule, anchor)], mustFail, mustPass, file: SKILL });

const MS: Mutant[] = [
  msDrop("MS1", "starts", "6. `END 3h`: escalate the stuck gate", "SKILL §2 step 6 line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS2", "holds", "never quote a refusal as the run", "SKILL §2 step 7's refusal line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS3", "starts", "8. A red outside the expected set:", "SKILL §2 step 8 line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS4", "starts", "Every message, ruling and tap;", "SKILL §4's first line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS5", "starts", "The expected set is the `(fail)` lines the team's DONE report quotes whole", "SKILL §2 step 7's expected-set line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS6", "starts", "with `grep -anE`; a summary line", "SKILL §2 step 7's grep -aE/Binary file line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS7", "starts", "A ` N error` or ` N errors` line (N ≥ 1) under a suite", "SKILL §2 step 7's no-verdict ( N error) line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS8", "starts", "`harness-new: dirs <names>; servers <pids>`", "SKILL §2 step 7's harness-new: line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS9", "starts", "`END dead` with a non-empty `group:`", "SKILL §2 step 7's END dead … group: line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS10", "starts", "For those 4, the team's DONE report must quote", "SKILL §2 step 7's real-HOME line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS11", "starts", "If it is the channel suite, the first match wins:", "SKILL §2 step 7's channel environment line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS12", "starts", "The `channel warm-up:` and `tcache-entries:` lines", "SKILL §2 step 7's not-counted line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS13", "starts", "Write the current mark into the Rerun line", "SKILL §2 step 5's re-arm-from-the-Rerun-line line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS14", "starts", "`END stuck-after-term`:", "SKILL §2 step 6's END stuck-after-term line removed", ["SK-steps"], ["SK-lines"]),
  {
    id: "MS15", what: "SKILL §2 step 4's Rerun: <D> pid <N> mark 10800. line removed", file: SKILL,
    patches: [["       Rerun: <D> pid <N> mark 10800.\n", ""]],
    mustFail: ["SK-lines"], mustPass: ["SK-steps"],
  },
  msDrop("MS16", "starts", "On every `END` line, before you act on it", "SKILL §2 step 5's replace-on-every-END line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS17", "starts", "After \"abandon the run\":", "SKILL §2 step 6's after-abandon line removed", ["SK-steps"], ["SK-lines"]),
  msDrop("MS18", "starts", "A `bun test` suite whose lines hold", "SKILL §2 step 7's crash and no-count line removed", ["SK-steps"], ["SK-lines"]),
  {
    id: "MS19", what: "in SKILL §2 step 5's Monitor line, both ! a -> ! kill -0 of out/pid", file: SKILL,
    patches: [
      ['|| ! a || [ $(( $(date +%s) - $(stat -f %m "$D/out/pid") )) -ge 10800 ]', '|| ! kill -0 "$(cat "$D/out/pid")" 2>/dev/null || [ $(( $(date +%s) - $(stat -f %m "$D/out/pid") )) -ge 10800 ]'],
      [
        `elif ! a; then echo "END dead: pid gone or not this run, no done, no run; group: $(ps -p "$(cat "$D/out/pid")" >/dev/null || pgrep -g "$(cat "$D/out/pid")" | tr '\\n' ' ')"; else echo "END 3h`,
        `elif ! kill -0 "$(cat "$D/out/pid")" 2>/dev/null; then echo "END dead: pid gone or not this run, no done, no run; group: $(ps -p "$(cat "$D/out/pid")" >/dev/null || pgrep -g "$(cat "$D/out/pid")" | tr '\\n' ' ')"; else echo "END 3h`,
      ],
    ],
    mustFail: ["SK-pid-reuse", "SK-lines"], mustPass: ["SK-steps"],
  },
  msDrop("MS20", "starts", "A `channel tsc` suite prints no", "SKILL §2 step 7's tsc line removed", ["SK-steps"], ["SK-lines"]),
  {
    id: "MS21", what: "SKILL §2 step 3's D= line without pwd -P", file: SKILL,
    patches: [['       D=$(cd "$(mktemp -d /tmp/hub-rerun-<lwo-nnn>-XXXX)" && pwd -P); echo "$D"\n', '       D=$(mktemp -d /tmp/hub-rerun-<lwo-nnn>-XXXX); echo "$D"\n']],
    mustFail: ["SK-pid-reuse", "SK-lines"], mustPass: ["SK-steps"],
  },
];

/** All 106 mutants: ML 31, MR 51, MH 3, MS 21. */
const ALL: Mutant[] = [...MUTANTS, ...MR_MH, ...MS];

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

/** The kit titles no mutant fails, by design (plan §4, C3-9): 19. */
const BY_DESIGN: readonly string[] = [
  "LD-path-ok", "LD-now-mb-1000", "LD-log-nonl", "RR-one-line",
  "LD-mode", "RR-mode", "SK-front", "SK-briefs", "SK-nolwo", "LD-grep",
  "LD-now-16-nonl", "LD-now-empty-state", "LD-now-nodot-state", "LD-now-missing",
  "LD-shape", "RR-nm-source", "RR-crash", "RR-tsc",
  "LD-serial",
];

const FINISH_HOLDS = { inSleep: true, termSent: true, exited: true, rcTxt: "2\n", done: true, summaryRc: "rerun-rc: 2" };
const FINISH_MR27 = { inSleep: true, termSent: true, exited: true, rcTxt: null, done: false, summaryRc: "rerun-rc: 2" };

describe("hub-delegate removal control", () => {
  let baseline: KitResult | null = null;
  // N-S12-6: STILL GREEN lines, unexpected ones and equivalent rows counted apart.
  let greenUnexpected = 0;
  let greenEquivalent = 0;
  afterAll(() => console.log(`STILL GREEN ${greenUnexpected} (unexpected), ${greenEquivalent} equivalent`));

  test("baseline: the unpatched kit passes exactly the kit's 81 titles, no skips, no repeated title (else HARNESS BROKEN)", async () => {
    expect({ listed: EXPECTED_TITLES.length, unique: new Set(EXPECTED_TITLES).size }).toEqual({ listed: KIT_TITLES, unique: KIT_TITLES });
    const t0 = performance.now();
    baseline = await withCopy([], (_root, copy) => runKit(copy));
    console.log(`baseline whole-kit run: ${((performance.now() - t0) / 1000).toFixed(1)} s (copy included)`);
    if (baseline.exitCode !== 0) console.log(`--- baseline output\n${baseline.output.slice(-6000)}`);
    expect({ exit: baseline.exitCode, failed: baseline.failed, skipped: baseline.skipped }).toEqual({ exit: 0, failed: [], skipped: [] });
    const all = [...baseline.passed, ...baseline.failed, ...baseline.skipped];
    expect({ repeated: all.filter((t, i) => all.indexOf(t) !== i) }).toEqual({ repeated: [] });
    expect({ passed: [...baseline.passed].sort(), ran: baseline.ran }).toEqual({ passed: [...EXPECTED_TITLES].sort(), ran: KIT_TITLES });
  });

  test("every title named by a mutant exists in the kit, mutant ids are unique, and the 19 by-design titles are the ones no mutant fails (else HARNESS BROKEN)", () => {
    expect(baseline).not.toBeNull();
    const ids = new Set<string>();
    for (const m of ALL) {
      expect({ id: m.id, unique: !ids.has(m.id) }).toEqual({ id: m.id, unique: true });
      ids.add(m.id);
      for (const t of [...m.mustFail, ...m.mustPass]) expect({ mutant: m.id, title: t, known: baseline!.passed.includes(t) }).toEqual({ mutant: m.id, title: t, known: true });
      for (const t of Object.keys(m.mustFailWith ?? {})) expect({ mutant: m.id, title: t, inMustFail: m.mustFail.includes(t) }).toEqual({ mutant: m.id, title: t, inMustFail: true });
      expect({ mutant: m.id, catches: m.mustFail.length > 0 || m.assertion?.kind.endsWith("-fails") === true }).toEqual({ mutant: m.id, catches: true });
      if (m.equivalent) expect({ mutant: m.id, reason: /^\S+:[0-9]+ /.test(m.reason ?? "") }).toEqual({ mutant: m.id, reason: true });
    }
    // F7: every N-S12-3 anchor resolves to exactly one SKILL.md line.
    expect({ misses: MISSES.map((x) => `HARNESS BROKEN: anchor ${x.id} resolves to ${x.n} lines`) }).toEqual({ misses: [] });
    const count = (p: string) => ALL.filter((m) => new RegExp(`^${p}[0-9]`).test(m.id)).length;
    expect({ ML: count("ML"), MR: count("MR"), MH: count("MH"), MS: count("MS"), all: ALL.length }).toEqual({ ML: 31, MR: 51, MH: 3, MS: 21, all: 106 });
    const failed = new Set(ALL.filter((m) => !m.equivalent).flatMap((m) => m.mustFail));
    expect(EXPECTED_TITLES.filter((t) => !failed.has(t)).sort()).toEqual([...BY_DESIGN].sort());
  });

  test(`G1: every find of the 106 mutants matches exactly once, in order (mutants 106 patches ${PATCHES} bad 0)`, () => {
    let patches = 0;
    let bad = 0;
    for (const m of ALL) {
      let src = readFileSync(path.join(REPO, m.file ?? LEDGER), "utf8");
      for (const [find, replace] of m.patches) {
        patches++;
        if (countOccurrences(src, find) !== 1) {
          bad++;
          console.log(`G1 bad: ${m.id} ${JSON.stringify(find.slice(0, 80))}`);
          continue;
        }
        src = src.replace(find, () => replace);
      }
    }
    for (const [id, d] of Object.entries(DERIVED)) console.log(`derived ${id}: ${d}`);
    console.log(`mutants ${ALL.length} patches ${patches} bad ${bad}`);
    expect({ mutants: ALL.length, patches, bad }).toEqual({ mutants: 106, patches: PATCHES, bad: 0 });
  });

  for (const m of ALL) {
    test(`mutant caught: ${m.id} ${m.what}`, async () => {
      if (m.gate === "homebrew" && !existsSync("/opt/homebrew/bin")) {
        console.log(`${m.id} N/A (no /opt/homebrew/bin)`);
        return;
      }
      const file = m.file ?? LEDGER;
      await withCopy([{ file, patches: m.patches }], async (root, copy) => {
        const named = [...m.mustFail, ...m.mustPass];
        let r: KitResult;
        let reaped: { id: string; left: string[] } | null = null;
        if (file === RERUN) {
          // F1: the runs are reaped on every exit path, before withCopy removes the root.
          const runs: RunRecord[] = [];
          let original: unknown;
          try {
            r = await runKitWatched(root, copy, named, runs);
            if (runs.length === 0) console.log(`C-L4 ${m.id}: no run recorded`);
          } catch (e) {
            original = e;
            throw e;
          } finally {
            reaped = await reapGroups(m.id, root, copy, runs, original);
          }
        } else r = runKit(copy, named);
        const stillGreen = m.mustFail.length > 0 && m.mustFail.every((t) => r.passed.includes(t));
        const unexpected = [...(m.equivalent ? m.mustFail.filter((t) => !r.passed.includes(t)) : m.mustFail.filter((t) => !r.failed.includes(t))), ...m.mustPass.filter((t) => !r.passed.includes(t))];
        if (stillGreen && m.equivalent) {
          greenEquivalent++;
          console.log(`STILL GREEN (equivalent, by ${(m.reason ?? "").split(" ")[0]}): ${m.id}`);
        } else if (stillGreen) {
          greenUnexpected++;
          console.log(`STILL GREEN: ${m.id}`);
        }
        if (unexpected.length) console.log(`--- ${m.id}: unexpected result for: ${unexpected.join(" | ")}\n${r.output.slice(-6000)}`);
        // Presence: the -t pattern ran exactly the named titles (JUnit lists the filtered-out ones as skipped).
        expect({ mutant: m.id, ran: r.ran, junit: r.passed.length + r.failed.length }).toEqual({ mutant: m.id, ran: named.length, junit: named.length });
        // An equivalent row's mustFail titles must pass (N-S12-6); every other row's must fail.
        for (const t of m.mustFail) expect({ mutant: m.id, title: t, failed: r.failed.includes(t) }).toEqual({ mutant: m.id, title: t, failed: !m.equivalent });
        for (const t of m.mustPass) expect({ mutant: m.id, title: t, passed: r.passed.includes(t) }).toEqual({ mutant: m.id, title: t, passed: true });
        for (const [t, re] of Object.entries(m.mustFailWith ?? {})) {
          const shown = re.test(failureText(r.stderr, t) ?? "");
          expect({ mutant: m.id, title: t, text: String(re), shown }).toEqual({ mutant: m.id, title: t, text: String(re), shown: true });
        }
        if (m.assertion?.kind === "finish-fails") {
          // MR27: the same mutant with finish's 3 s sleep, TERMed in the sleep: no rc.txt, no done.
          const f = await withCopy([{ file: RERUN, patches: [...m.patches, FINISH_SLEEP] }], (r2, c2) => finishTerm(r2, c2));
          const holds = f.rcTxt === "2\n" && f.done;
          if (holds) {
            greenUnexpected++;
            console.log(`STILL GREEN: ${m.id} (the finish-TERM assertion still holds)`);
          }
          console.log(`${m.id} finish-TERM: ${JSON.stringify(f)}`);
          expect({ mutant: m.id, holds, run: f }).toEqual({ mutant: m.id, holds: false, run: FINISH_MR27 });
        } else if (m.assertion) {
          const p = ledgerProbe(root, copy, m.assertion.verb ?? "log");
          const holds = assertionHolds(m.assertion.kind, p);
          const want = m.assertion.kind.endsWith("-holds");
          if (!want && holds) {
            greenUnexpected++;
            console.log(`STILL GREEN: ${m.id} (the ${m.assertion.kind.split("-")[0]} assertion still holds)`);
          }
          expect({ mutant: m.id, assertion: m.assertion.kind, holds, rc: p.rc, err: p.err }).toEqual({ mutant: m.id, assertion: m.assertion.kind, holds: want, rc: p.rc, err: p.err });
        }
        // C-L4: every group a run from this copy left is empty after its TERMs.
        if (reaped) expect(reaped).toEqual({ id: m.id, left: [] });
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

  test("finish-TERM: a TERM in finish's 3 s sleep after the summary still leaves rc.txt and done; under MR27 it leaves neither", async () => {
    const r = await withCopy([{ file: RERUN, patches: [FINISH_SLEEP] }], (root, copy) => finishTerm(root, copy));
    expect(r).toEqual(FINISH_HOLDS);
    const mr27 = MR_MH.find((m) => m.id === "MR27");
    if (!mr27) throw new Error("HARNESS BROKEN: no MR27 row");
    const r27 = await withCopy([{ file: RERUN, patches: [...mr27.patches, FINISH_SLEEP] }], (root, copy) => finishTerm(root, copy));
    console.log(`MR27 half: ${JSON.stringify(r27)}`);
    expect(r27).toEqual(FINISH_MR27);
  });
});

/**
 * The hub-delegate kit (#69 item A): skills/hub-delegate/ledger.sh and, as later parts land,
 * rerun.sh, the hub-reader agent and SKILL.md. Every title sits in the one
 * describe("hub-delegate kit"), so bun names each "hub-delegate kit <title>" and the removal
 * control's -t form is ^hub-delegate kit (…)$.
 *
 * Env and fixtures (§3.1):
 * - every child runs with HOME=<fixture root>, GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1
 *   and, for ledger.sh, an absolute OMT_VAULT_ROOT=<fixture vault>; the real vault is never named;
 * - fixture roots are mkdtemp under realpath /tmp;
 * - every git call the kit makes itself uses /usr/bin/git;
 * - every fixture process the kit starts is checked by its exact pid in a finally on every exit
 *   path, and the kit asserts it gone. ledger.sh children run through spawnSync, so each has
 *   exited and been reaped when the call returns; a pid still alive there is pid reuse by another
 *   process, so the row fails and the kit sends no signal.
 * The files are read relative to THIS file, so the removal control can run a copy of it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, chmodSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ledgerNow } from "../hooks/ledger-compact.js";

const REPO = path.join(import.meta.dir, "..");
const LEDGER_SH = path.join(REPO, "skills", "hub-delegate", "ledger.sh");
const RERUN_SH = path.join(REPO, "skills", "hub-delegate", "rerun.sh");
const HOOKS = path.join(REPO, "hooks");
const FIX = path.join(import.meta.dir, "fixtures", "hub-delegate");
const VALID = readFileSync(path.join(FIX, "LWO-001-x.md"));
const ROWS13 = readFileSync(path.join(FIX, "LWO-001-rows13.md"));
const TMP = realpathSync("/tmp");
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

type Fx = { root: string; vault: string; tasks: string; tmp: string };

/** A fresh fixture root: <root>/vault/lab/tasks, <root>/tmp (the child's TMPDIR). */
function fx(): Fx {
  const root = mkdtempSync(path.join(TMP, "hub-delegate-kit-"));
  roots.push(root);
  const vault = path.join(root, "vault");
  const tasks = path.join(vault, "lab", "tasks");
  const tmp = path.join(root, "tmp");
  mkdirSync(tasks, { recursive: true });
  mkdirSync(tmp);
  return { root, vault, tasks, tmp };
}

function put(file: string, bytes: Buffer | string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

const sha1 = (file: string) => createHash("sha1").update(readFileSync(file)).digest("hex");

type Run = { rc: number; out: string; err: string; pid: number };

/**
 * Run a child with the kit's env; assert its exact pid is gone afterwards. spawnSync has reaped the
 * child, so a live pid here is pid reuse by another process: the row fails and no signal is sent.
 */
function child(
  argv: string[],
  f: Fx,
  opts: { vault?: string; path?: string; cwd?: string; env?: Record<string, string> } = {},
): Run {
  const env: Record<string, string> = {
    HOME: f.root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    OMT_VAULT_ROOT: opts.vault ?? f.vault,
    PATH: opts.path ?? (process.env.PATH as string),
    TMPDIR: f.tmp,
    ...(opts.env ?? {}),
  };
  let pid = 0;
  try {
    const p = Bun.spawnSync(argv, { env, cwd: opts.cwd ?? f.root, stdout: "pipe", stderr: "pipe" });
    pid = p.pid;
    return { rc: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString(), pid };
  } finally {
    if (pid > 0) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  }
}

const ledger = (f: Fx, args: string[], opts: { vault?: string; path?: string; cwd?: string; sh?: string } = {}) =>
  child(["/bin/bash", opts.sh ?? LEDGER_SH, ...args], f, opts);

/** A refusal: the rc, the exact L<n> in stderr, and the file's sha1 unchanged. */
function refused(r: Run, n: number, file: string | null, before: string | null, reason?: string, rc = 2) {
  expect(r.rc).toBe(rc);
  expect(r.err).toContain(`ledger.sh: L${n}: `);
  if (reason) expect(r.err).toContain(reason);
  if (file) expect(sha1(file)).toBe(before as string);
}

const lines = (n: number, state = true) =>
  Array.from({ length: n }, (_, i) => (i === 0 && state ? "Order: o. Tier: L. State: X." : `- line ${i + 1}`)).join("\n");

/** The bytes between the "## Now" and "## Log" lines of a ledger file. */
function nowBytes(file: string): Buffer {
  const b = readFileSync(file);
  const s = b.toString("latin1");
  const a = s.indexOf("\n## Now\n") + "\n## Now\n".length;
  const e = s.indexOf("## Log\n", a);
  return b.subarray(a, e);
}

function header(b: Buffer): Buffer {
  const s = b.toString("latin1");
  return b.subarray(0, s.indexOf("\n## Now\n") + "\n## Now\n".length);
}

function logPart(b: Buffer): Buffer {
  const s = b.toString("latin1");
  return b.subarray(s.indexOf("\n## Log\n") + 1);
}

const STAMP_RE = /^20[0-9]{2}-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]Z$/;

/**
 * Strip # comments, then find gh|git|curl|omt|tmux|claude as a command word: at a command position,
 * after any VAR=value assignments and env/command/exec/xargs/time/nohup prefixes, path prefix allowed.
 */
function commandWords(file: string): string[] {
  const hits: string[] = [];
  const CMD = /(?:^|[;&|(`!]|(?<!\$)\{|\$\(|\b(?:if|then|do|else|elif|while|until)\b)\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|()'"]*)|env|command|exec|xargs|time|nohup)\s+)*(?:[^\s;&|()'"]*\/)?\b(gh|git|curl|omt|tmux|claude)\b/g;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "$1");
    for (const m of line.matchAll(CMD)) hits.push(m[1]);
  }
  return hits;
}

describe("hub-delegate kit", () => {
  test("LD-log", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const t0 = Date.now();
    const r = ledger(f, [l, "log", "row four"]);
    const t1 = Date.now();
    expect(r.rc).toBe(0);
    const now = readFileSync(l);
    expect(now.subarray(0, VALID.length).equals(VALID)).toBe(true);
    const row = now.subarray(VALID.length).toString();
    const m = row.match(/^- (\S+) row four\n$/);
    expect(m).not.toBeNull();
    const stamp = (m as RegExpMatchArray)[1];
    expect(stamp).toMatch(STAMP_RE);
    const ts = Date.parse(stamp);
    expect(ts).toBeGreaterThanOrEqual(t0 - 5000);
    expect(ts).toBeLessThanOrEqual(t1 + 5000);
    expect(r.out).toContain(`stamp: ${stamp}\n`);
    expect(r.out).toMatch(/^sha1-before: [0-9a-f]{40}$/m);
    expect(r.out).toMatch(/^sha1-after: [0-9a-f]{40}$/m);
    expect(r.out.split("\n").filter((x) => x.startsWith("+- "))).toEqual([`+- ${stamp} row four`]);

    // "## " sections after ## Log (RESCOPE, spec §0a) stay: the row goes at the end of the Log
    // section, before the first of them; show lists it; the sections after are byte-unchanged.
    const tailSec = Buffer.from("## RESCOPE 1 (x)\n- s1\n## Close\n- c1\n");
    const l2 = put(path.join(f.tasks, "LWO-002-y.md"), Buffer.concat([VALID, tailSec]));
    const r2 = ledger(f, [l2, "log", "row five"]);
    expect(r2.rc).toBe(0);
    const b2 = readFileSync(l2);
    expect(b2.subarray(0, VALID.length).equals(VALID)).toBe(true);
    expect(b2.subarray(b2.length - tailSec.length).equals(tailSec)).toBe(true);
    expect(b2.subarray(VALID.length, b2.length - tailSec.length).toString()).toMatch(/^- \S+ row five\n$/);
    const s2 = ledger(f, [l2, "show", "99"]);
    expect(s2.rc).toBe(0);
    const rows2 = s2.out.slice(s2.out.indexOf("== Log (")).split("\n").filter((x) => x.startsWith("- "));
    expect(rows2).toHaveLength(4);
    expect(rows2[3]).toMatch(/ row five$/);
    expect(s2.out).not.toContain("- s1");
  });

  test("LD-log-nonl", () => {
    const f = fx();
    const old = VALID.subarray(0, VALID.length - 1);
    const l = put(path.join(f.tasks, "LWO-001-x.md"), old);
    const r = ledger(f, [l, "log", "row four"]);
    expect(r.rc).toBe(0);
    const now = readFileSync(l);
    expect(now.subarray(0, old.length).equals(old)).toBe(true);
    expect(now.subarray(old.length).toString()).toMatch(/^\n- \S+ row four\n$/);
  });

  test("LD-now-15", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const block = lines(15);
    const nf = put(path.join(f.root, "now.txt"), block + "\n");
    const r = ledger(f, [l, "now", nf]);
    expect(r.rc).toBe(0);
    const b = readFileSync(l);
    expect(header(b).equals(header(VALID))).toBe(true);
    expect(logPart(b).equals(logPart(VALID))).toBe(true);
    expect(ledgerNow(b.toString())).toBe(block);

    // A ledger with "## " sections after ## Log (RESCOPE, Close): the Now block is replaced, the
    // Log and every section after it are byte-unchanged, and show lists the same rows as before.
    const tailSec = "## RESCOPE 1 (x)\n- s1\n## Close\n- c1\n";
    const l2 = put(path.join(f.tasks, "LWO-002-y.md"), VALID.toString() + tailSec);
    const rows = (out: string) => out.slice(out.indexOf("== Log (")).split("\n").filter((x) => x.startsWith("- "));
    const show0 = ledger(f, [l2, "show", "99"]);
    expect(show0.rc).toBe(0);
    const r2 = ledger(f, [l2, "now", nf]);
    expect(r2.rc).toBe(0);
    const b2 = readFileSync(l2);
    expect(header(b2).equals(header(VALID))).toBe(true);
    expect(logPart(b2).equals(Buffer.concat([logPart(VALID), Buffer.from(tailSec)]))).toBe(true);
    expect(ledgerNow(b2.toString())).toBe(block);
    const show1 = ledger(f, [l2, "show", "99"]);
    expect(show1.rc).toBe(0);
    expect(rows(show1.out)).toEqual(rows(show0.out));
    expect(rows(show1.out)).toHaveLength(3);
  });

  test("LD-now-16", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const nf = put(path.join(f.root, "now.txt"), lines(16) + "\n");
    refused(ledger(f, [l, "now", nf]), 7, l, before, "more than 15 lines");
  });

  test("LD-now-15-nonl", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const nf = put(path.join(f.root, "now.txt"), lines(15));
    const r = ledger(f, [l, "now", nf]);
    expect(r.rc).toBe(0);
    const b = readFileSync(l);
    expect(b.toString().split("\n").filter((x) => x === "## Log")).toHaveLength(1);
    expect(logPart(b).equals(logPart(VALID))).toBe(true);
    expect(nowBytes(l).toString()).toBe(lines(15) + "\n");
  });

  test("LD-now-16-nonl", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const nf = put(path.join(f.root, "now.txt"), lines(16));
    refused(ledger(f, [l, "now", nf]), 7, l, before, "more than 15 lines");
  });

  test("LD-now-crlf", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const nf = put(path.join(f.root, "now.txt"), lines(3).replaceAll("\n", "\r\n") + "\r\n");
    refused(ledger(f, [l, "now", nf]), 5, l, before, "CR in now file");
  });

  for (const [title, text] of [
    ["LD-now-nostate", lines(15, false)],
    ["LD-now-quoted-state", 'Order: "State: X". Tier: L.'],
    ["LD-now-empty-state", "Order: o. State: ."],
    ["LD-now-nodot-state", "Order: o, State: X"],
  ] as const) {
    test(title, () => {
      const f = fx();
      const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
      const before = sha1(l);
      const nf = put(path.join(f.root, "now.txt"), text + "\n");
      refused(ledger(f, [l, "now", nf]), 8, l, before, "no State the hook can read");
    });
  }

  test("LD-now-lower-state", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const nf = put(path.join(f.root, "now.txt"), "Order: o. state: open.\n");
    const r = ledger(f, [l, "now", nf]);
    expect(r.rc).toBe(0);
    expect(nowBytes(l).toString()).toBe("Order: o. state: open.\n");
  });

  test("LD-now-header", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const nf = put(path.join(f.root, "now.txt"), "Order: o. State: X.\n## X\n- more\n");
    refused(ledger(f, [l, "now", nf]), 9, l, before, "## line in now file");
  });

  test("LD-now-empty", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const zero = put(path.join(f.root, "zero.txt"), "");
    refused(ledger(f, [l, "now", zero]), 6, l, before, "empty");
    const blank = put(path.join(f.root, "blank.txt"), "\n  \n\t\n");
    refused(ledger(f, [l, "now", blank]), 6, l, before, "empty");
  });

  test("LD-now-missing", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    refused(ledger(f, [l, "now", path.join(f.root, "absent.txt")]), 6, l, before, "empty");
  });

  test("LD-now-longline", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const long = put(path.join(f.root, "long.txt"), `Order: o. State: X.\n${"a".repeat(1001)}\n- three\n`);
    refused(ledger(f, [l, "now", long]), 7, l, before, "line over 1000");
    const ok = put(path.join(f.root, "ok.txt"), `Order: o. State: X.\n${"a".repeat(1000)}\n- three\n`);
    expect(ledger(f, [l, "now", ok]).rc).toBe(0);
  });

  test("LD-path-dotdot", () => {
    const f = fx();
    const l = put(path.join(f.vault, "lab", "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const dotdot = `${f.tasks}/../LWO-001-x.md`; // literal: path.join would collapse the ".."
    expect(dotdot).toContain("/../");
    refused(ledger(f, [dotdot, "log", "x"]), 1, l, before);
  });

  test("LD-path-link-out", () => {
    const f = fx();
    const target = put(path.join(f.root, "elsewhere", "LWO-002-y.md"), VALID);
    const before = sha1(target);
    const link = path.join(f.tasks, "LWO-002-y.md");
    symlinkSync(target, link);
    refused(ledger(f, [link, "log", "x"]), 1, target, before);
  });

  test("LD-path-link-in", () => {
    const f = fx();
    const target = put(path.join(f.tasks, "LWO-006-b.md"), VALID);
    const link = path.join(f.tasks, "LWO-005-a.md");
    symlinkSync(target, link);
    const r = ledger(f, [link, "log", "x"]);
    expect(r.rc).toBe(0);
    expect(readFileSync(target).toString()).toMatch(/\n- \S+ x\n$/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("LD-path-corp", () => {
    const f = fx();
    const l = put(path.join(f.vault, "corp", "tasks", "LWO-001-x.md"), VALID);
    const before = sha1(l);
    refused(ledger(f, [l, "log", "x"]), 1, l, before);
  });

  test("LD-path-name", () => {
    const f = fx();
    // "LWO-001-x 2.md": an iCloud duplicate, which the hook skips (hook:285) — not a name it accepts.
    for (const name of ["LWO-21-x.md", "notes.md", "LWO-001-x 2.md"]) {
      const l = put(path.join(f.tasks, name), VALID);
      const before = sha1(l);
      refused(ledger(f, [l, "log", "x"]), 2, l, before, "name is not LWO-NNN-<slug>.md");
    }
    const ok = put(path.join(f.tasks, "LWO-1000-x.md"), VALID);
    expect(ledger(f, [ok, "log", "x"]).rc).toBe(0);
  });

  test("LD-path-ok", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-003-z.md"), VALID);
    const r = ledger(f, [l, "log", "x"]);
    expect(r.rc).toBe(0);
    expect(readFileSync(l).toString()).toMatch(/\n- \S+ x\n$/);
  });

  test("LD-root-rel", () => {
    const f = fx();
    const l = put(path.join(f.root, "rel", "vault", "lab", "tasks", "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const r = ledger(f, ["rel/vault/lab/tasks/LWO-001-x.md", "log", "x"], { vault: "rel/vault", cwd: f.root });
    refused(r, 1, l, before, "vault root not absolute");
  });

  test("LD-missing", () => {
    const f = fx();
    const l = path.join(f.tasks, "LWO-004-none.md");
    refused(ledger(f, [l, "log", "x"]), 3, null, null, "no such ledger");
    expect(existsSync(l)).toBe(false);
    // An unreadable ledger is "no such ledger" on every verb (show too), before any shape read.
    const u = put(path.join(f.tasks, "LWO-005-u.md"), VALID);
    const before = sha1(u);
    const nf = put(path.join(f.root, "now.txt"), "Order: o. Tier: L. State: X.\n");
    chmodSync(u, 0o000);
    try {
      for (const args of [["show"], ["log", "x"], ["now", nf]]) {
        const r = ledger(f, [u, ...args]);
        expect(r.rc).toBe(2);
        expect(r.err).toBe("ledger.sh: L3: no such ledger\n");
      }
    } finally {
      chmodSync(u, 0o644);
    }
    expect(sha1(u)).toBe(before);
  });

  test("LD-text", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    for (const text of ["", "a\nb", "a\rb"]) refused(ledger(f, [l, "log", text]), 5, l, before);
    // A NUL in the now file is not text: refused before the CR and length checks could miss bytes.
    const nulCr = put(path.join(f.root, "nul-cr.txt"), "Order: o. State: X.\n\0\rfoo\n");
    refused(ledger(f, [l, "now", nulCr]), 5, l, before, "NUL in now file");
    const nul1001 = put(path.join(f.root, "nul-1001.txt"), `Order: o. State: X.\n${"a".repeat(1000)}\0\n`);
    refused(ledger(f, [l, "now", nul1001]), 5, l, before, "NUL in now file");
  });

  test("LD-shape", () => {
    const f = fx();
    const v = VALID.toString();
    for (const bad of [
      v.replace("## Now\n", "## Now\n- a\n## Now\n"),
      v.replace("## Log\n", ""),
      v.replace("## Now\n", "## Log\n").replace(/## Log\n- 2026-10-01T00:00:00Z/, "## Now\n- 2026-10-01T00:00:00Z"),
      // "## Now" + U+00A0 above the real one: the hook's trimEnd() takes it as the first ## Now.
      v.replace("## Now\n", "## Now \n- a\n## Now\n"),
      // A lone "## Now" + a byte the hook's trimEnd() keeps: no Now block to the hook, so L4 here.
      v.replace("## Now\n", "## Now\u0001\n"),
      // A NUL anywhere (read drops it, trimEnd keeps it): "## Now<NUL>" as the only Now header.
      v.replace("## Now\n", "## Now\0\n"),
    ]) {
      const l = put(path.join(f.tasks, "LWO-001-x.md"), bad);
      const before = sha1(l);
      refused(ledger(f, [l, "log", "x"]), 4, l, before, "shape: ## Now / ## Log");
    }
  });

  test("LD-shape-inner", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID.toString().replace("## Log\n", "## Evidence\n- e\n## Log\n"));
    const before = sha1(l);
    refused(ledger(f, [l, "log", "x"]), 4, l, before, "shape: ## Now / ## Log");
  });

  test("LD-show-12", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), ROWS13);
    const r = ledger(f, [l, "show"]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("== Log (last 12 of 13)\n");
    for (let i = 2; i <= 13; i++) expect(r.out).toContain(` r${String(i).padStart(2, "0")}\n`);
    expect(r.out).not.toContain(" r01");
  });

  test("LD-show-n", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), ROWS13);
    const one = ledger(f, [l, "show", "1"]);
    expect(one.rc).toBe(0);
    const rows1 = one.out.slice(one.out.indexOf("== Log (")).split("\n").filter((x) => x.startsWith("- "));
    expect(rows1).toHaveLength(1);
    expect(rows1[0]).toMatch(/ r13$/);
    const all = ledger(f, [l, "show", "99"]);
    expect(all.rc).toBe(0);
    expect(all.out.slice(all.out.indexOf("== Log (")).split("\n").filter((x) => / r\d\d$/.test(x))).toHaveLength(13);
    const before = sha1(l);
    for (const n of ["0", "100", "x", ""]) refused(ledger(f, [l, "show", n]), 10, l, before, "show N must be 1..99");
  });

  test("LD-verb", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    refused(ledger(f, [l, "bogus", "x"]), 11, l, before, "usage");
    refused(ledger(f, [l, "log"]), 11, l, before, "usage");
  });

  test("LD-tmp-clean", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const clean = () => {
      expect(readdirSync(f.tmp).filter((x) => x.startsWith("ledger-sh."))).toEqual([]);
      expect(readdirSync(f.tasks).filter((x) => /^\..*\.ledger-tmp\./.test(x))).toEqual([]);
    };
    expect(ledger(f, [l, "log", "row four"]).rc).toBe(0);
    clean();
    const nf = put(path.join(f.root, "now.txt"), "Order: o. Tier: L.\n");
    const before = sha1(l);
    refused(ledger(f, [l, "now", nf]), 8, l, before, "no State the hook can read");
    clean();
  });

  /** A copy of ledger.sh at <root>/plug/skills/hub-delegate/ledger.sh; hooks/ copied in when given. */
  function plug(f: Fx, hook?: (src: string) => string): string {
    const sh = path.join(f.root, "plug", "skills", "hub-delegate", "ledger.sh");
    mkdirSync(path.dirname(sh), { recursive: true });
    copyFileSync(LEDGER_SH, sh);
    if (hook) {
      const h = path.join(f.root, "plug", "hooks");
      mkdirSync(h, { recursive: true });
      writeFileSync(path.join(h, "ledger-compact.js"), hook(readFileSync(path.join(HOOKS, "ledger-compact.js"), "utf8")));
      for (const dep of ["ctx-mod.js", "ctx-log.js"]) copyFileSync(path.join(HOOKS, dep), path.join(h, dep));
    }
    return sh;
  }

  const STATEOF = "export function stateOf(nowText, ledger) {";

  test("LD-hook-absent", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const nf = put(path.join(f.root, "now.txt"), "Order: o. State: X.\n");
    refused(ledger(f, [l, "now", nf], { sh: plug(f) }), 14, l, before, "hook absent");
    expect(ledger(f, [l, "now", nf], { sh: plug(f, (s) => s) }).rc).toBe(0);
  });

  test("LD-node-absent", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const nf = put(path.join(f.root, "now.txt"), "Order: o. State: X.\n");
    refused(ledger(f, [l, "now", nf], { path: "/usr/bin:/bin" }), 14, l, before, "node absent");
  });

  test("LD-hook-throws", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const nf = put(path.join(f.root, "now.txt"), "Order: o. State: X.\n");
    const sh = plug(f, (s) => {
      expect(s.split(STATEOF)).toHaveLength(2);
      return s.replace(STATEOF, `${STATEOF}\n  throw new Error("LD-hook-throws")`);
    });
    refused(ledger(f, [l, "now", nf], { sh }), 14, l, before, "node rc 1");
  });

  test("LD-hook-garbage", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const nf = put(path.join(f.root, "now.txt"), "Order: o. State: X.\n");
    const sh = plug(f, (s) => {
      expect(s.split(STATEOF)).toHaveLength(2);
      return s.replace(STATEOF, `${STATEOF}\n  process.stdout.write("an extra line\\n")`);
    });
    refused(ledger(f, [l, "now", nf], { sh }), 14, l, before, "bad output");
  });

  test("LD-now-mb-1000", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const line = "é".repeat(500);
    expect(Buffer.byteLength(line)).toBe(1000);
    const nf = put(path.join(f.root, "now.txt"), `Order: o. State: X.\n${line}\n- three\n`);
    expect(ledger(f, [l, "now", nf]).rc).toBe(0);
  });

  test("LD-now-mb-1001", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const before = sha1(l);
    const line = "é".repeat(500) + "a";
    expect(Buffer.byteLength(line)).toBe(1001);
    const nf = put(path.join(f.root, "now.txt"), `Order: o. State: X.\n${line}\n- three\n`);
    refused(ledger(f, [l, "now", nf]), 7, l, before, "line over 1000");
  });

  test("LD-mode", () => {
    expect(statSync(LEDGER_SH).mode & 0o111).toBe(0);
    // The ledger keeps its own mode across a write (the vault temp is a 0600 mktemp file).
    const f = fx();
    for (const mode of [0o644, 0o640]) {
      const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
      chmodSync(l, mode);
      expect(ledger(f, [l, "log", "x"]).rc).toBe(0);
      expect(statSync(l).mode & 0o777).toBe(mode);
      const nf = put(path.join(f.root, "now.txt"), "Order: o. Tier: L. State: X.\n");
      expect(ledger(f, [l, "now", nf]).rc).toBe(0);
      expect(statSync(l).mode & 0o777).toBe(mode);
    }
  });

  test("LD-grep", () => {
    // The definition's own control: prefixed forms are found, look-alikes are not.
    const f = fx();
    const sample = put(path.join(f.root, "sample.sh"), [
      "env git status", "command gh pr list", "exec tmux ls", "x | xargs git rm", "time curl -s u",
      "nohup claude -p q", "{ git x; }", "FOO=1 git log", `A=1 B="x y" /usr/local/bin/omt hub`,
      `V="\${X:-$HOME/a/omt}"`, "# git in a comment", "printf github", "legit x", "echo omt",
    ].join("\n") + "\n");
    expect(commandWords(sample)).toEqual(["git", "gh", "tmux", "git", "curl", "claude", "git", "git", "omt"]);
    expect(commandWords(LEDGER_SH)).toEqual([]);
    expect(commandWords(RERUN_SH)).toContain("git");
  });

  test("LD-serial", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const block = "Order: o. Tier: L. State: SERIAL.\n- a\n- b\n";
    const nf = put(path.join(f.root, "now.txt"), block);
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const sh = `/bin/bash ${q(LEDGER_SH)} ${q(l)} now ${q(nf)} && /bin/bash ${q(LEDGER_SH)} ${q(l)} log "x" && /bin/bash ${q(LEDGER_SH)} ${q(l)} show 1`;
    const r = child(["/bin/bash", "-c", sh], f);
    expect(r.rc).toBe(0);
    const after = [...r.out.matchAll(/^sha1-after: ([0-9a-f]{40})$/gm)].map((m) => m[1]);
    const before = [...r.out.matchAll(/^sha1-before: ([0-9a-f]{40})$/gm)].map((m) => m[1]);
    expect(after).toHaveLength(2);
    expect(before).toHaveLength(2);
    expect(after[0]).toBe(before[1]);
    expect(nowBytes(l).toString()).toBe(block);
    const shown = r.out.slice(r.out.lastIndexOf("== Log (")).split("\n").filter((x) => x.startsWith("- "));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/^- \S+ x$/);
  });

  test("LD-now-split-utf8", () => {
    const f = fx();
    const l = put(path.join(f.tasks, "LWO-001-x.md"), VALID);
    const input = Buffer.concat([
      Buffer.from("Order: o. State: X.\n"),
      Buffer.from("a".repeat(999)),
      Buffer.from([0xc3]),
      Buffer.from("\n- three\n"),
    ]);
    const nf = put(path.join(f.root, "now.txt"), input);
    expect(ledger(f, [l, "now", nf]).rc).toBe(0);
    expect(nowBytes(l).equals(input)).toBe(true);
  });

  // ── §3.3 rerun.sh ──────────────────────────────────────────────────────────

  /** The fixture repo's git: /usr/bin/git with the G12 env, never PATH's git. */
  function fgit(f: Fx, args: string[], cwd: string): string {
    return fgitRaw(f, args, cwd).toString();
  }

  /** fgit's stdout as raw bytes (the staged sha1 is taken over bytes, as rerun.sh's shasum is). */
  function fgitRaw(f: Fx, args: string[], cwd: string): Buffer {
    const p = Bun.spawnSync(["/usr/bin/git", ...args], {
      cwd,
      env: {
        HOME: f.root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        PATH: process.env.PATH as string,
        GIT_AUTHOR_NAME: "kit",
        GIT_AUTHOR_EMAIL: "kit@example.invalid",
        GIT_COMMITTER_NAME: "kit",
        GIT_COMMITTER_EMAIL: "kit@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) throw new Error(`HARNESS BROKEN: git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout;
  }

  const A_TEST = [
    'import { expect, test } from "bun:test";',
    'test("RR fixture one", () => expect(1).toBe(1));',
    'test("RR fixture two", () => expect(2).toBe(2));',
    'test("RR fixture red", () => expect(1).toBe(2));',
    "",
  ].join("\n");

  type Rr = { f: Fx; repo: string; tree: string; base: string; sha: string; suites: string };

  /**
   * The fixture repo: base commit B (.gitignore, a tracked .mcp.json, a .gitattributes naming an
   * undefined filter `kit` on test/a.test.ts, test/a.test.ts with 2 pass
   * and 1 red), a remote origin at a fixture bare repo, and a worktree T from B whose staged change
   * adds 1 passing test. The staged sha1 is the shasum of T's `diff --cached --binary`.
   */
  function rrFixture(): Rr {
    const f = fx();
    const repo = path.join(f.root, "repo");
    const bare = path.join(f.root, "origin.git");
    mkdirSync(repo);
    fgit(f, ["init", "-q", "-b", "master"], repo);
    put(path.join(repo, ".gitignore"), "node_modules/\nchannel/node_modules/\n");
    put(path.join(repo, ".mcp.json"), '{"mcpServers":{}}\n');
    // Names a filter no config defines (git ignores it), so a sub-case can define it in T's config.
    put(path.join(repo, ".gitattributes"), "test/a.test.ts filter=kit\n");
    put(path.join(repo, "test", "a.test.ts"), A_TEST);
    fgit(f, ["add", "-A"], repo);
    fgit(f, ["commit", "-q", "-m", "B"], repo);
    const base = fgit(f, ["rev-parse", "HEAD"], repo).trim();
    fgit(f, ["init", "-q", "--bare", bare], f.root);
    fgit(f, ["remote", "add", "origin", bare], repo);
    const tree = path.join(f.root, "T");
    fgit(f, ["worktree", "add", "-q", "--detach", tree, base], repo);
    put(path.join(tree, "test", "a.test.ts"), A_TEST + 'test("RR fixture three", () => expect(3).toBe(3));\n');
    fgit(f, ["add", "test/a.test.ts"], tree);
    const sha = createHash("sha1").update(fgitRaw(f, ["diff", "--cached", "--binary"], tree)).digest("hex");
    const suites = put(path.join(f.root, "suites.txt"), "bun test test/a.test.ts\n");
    return { f, repo, tree, base, sha, suites };
  }

  /** A fresh <D> under /private/tmp, outside the fixture tree. */
  function freshD(rr: Rr, name = "d"): string {
    const d = path.join(rr.f.root, name);
    mkdirSync(d);
    return d;
  }

  const POLLUTION = { OMT_POLLUTE: "1", TMUX: "/tmp/fake,1,1", ROUTER_PORT: "1" };

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** The pid is a rerun.sh run (its command line), not a process that reused the number. */
  const isRun = (pid: number) => {
    const p = Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 && p.stdout.toString().includes("rerun.sh --run");
  };

  /** A marker hook: an executable script that creates <name> under the fixture root and exits 1. */
  function markerHook(rr: Rr, name: string): { hook: string; marker: string } {
    const marker = path.join(rr.f.root, name);
    const hook = put(path.join(rr.f.root, `${name}.sh`), `#!/bin/sh\n: > '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    return { hook, marker };
  }

  /**
   * A presence control: plain /usr/bin/git in T with the G12 env, its rc ignored. With `global`, the
   * hostile keys' file is GIT_CONFIG_GLOBAL, as the run under test got it.
   */
  function plainGit(rr: Rr, args: string[], global = "/dev/null"): Buffer {
    return Bun.spawnSync(["/usr/bin/git", "-C", rr.tree, ...args], {
      env: { HOME: rr.f.root, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", PATH: process.env.PATH as string },
      stdout: "pipe",
      stderr: "ignore",
    }).stdout;
  }

  /**
   * Hostile keys in a global config file (not T's repo config, which R6's allowlist refuses), so a
   * sub-case proves the NOEXEC pins, the second layer, still hold.
   */
  function globalCfg(rr: Rr, entries: [string, string][]): string {
    const file = put(path.join(rr.f.root, "kit-global.gitconfig"), "");
    for (const [k, v] of entries) fgit(rr.f, ["config", "--file", file, k, v], rr.f.root);
    return file;
  }

  /** A FIFO (no writer) at <file>, in place of anything there. */
  function fifo(file: string): string {
    if (existsSync(file)) unlinkSync(file);
    const p = Bun.spawnSync(["/usr/bin/mkfifo", file], { stdout: "ignore", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`HARNESS BROKEN: mkfifo ${file}: ${p.stderr.toString()}`);
    return file;
  }

  /**
   * Release a reader blocked on <file>'s open, if any: ENXIO means no reader, ENOENT no FIFO, so
   * nothing to release (and no throw from a finally to hide the row's own failure).
   */
  function releaseFifo(file: string): void {
    try {
      closeSync(openSync(file, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENXIO" && code !== "ENOENT") throw e;
    }
  }

  /**
   * Write <mode> into T's index entry <name> (index v2: entries from byte 12, the mode word at +24,
   * the name length in the flags at +60, each entry padded with NULs to a multiple of 8), and zero
   * the trailing checksum, which git accepts as "not computed". Git keeps a non-canonical mode as read.
   */
  function setIndexMode(rr: Rr, name: string, mode: number): void {
    const file = fgit(rr.f, ["rev-parse", "--path-format=absolute", "--git-path", "index"], rr.tree).trim();
    const b = readFileSync(file);
    if (b.toString("latin1", 0, 4) !== "DIRC" || b.readUInt32BE(4) !== 2) throw new Error("HARNESS BROKEN: index not v2");
    let off = 12;
    for (let i = 0, n = b.readUInt32BE(8); i < n; i++) {
      const len = b.readUInt16BE(off + 60) & 0xfff;
      if (b.toString("utf8", off + 62, off + 62 + len) === name) {
        b.writeUInt32BE(mode, off + 24);
        b.fill(0, b.length - 20);
        writeFileSync(file, b);
        return;
      }
      off += Math.floor((62 + len + 8) / 8) * 8;
    }
    throw new Error(`HARNESS BROKEN: no index entry ${name}`);
  }

  /** The processes in the run's group (setsid made the run its group leader). */
  const group = (pid: number) =>
    Bun.spawnSync(["/usr/bin/pgrep", "-g", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString();

  /** Make T's test/a.test.ts stat-dirty (same bytes, new mtime), so a diff must re-read it. */
  function statDirty(rr: Rr, sec: number): void {
    utimesSync(path.join(rr.tree, "test", "a.test.ts"), sec, sec);
  }

  type Call = { launch: Run; pid: number; out: string };

  /**
   * One call: `bash rerun.sh <D> T B <sha1> <suites>` with the kit's polluted env. When the launcher
   * starts a run, wait up to 150 s for out/done or a dead pid, then assert the run's exact pid gone.
   * A run still alive after the wait is ended by its exact pid in the finally, and the row fails.
   * The kit is not the run's parent, so unlike child() it can see a reused pid: it signals only a
   * pid whose command line is still `rerun.sh --run`. `env` is added to the launcher's env;
   * `onStart` runs once the run has started, before the wait; `waitMs` replaces the 150 s.
   */
  async function rrCall(
    rr: Rr,
    d: string,
    args: string[],
    opts: { env?: Record<string, string>; onStart?: (pid: number) => Promise<void>; waitMs?: number } = {},
  ): Promise<Call> {
    const launch = child(["/bin/bash", RERUN_SH, d, ...args], rr.f, { env: { ...POLLUTION, ...(opts.env ?? {}) } });
    const m = launch.out.match(/^pid: (\d+)$/m);
    const pid = m ? Number(m[1]) : 0;
    const out = path.join(d, "out");
    if (pid > 0) {
      try {
        if (opts.onStart) await opts.onStart(pid);
        const t0 = Date.now();
        while (Date.now() - t0 < (opts.waitMs ?? 150_000) && !existsSync(path.join(out, "done")) && alive(pid)) await Bun.sleep(100);
        for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(100);
        expect(alive(pid)).toBe(false);
      } finally {
        if (alive(pid) && isRun(pid)) process.kill(pid, "SIGTERM");
      }
    }
    return { launch, pid, out };
  }

  const rd = (c: Call, name: string) => readFileSync(path.join(c.out, name), "utf8");

  /** Every entry under a dir, relative, sorted (to show that nothing was created). */
  function listing(dir: string): string[] {
    const acc: string[] = [];
    const walk = (p: string, rel: string) => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        acc.push(rel + e.name);
        if (e.isDirectory()) walk(path.join(p, e.name), rel + e.name + "/");
      }
    };
    walk(dir, "");
    return acc.sort();
  }

  test("RR-sha", async () => {
    const rr = rrFixture();
    const bad = (rr.sha[0] === "0" ? "1" : "0") + rr.sha.slice(1);
    // S02 r1 MED-2: a core.fsmonitor must not run inside rerun.sh's git calls (set globally: T's own
    // repo config is refused by R6's allowlist first, see RR-head).
    const marker = path.join(rr.f.root, "FSMON-RAN");
    const hook = put(path.join(rr.f.root, "fsmon.sh"), `#!/bin/sh\n: > '${marker}'\n`);
    chmodSync(hook, 0o755);
    const g = globalCfg(rr, [["core.fsmonitor", hook]]);
    const c = await rrCall(rr, freshD(rr), [rr.tree, rr.base, bad, rr.suites], { env: { GIT_CONFIG_GLOBAL: g } });
    expect(c.launch.rc).toBe(0);
    expect(rd(c, "rc.txt")).toBe("4\n");
    const s = rd(c, "summary.txt");
    expect(s).toContain("SHA MISMATCH\n");
    expect(existsSync(path.join(c.out, "done"))).toBe(true);
    expect(s.split("\n").filter((x) => x.startsWith("== "))).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    // Presence control: the same hook does run under a plain git diff, else HARNESS BROKEN.
    plainGit(rr, ["diff", "--name-only"], g);
    expect(existsSync(marker)).toBe(true);
    // S02 r2 CQ MAJOR + MED-d, r3 CQ: a filter clean driver (from B's .gitattributes) must not run,
    // and patch-shaping config must not change staged.patch: with the right sha1 the run passes R3
    // (rc 5, the S03 placeholder), and R6 has removed <D>/tmp.
    const rr3 = rrFixture();
    const flt = markerHook(rr3, "FILTER-RAN");
    const g3 = globalCfg(rr3, [
      ["filter.kit.clean", `'${flt.hook}'; cat`],
      ["diff.noprefix", "true"],
      ["diff.context", "0"],
      ["color.ui", "always"],
      ["color.diff", "always"],
      ["diff.srcPrefix", "ZZ/"],
      ["diff.dstPrefix", "YY/"],
      ["diff.submodule", "log"],
    ]);
    statDirty(rr3, 1_000_000_000);
    const d3 = freshD(rr3);
    const c3 = await rrCall(rr3, d3, [rr3.tree, rr3.base, rr3.sha, rr3.suites], { env: { GIT_CONFIG_GLOBAL: g3 } });
    expect(rd(c3, "rc.txt")).toBe("5\n");
    expect(rd(c3, "summary.txt")).toContain("APPLY FAILED: copy and suites not built yet (S03)\n");
    expect(existsSync(flt.marker)).toBe(false);
    expect(existsSync(path.join(d3, "tmp"))).toBe(false);
    // Presence controls: plain git runs the filter, and its staged patch differs from the sha1.
    statDirty(rr3, 1_000_000_100);
    plainGit(rr3, ["diff", "--name-only"], g3);
    expect(existsSync(flt.marker)).toBe(true);
    const plain = plainGit(rr3, ["diff", "--cached", "--binary"], g3);
    expect(createHash("sha1").update(plain).digest("hex")).not.toBe(rr3.sha);
    // S02 r2 MED-a: a lazy fetch from a promisor remote (core.sshCommand) must not run. The promisor
    // is global (git honours it from any scope); T's repo config holds only the allowed url.
    const rr5 = rrFixture();
    const ssh = markerHook(rr5, "SSH-RAN");
    fgit(rr5.f, ["config", "remote.origin.url", "ssh://kit.invalid/x.git"], rr5.repo);
    const g5 = globalCfg(rr5, [["remote.origin.promisor", "true"], ["core.sshCommand", ssh.hook]]);
    // The base side's blob (the staged side can be read from the up-to-date worktree file instead).
    const blob = fgit(rr5.f, ["ls-tree", "HEAD", "test/a.test.ts"], rr5.tree).split(/\s+/)[2];
    const objects = fgit(rr5.f, ["rev-parse", "--path-format=absolute", "--git-common-dir"], rr5.tree).trim();
    renameSync(path.join(objects, "objects", blob.slice(0, 2), blob.slice(2)), path.join(rr5.f.root, "moved-blob"));
    const c5 = await rrCall(rr5, freshD(rr5), [rr5.tree, rr5.base, rr5.sha, rr5.suites], { env: { GIT_CONFIG_GLOBAL: g5 } });
    expect(rd(c5, "rc.txt")).toBe("4\n");
    expect(existsSync(ssh.marker)).toBe(false);
    // Presence control: plain git lazy-fetches and runs core.sshCommand.
    plainGit(rr5, ["diff", "--cached", "--binary"], g5);
    expect(existsSync(ssh.marker)).toBe(true);
    // EC3-12: a 39-hex staged sha1 is an R0 usage refusal, and nothing is created under <D>.
    const d2 = freshD(rr, "d39");
    const r0 = child(["/bin/bash", RERUN_SH, d2, rr.tree, rr.base, rr.sha.slice(1), rr.suites], rr.f, { env: POLLUTION });
    expect(r0.rc).toBe(2);
    expect(r0.err).toContain("R0: usage");
    expect(listing(d2)).toEqual([]);
  }, 200_000);

  test("RR-head", async () => {
    const rr = rrFixture();
    const d = freshD(rr);
    put(path.join(d, "out", "log.txt"), "stale\n");
    put(path.join(d, "tcache", "x"), "stale\n");
    // S02 r1 CQ NIT: a planted pid "0" (kill -0 0 hits the caller's own group) is not a live run.
    put(path.join(d, "out", "pid"), "0\n");
    const notBase = (rr.base[0] === "0" ? "1" : "0") + rr.base.slice(1);
    const c = await rrCall(rr, d, [rr.tree, notBase, rr.sha, rr.suites]);
    expect(c.launch.rc).toBe(0);
    expect(c.launch.out).not.toContain("run alive");
    expect(c.pid).toBeGreaterThan(0);
    expect(rd(c, "pid")).toBe(`${c.pid}\n`);
    expect(rd(c, "rc.txt")).toBe("2\n");
    const s = rd(c, "summary.txt");
    expect(s).toMatch(/^R2: /m);
    expect(existsSync(path.join(d, "out", "log.txt"))).toBe(false);
    expect(existsSync(path.join(d, "tcache"))).toBe(false);
    expect(readdirSync(c.out).sort()).toEqual(["done", "launcher.txt", "pid", "rc.txt", "summary.txt"]);
    expect(s).toContain("log: (none)\n");
    expect(s).toContain("log-sha1: (none)\n");
    expect(s).not.toContain("copy: FAILED");
    // S02 r1 CQ-2: a subdir of the worktree, at the right HEAD, is refused by R2.
    const c2 = await rrCall(rr, freshD(rr, "dsub"), [path.join(rr.tree, "test"), rr.base, rr.sha, rr.suites]);
    expect(rd(c2, "rc.txt")).toBe("2\n");
    expect(rd(c2, "summary.txt")).toMatch(/^R2: tree .* is not its worktree's top$/m);
    // S02 r2 QA: only the pid file's first line is read: "<live pid>\n7" is a live run (the kit's
    // own pid, so no extra process), refused with nothing changed.
    const d4 = freshD(rr, "dalive");
    put(path.join(d4, "out", "pid"), `${process.pid}\n7\n`);
    const before4 = listing(d4);
    const r4 = child(["/bin/bash", RERUN_SH, d4, rr.tree, rr.base, rr.sha, rr.suites], rr.f, { env: POLLUTION });
    expect(r4.rc).toBe(2);
    expect(r4.out).toContain(`rerun.sh: run alive: ${process.pid}\n`);
    expect(listing(d4)).toEqual(before4);
    // S02 r3 N-S02-16: a repo-level config key outside the allowlist is refused before any diff
    // (filter.kit.clean, which B's .gitattributes names, with T stat-dirty): the filter never runs.
    const rr6 = rrFixture();
    const flt = markerHook(rr6, "FILTER-LOCAL-RAN");
    fgit(rr6.f, ["config", "filter.kit.clean", `'${flt.hook}'; cat`], rr6.tree);
    statDirty(rr6, 1_000_000_000);
    const c6 = await rrCall(rr6, freshD(rr6, "dcfg"), [rr6.tree, rr6.base, rr6.sha, rr6.suites]);
    expect(rd(c6, "rc.txt")).toBe("6\n");
    expect(rd(c6, "summary.txt")).toMatch(/^R6: config key filter\.kit\.clean not allowed$/m);
    expect(existsSync(flt.marker)).toBe(false);
    // Presence control: the same tree with the key removed passes R2..R6 (rc 5, the S03 placeholder).
    fgit(rr6.f, ["config", "--unset", "filter.kit.clean"], rr6.tree);
    const c6b = await rrCall(rr6, freshD(rr6, "dcfg2"), [rr6.tree, rr6.base, rr6.sha, rr6.suites]);
    expect(rd(c6b, "rc.txt")).toBe("5\n");
    // An include is refused by the same rule.
    fgit(rr6.f, ["config", "include.path", "/dev/null"], rr6.tree);
    const c6c = await rrCall(rr6, freshD(rr6, "dcfg3"), [rr6.tree, rr6.base, rr6.sha, rr6.suites]);
    expect(rd(c6c, "summary.txt")).toMatch(/^R6: config key include\.path not allowed$/m);
    // With extensions.worktreeConfig, T's own config.worktree is read too.
    fgit(rr6.f, ["config", "--unset", "include.path"], rr6.tree);
    fgit(rr6.f, ["config", "extensions.worktreeConfig", "true"], rr6.repo);
    fgit(rr6.f, ["config", "--worktree", "core.fsmonitor", flt.hook], rr6.tree);
    const c6d = await rrCall(rr6, freshD(rr6, "dcfg4"), [rr6.tree, rr6.base, rr6.sha, rr6.suites]);
    expect(rd(c6d, "summary.txt")).toMatch(/^R6: config key core\.fsmonitor not allowed$/m);
    expect(existsSync(flt.marker)).toBe(false);
    // S02 r3 MED (N-S02-14): a GIT_DIR in the hub's env is unset; here it names the empty bare
    // origin, whose HEAD would fail R2. The run checks T itself and reaches the S03 placeholder.
    const rr7 = rrFixture();
    const c7 = await rrCall(rr7, freshD(rr7, "dgitdir"), [rr7.tree, rr7.base, rr7.sha, rr7.suites], {
      env: { GIT_DIR: path.join(rr7.f.root, "origin.git") },
    });
    expect(rd(c7, "rc.txt")).toBe("5\n");
    // S02 r4 context 7: GIT_DIFF_OPTS in the hub's env is unset too (it beats the diff.context pin):
    // the run's patch keeps the clean sha1 and reaches the S03 placeholder.
    const c8 = await rrCall(rr7, freshD(rr7, "ddiffopts"), [rr7.tree, rr7.base, rr7.sha, rr7.suites], {
      env: { GIT_DIFF_OPTS: "--unified=0" },
    });
    expect(rd(c8, "rc.txt")).toBe("5\n");
  }, 200_000);

  test("RR-unstaged", async () => {
    const rr = rrFixture();
    put(path.join(rr.tree, ".gitignore"), "node_modules/\nchannel/node_modules/\nunstaged/\n");
    const c = await rrCall(rr, freshD(rr), [rr.tree, rr.base, rr.sha, rr.suites]);
    expect(rd(c, "rc.txt")).toBe("6\n");
    expect(rd(c, "summary.txt")).toMatch(/^R6: .*\.gitignore$/m);
    // S02 r1 CQ-1: a git that fails in R6 (a corrupt index) is an R6 refusal, never a pass. Since v4 the
    // first R6 call to read the index is the gitlink check's ls-files -s.
    const rr2 = rrFixture();
    const idx = fgit(rr2.f, ["rev-parse", "--path-format=absolute", "--git-path", "index"], rr2.tree).trim();
    writeFileSync(idx, "not an index\n");
    const c2 = await rrCall(rr2, freshD(rr2), [rr2.tree, rr2.base, rr2.sha, rr2.suites]);
    expect(rd(c2, "rc.txt")).toBe("6\n");
    expect(rd(c2, "summary.txt")).toMatch(/^R6: ls-files -s failed$/m);
    // S02 r2 CQ MAJOR: $GIT_DIR/info/attributes is read whatever the attribute source; a filter
    // set there is refused before any diff runs.
    const rr4 = rrFixture();
    const common = fgit(rr4.f, ["rev-parse", "--path-format=absolute", "--git-common-dir"], rr4.tree).trim();
    put(path.join(common, "info", "attributes"), "* filter=kit\n");
    const c4 = await rrCall(rr4, freshD(rr4), [rr4.tree, rr4.base, rr4.sha, rr4.suites]);
    expect(rd(c4, "rc.txt")).toBe("6\n");
    expect(rd(c4, "summary.txt")).toMatch(/^R6: info\/attributes sets a filter$/m);
    // S02 r3 QA P1: info/attributes that is not a regular file (a writer-less FIFO, which git's
    // read would block on) is refused.
    const rrF = rrFixture();
    const commonF = fgit(rrF.f, ["rev-parse", "--path-format=absolute", "--git-common-dir"], rrF.tree).trim();
    const ia = fifo(path.join(commonF, "info", "attributes"));
    try {
      const cF = await rrCall(rrF, freshD(rrF), [rrF.tree, rrF.base, rrF.sha, rrF.suites], { waitMs: 20_000 });
      expect(rd(cF, "rc.txt")).toBe("6\n");
      expect(rd(cF, "summary.txt")).toMatch(/^R6: info\/attributes is not a regular file$/m);
    } finally {
      releaseFifo(ia);
    }
    // S02 r3 QA P2: a TERM ends the run while a tree git call blocks (a writer-less FIFO at
    // info/exclude, read by ls-files --others): rc killed within the reap budget, the group empty.
    const rrT = rrFixture();
    const commonT = fgit(rrT.f, ["rev-parse", "--path-format=absolute", "--git-common-dir"], rrT.tree).trim();
    const ex = fifo(path.join(commonT, "info", "exclude"));
    const dT = freshD(rrT);
    let termAt = 0;
    try {
      const cT = await rrCall(rrT, dT, [rrT.tree, rrT.base, rrT.sha, rrT.suites], {
        waitMs: 20_000,
        onStart: async (pid) => {
          const t0 = Date.now();
          while (Date.now() - t0 < 20_000 && !existsSync(path.join(dT, "tmp", "r6-untracked"))) await Bun.sleep(50);
          expect(existsSync(path.join(dT, "tmp", "r6-untracked"))).toBe(true);
          await Bun.sleep(300);
          expect(existsSync(path.join(dT, "out", "done"))).toBe(false);
          if (alive(pid) && isRun(pid)) process.kill(pid, "SIGTERM");
          termAt = Date.now();
        },
      });
      expect(termAt).toBeGreaterThan(0);
      expect(Date.now() - termAt).toBeLessThan(15_000);
      expect(rd(cT, "rc.txt")).toBe("killed\n");
      expect(group(cT.pid)).toBe("");
    } finally {
      releaseFifo(ex);
    }
    // S02 r3 HIGH-1/HIGH-2 (N-S02-13): a gitlink in the index is refused before the first diff; the
    // submodule's own info/attributes filter (its config defines it) never runs.
    const rrG = rrFixture();
    const sub = path.join(rrG.tree, "sub");
    mkdirSync(sub);
    fgit(rrG.f, ["init", "-q", "-b", "master"], sub);
    put(path.join(sub, "f"), "f\n");
    fgit(rrG.f, ["add", "f"], sub);
    fgit(rrG.f, ["commit", "-q", "-m", "S"], sub);
    const subMark = markerHook(rrG, "SUB-FILTER-RAN");
    put(path.join(sub, ".git", "info", "attributes"), "* filter=evil\n");
    fgit(rrG.f, ["config", "filter.evil.clean", `'${subMark.hook}'; cat`], sub);
    fgit(rrG.f, ["add", "sub"], rrG.tree);
    utimesSync(path.join(sub, "f"), 1_000_000_000, 1_000_000_000);
    const cG = await rrCall(rrG, freshD(rrG), [rrG.tree, rrG.base, rrG.sha, rrG.suites]);
    expect(rd(cG, "rc.txt")).toBe("6\n");
    expect(rd(cG, "summary.txt")).toMatch(/^R6: gitlink sub$/m);
    expect(existsSync(subMark.marker)).toBe(false);
    // Presence control: plain git's worktree diff runs the submodule's filter.
    utimesSync(path.join(sub, "f"), 1_000_000_100, 1_000_000_100);
    plainGit(rrG, ["diff", "--name-only"]);
    expect(existsSync(subMark.marker)).toBe(true);
    // A gitlink only in HEAD (committed, then removed from the index) is refused from ls-tree.
    fgit(rrG.f, ["commit", "-q", "-m", "G"], rrG.tree);
    fgit(rrG.f, ["rm", "-q", "--cached", "sub"], rrG.tree);
    const headG = fgit(rrG.f, ["rev-parse", "HEAD"], rrG.tree).trim();
    const cH = await rrCall(rrG, freshD(rrG, "dhead"), [rrG.tree, headG, rrG.sha, rrG.suites]);
    expect(rd(cH, "rc.txt")).toBe("6\n");
    expect(rd(cH, "summary.txt")).toMatch(/^R6: gitlink sub$/m);
    // S02 r4 HIGH (N-S02-13, allowed modes only): a non-canonical gitlink mode written into the index
    // (160644, which git still takes as a submodule) is refused; the submodule's filter never runs.
    const rrM = rrFixture();
    const subM = path.join(rrM.tree, "sub");
    mkdirSync(subM);
    fgit(rrM.f, ["init", "-q", "-b", "master"], subM);
    put(path.join(subM, "f"), "f\n");
    fgit(rrM.f, ["add", "f"], subM);
    fgit(rrM.f, ["commit", "-q", "-m", "S"], subM);
    const markM = markerHook(rrM, "SUB-MODE-RAN");
    put(path.join(subM, ".git", "info", "attributes"), "* filter=evil\n");
    fgit(rrM.f, ["config", "filter.evil.clean", `'${markM.hook}'; cat`], subM);
    fgit(rrM.f, ["add", "sub"], rrM.tree);
    setIndexMode(rrM, "sub", 0o160644);
    expect(fgit(rrM.f, ["ls-files", "-s", "sub"], rrM.tree)).toMatch(/^160644 /);
    utimesSync(path.join(subM, "f"), 1_000_000_000, 1_000_000_000);
    const cM = await rrCall(rrM, freshD(rrM), [rrM.tree, rrM.base, rrM.sha, rrM.suites]);
    expect(rd(cM, "rc.txt")).toBe("6\n");
    expect(rd(cM, "summary.txt")).toMatch(/^R6: gitlink sub$/m);
    expect(existsSync(markM.marker)).toBe(false);
    // Presence control: plain git's worktree diff runs the submodule's filter through that entry.
    utimesSync(path.join(subM, "f"), 1_000_000_100, 1_000_000_100);
    plainGit(rrM, ["diff", "--name-only"]);
    expect(existsSync(markM.marker)).toBe(true);
    // Any other mode outside 100644/100755/120000 is refused by mode (here 100664 on a file).
    const rrN = rrFixture();
    setIndexMode(rrN, "test/a.test.ts", 0o100664);
    const cN = await rrCall(rrN, freshD(rrN), [rrN.tree, rrN.base, rrN.sha, rrN.suites]);
    expect(rd(cN, "rc.txt")).toBe("6\n");
    expect(rd(cN, "summary.txt")).toMatch(/^R6: mode 100664 test\/a\.test\.ts$/m);
    // S02 r4 LOW (N-S02-18): an index flag that hides a change (skip-worktree S, assume-unchanged h).
    const rrS = rrFixture();
    fgit(rrS.f, ["update-index", "--skip-worktree", "test/a.test.ts"], rrS.tree);
    const cS = await rrCall(rrS, freshD(rrS), [rrS.tree, rrS.base, rrS.sha, rrS.suites]);
    expect(rd(cS, "summary.txt")).toMatch(/^R6: index flag S test\/a\.test\.ts$/m);
    fgit(rrS.f, ["update-index", "--no-skip-worktree", "--assume-unchanged", ".gitignore"], rrS.tree);
    fgit(rrS.f, ["update-index", "--no-skip-worktree", "test/a.test.ts"], rrS.tree);
    const cS2 = await rrCall(rrS, freshD(rrS, "dflag2"), [rrS.tree, rrS.base, rrS.sha, rrS.suites]);
    expect(rd(cS2, "summary.txt")).toMatch(/^R6: index flag h \.gitignore$/m);
  }, 200_000);

  test("RR-untracked", async () => {
    const rr = rrFixture();
    put(path.join(rr.tree, "test", "new.test.ts"), "// new\n");
    const c = await rrCall(rr, freshD(rr), [rr.tree, rr.base, rr.sha, rr.suites]);
    expect(rd(c, "rc.txt")).toBe("6\n");
    expect(rd(c, "summary.txt")).toMatch(/^R6: .*test\/new\.test\.ts$/m);
    // S02 r1 MED-1: a name holding a newline is written escaped and cannot forge a summary line.
    const rr2 = rrFixture();
    put(path.join(rr2.tree, "x\nrerun-rc: 0"), "x\n");
    // S02 r2 CQ + MED-b: DEL, and U+2028 (a line break to JS /m and Python splitlines), escaped too.
    put(path.join(rr2.tree, "del\x7fhere"), "x\n");
    put(path.join(rr2.tree, "ls\u2028rerun-rc: 0"), "x\n");
    const c2 = await rrCall(rr2, freshD(rr2), [rr2.tree, rr2.base, rr2.sha, rr2.suites]);
    expect(rd(c2, "rc.txt")).toBe("6\n");
    const s2 = rd(c2, "summary.txt");
    expect(s2).toContain("R6: untracked $'x\\nrerun-rc: 0'\n");
    expect(s2).toContain("R6: untracked $'del\\177here'\n");
    expect(s2).toContain("R6: untracked $'ls\\342\\200\\250rerun-rc: 0'\n");
    expect(s2.split("\n").filter((x) => x.startsWith("rerun-rc:"))).toEqual(["rerun-rc: 6"]);
    expect([...s2.matchAll(/^rerun-rc: (\S+)$/gm)].map((m) => m[1])).toEqual(["6"]);
    expect(/[^\x20-\x7e\n]/.test(s2)).toBe(false);
  }, 200_000);

  test("RR-d", async () => {
    const rr = rrFixture();
    const args = [rr.tree, rr.base, rr.sha, rr.suites];
    const run = (d: string) => child(["/bin/bash", RERUN_SH, d, ...args], rr.f, { env: POLLUTION, cwd: rr.f.root });
    const varTmp = mkdtempSync(path.join("/var/tmp", "hub-delegate-kit-"));
    roots.push(varTmp);
    const spaced = path.join(rr.f.root, "a b");
    const dollar = path.join(rr.f.root, "a$b");
    const rel = path.join(rr.f.root, "rel");
    const tilde = path.join(rr.f.root, "~");
    for (const d of [spaced, dollar, rel, tilde]) mkdirSync(d);
    for (const [arg, dir] of [
      [varTmp, varTmp],
      [spaced, spaced],
      ["rel", rel],
      ["~", tilde],
      [dollar, dollar],
    ]) {
      const before = listing(dir);
      expect(run(arg).rc).toBe(2);
      expect(listing(dir)).toEqual(before);
    }
  }, 200_000);

  test("RR-d-above", async () => {
    const rr = rrFixture();
    const args = [rr.tree, rr.base, rr.sha, rr.suites];
    const d = freshD(rr);
    put(path.join(d, "CLAUDE.md"), "x\n");
    const before = listing(d);
    expect(child(["/bin/bash", RERUN_SH, d, ...args], rr.f, { env: POLLUTION }).rc).toBe(3);
    expect(listing(d)).toEqual(before);
    const parent = mkdtempSync(path.join(TMP, "hub-delegate-kit-p-"));
    roots.push(parent);
    put(path.join(parent, "CLAUDE.md"), "x\n");
    const sub = path.join(parent, "sub");
    mkdirSync(sub);
    expect(child(["/bin/bash", RERUN_SH, sub, ...args], rr.f, { env: POLLUTION }).rc).toBe(3);
    expect(listing(sub)).toEqual([]);
  }, 200_000);

  test("RR-mode", () => {
    expect(statSync(RERUN_SH).mode & 0o111).toBe(0);
  });
});

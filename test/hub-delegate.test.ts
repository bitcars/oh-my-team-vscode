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
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  chmodSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
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
function child(argv: string[], f: Fx, opts: { vault?: string; path?: string; cwd?: string } = {}): Run {
  const env: Record<string, string> = {
    HOME: f.root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    OMT_VAULT_ROOT: opts.vault ?? f.vault,
    PATH: opts.path ?? (process.env.PATH as string),
    TMPDIR: f.tmp,
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
});

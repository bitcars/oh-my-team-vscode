/**
 * Removal control for router-vscode.test.ts.
 *
 * A green suite only proves something if it goes red when the feature is
 * gone. Each mutant below TEXTUALLY patches a temp copy of router.ts, runs
 * router-vscode.test.ts against that copy in a child `bun test` (JUnit
 * report), and asserts the named tests FAIL and the listed tests still PASS,
 * so the mutant is caught by the test meant to catch it, not by a boot crash.
 * Tests are named by title only; titles are unique in the suite.
 *
 * "HARNESS BROKEN" means the control itself is not measuring anything: the
 * unmutated copy failed, a patch did not apply exactly once, a named test
 * does not exist, or the report could not be read. Fix the harness or the
 * mutant table; never delete a mutant to go green.
 *
 * Adding a mutant is one table row.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = import.meta.dir;
const SUITE = "router-vscode.test.ts";
const COPY = ["router.ts", "dashboard-server.ts", "dashboard-pty.ts", "adapters", SUITE];

const MIRROR_CALL = `      recordAndBroadcastReply(sessionName, text, "reply", fileList);\n`;
const SEND_CALL = `        await adapter.send(session.threadId, text);\n`;
const REPLY_LOOKUP_ANCHOR = `          { error: "text (non-empty string) required" },
          { status: 400 }
        );
      }

`;
const REPLY_LOOKUP = `${REPLY_LOOKUP_ANCHOR}      const session = Object.hasOwn(registry.sessions, sessionName)
        ? registry.sessions[sessionName]
        : undefined;
`;

interface Mutant {
  name: string;
  /** Apply the mutation. Each [find, replace] must match exactly once. */
  patches: [find: string, replace: string][];
  mustFail: string[];
  mustPass: string[];
}

const MUTANTS: Mutant[] = [
  {
    name: "no-reply-mirror: /reply no longer records or broadcasts",
    patches: [[MIRROR_CALL, ""]],
    mustFail: [
      "broadcasts session.reply with every field and kind reply",
      "seq starts at 1 and increases per session, independently",
      "returns only events with seq > since, plus latest",
    ],
    mustPass: ["unknown session is 404 and mirrors nothing", "POST /permission-request broadcasts the prompt"],
  },
  {
    name: "mirror-after-send: mirror moved behind adapter.send",
    patches: [
      [MIRROR_CALL, ""],
      [SEND_CALL, SEND_CALL + MIRROR_CALL],
    ],
    mustFail: ["mirror survives a platform send failure"],
    mustPass: ["broadcasts session.reply with every field and kind reply"],
  },
  {
    name: "cap-off-by-one: log drops at CAP instead of CAP+1",
    patches: [["  if (log.length > REPLY_LOG_CAP) {\n", "  if (log.length >= REPLY_LOG_CAP) {\n"]],
    mustFail: ["at exactly CAP replies the log keeps all of them"],
    mustPass: ["seq starts at 1 and increases per session, independently"],
  },
  {
    name: "no-permission-broadcast: /permission-request stops mirroring the prompt",
    patches: [['        type: "session.permission",\n', '        type: "session.permission.disabled",\n']],
    mustFail: [
      "POST /permission-request broadcasts the prompt",
      "the prompt is broadcast even when the platform prompt fails",
    ],
    mustPass: ["forwards to the bridges and broadcasts session.permission.resolved"],
  },
  {
    name: "no-resolved-broadcast: answerPermission stops clearing panel prompts",
    patches: [['  broadcastEvent({ type: "session.permission.resolved", requestId });\n', ""]],
    mustFail: [
      "forwards to the bridges and broadcasts session.permission.resolved",
      "a platform answer also broadcasts session.permission.resolved",
    ],
    mustPass: ["POST /permission-request broadcasts the prompt"],
  },
  {
    name: "no-inject-route: /admin/inject missing",
    patches: [['url.pathname === "/admin/inject"', 'url.pathname === "/admin/inject-disabled"']],
    mustFail: ["delivers to the session's bridge and returns queued", "502 when the bridge is unreachable"],
    mustPass: ["forwards to the bridges and broadcasts session.permission.resolved"],
  },
  {
    name: "no-origin-guard: foreign Origin accepted everywhere",
    patches: [
      [
        '  const origin = req.headers.get("origin");\n  if (origin === null) return false;\n',
        '  const origin = req.headers.get("origin");\n  if (origin !== "__never__") return false;\n',
      ],
    ],
    mustFail: [
      "POST /admin/inject: foreign Origin is 403 with no side effect",
      "POST /permission-answer: foreign Origin is 403 with no side effect",
      "POST /reply: foreign Origin is 403 with no side effect",
      "WS /ws/events: foreign Origin handshake is refused",
    ],
    mustPass: ["POST /admin/inject: missing or localhost Origin passes the guard"],
  },
  {
    name: "no-ws-origin-guard: /ws/* left unguarded",
    patches: [['  if (pathname.startsWith("/ws/")) return true;\n', ""]],
    mustFail: ["WS /ws/events: foreign Origin handshake is refused", "WS /ws/tmux/plain: foreign Origin handshake is refused"],
    mustPass: [
      "POST /reply: foreign Origin is 403 with no side effect",
      "WS /ws/events: missing or localhost Origin handshake is accepted",
    ],
  },
  {
    name: "allow-list-guard: guard reverts to a fixed route list",
    patches: [
      [
        '  return method !== "GET" && method !== "HEAD";\n',
        '  return ["/admin/inject", "/permission-answer", "/reply", "/status", "/permission-request", "/sessions"].includes(pathname) || (method === "DELETE" && pathname.startsWith("/sessions/"));\n',
      ],
    ],
    mustFail: ["fails closed: unlisted routes and methods are guarded too"],
    mustPass: ["POST /reply: foreign Origin is 403 with no side effect", "DELETE /sessions/<token>: foreign Origin is 403 with no side effect"],
  },
  {
    name: "reply-accepts-empty-text: /reply mirrors an empty string",
    patches: [['      if (typeof text !== "string" || text.length === 0) {\n', '      if (typeof text !== "string") {\n']],
    mustFail: ["empty text is 400 and mirrors nothing"],
    mustPass: ["missing or non-string text is 400 and mirrors nothing"],
  },
  {
    name: "reply-lookup-without-hasOwn: /reply accepts prototype keys",
    patches: [
      [REPLY_LOOKUP, `${REPLY_LOOKUP_ANCHOR}      const session = registry.sessions[sessionName];\n`],
    ],
    mustFail: ['/reply with sessionName "__proto__" is 404 and mirrors nothing'],
    mustPass: ['/permission-request with sessionName "__proto__" is 404 and broadcasts nothing'],
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
  /** Skipped or todo. Never counted as passed: a skip proves nothing. */
  skipped: string[];
  output: string;
}

/** Copy the router + suite into a temp dir, apply patches, run the suite. */
function runSuite(patches: [string, string][]): SuiteResult {
  const dir = mkdtempSync(path.join(tmpdir(), "omt-router-control-"));
  tempDirs.push(dir);
  for (const entry of COPY) {
    cpSync(path.join(HERE, entry), path.join(dir, entry), { recursive: true });
  }
  const routerPath = path.join(dir, "router.ts");
  let source = readFileSync(routerPath, "utf-8");
  for (const [find, replace] of patches) {
    const n = countOccurrences(source, find);
    if (n !== 1) {
      throw new Error(
        `HARNESS BROKEN: patch matched ${n} times (expected exactly 1): ${JSON.stringify(find.slice(0, 80))}`
      );
    }
    source = source.replace(find, replace);
  }
  writeFileSync(routerPath, source);

  const env = { ...process.env };
  delete env.OMT_HUB_DIR;
  delete env.ROUTER_PORT;
  const report = path.join(dir, "junit.xml");
  const proc = Bun.spawnSync(
    [process.execPath, "test", `./${SUITE}`, "--reporter=junit", `--reporter-outfile=${report}`],
    { cwd: dir, env, stdout: "pipe", stderr: "pipe" }
  );
  const output = proc.stdout.toString() + proc.stderr.toString();
  if (!existsSync(report)) {
    throw new Error(`HARNESS BROKEN: no JUnit report written (exit ${proc.exitCode})\n${output}`);
  }
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

describe("router-vscode removal control", () => {
  let baselineTitles: string[] = [];

  test("baseline: the unmutated copy passes (else HARNESS BROKEN)", () => {
    const r = runSuite([]);
    if (r.exitCode !== 0 || r.failed.length > 0 || r.passed.length === 0) {
      throw new Error(`HARNESS BROKEN: unmutated copy did not pass cleanly (exit ${r.exitCode})\n${r.output}`);
    }
    if (r.skipped.length > 0) {
      throw new Error(`HARNESS BROKEN: skipped/todo tests in ${SUITE} prove nothing: ${JSON.stringify(r.skipped)}`);
    }
    const dupes = r.passed.filter((t, i) => r.passed.indexOf(t) !== i);
    if (dupes.length > 0) {
      throw new Error(`HARNESS BROKEN: duplicate test titles in ${SUITE}: ${JSON.stringify(dupes)}`);
    }
    baselineTitles = r.passed;
  }, 60_000);

  test("every title named by a mutant exists in the suite (else HARNESS BROKEN)", () => {
    expect(baselineTitles.length).toBeGreaterThan(0);
    const missing = MUTANTS.flatMap((m) => [...m.mustFail, ...m.mustPass]).filter((t) => !baselineTitles.includes(t));
    if (missing.length > 0) {
      throw new Error(`HARNESS BROKEN: mutant table names tests that don't exist: ${JSON.stringify(missing)}`);
    }
  });

  for (const m of MUTANTS) {
    test(`mutant caught: ${m.name}`, () => {
      const r = runSuite(m.patches);
      expect(r.exitCode).not.toBe(0);
      for (const title of m.mustFail) {
        expect(r.failed).toContain(title);
      }
      for (const title of m.mustPass) {
        expect(r.passed).toContain(title);
      }
    }, 60_000);
  }
});

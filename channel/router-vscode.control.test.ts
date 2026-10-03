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
const ROUTER_SUITE = "router-vscode.test.ts";
const COPY = [
  "router.ts",
  "dashboard-server.ts",
  "dashboard-pty.ts",
  "adapters",
  ROUTER_SUITE,
  "bridge-tools.ts",
  "bridge-tools.test.ts",
];

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
  /** File the patches apply to (default router.ts). */
  file?: string;
  /** Suite run against the mutated copy (default router-vscode.test.ts). */
  suite?: string;
  /** Apply the mutation. Each [find, replace] must match exactly once. */
  patches: [find: string, replace: string][];
  mustFail: string[];
  mustPass: string[];
}

const TEAM_MIRROR = "      recordAndBroadcastReply(to, `[team ← ${from}] ${text}`, \"team\", []);\n";
const ESCALATE_MIRROR = "      recordAndBroadcastReply(from, `🆘 Escalation — ${reason}\\n\\n${question}`, \"escalate\", []);\n";
const TEAM_INBOUND = "      const inbound = [\n";
const SUPERSEDE_LOOP = `      // One open decision per session: a newer ask supersedes the older one.
      for (const prior of Array.from(pendingDecisions.values())) {
        if (prior.sessionName === sessionName) {
          retireDecision(prior, "superseded").catch(() => {});
        }
      }
`;
const ASK_RECHECK = `      if (
        !Object.hasOwn(registry.sessions, sessionName) ||
        registry.sessions[sessionName].threadId !== session.threadId
      ) {
        return Response.json(
          { error: \`session "\${sessionName}" was removed while the ask was sent\` },
          { status: 410 }
        );
      }
`;
const ASKED_RETURN =`      return Response.json({ status: "asked", token });\n`;
const DELIVERY_STATUS = "      if (!res.ok) error = `bridge responded ${res.status}`;\n";
const FANOUT = `      for (const s of Object.values(registry.sessions)) {
        fetch(\`http://localhost:\${s.bridgePort}/message\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "<ask-answer>", sender: "decision" }),
        }).catch(() => {});
      }
`;
const ESCALATE_LOG = "      process.stderr.write(`omt-router: escalate from ${from}\\n`);\n";
const ESCALATE_LOOKUP = `      if (!Object.hasOwn(registry.sessions, from)) {
        return Response.json(
          { error: \`source session "\${from}" not found\` },
          { status: 404 }`;

const RESOLVE_HEAD = `  pendingDecisions.delete(pd.token);
  broadcastEvent({
    type: "session.ask.resolved",
    name: pd.sessionName,
    token: pd.token,
    choice: answer,
  });
`;
const RESOLVE_BROADCAST = `  broadcastEvent({
    type: "session.ask.resolved",
    name: pd.sessionName,
    token: pd.token,
    choice: answer,
  });
`;
const AFTER_DELIVERY = "  if (error === undefined) {\n    await postToTopic(";
const DELETE_RETIRE = `      for (const pd of Array.from(pendingDecisions.values())) {
        if (pd.sessionName === name) retireDecision(pd, "expired").catch(() => {});
      }
`;
const FRAMED_TEXT = '      const framedText = text.replace(/<(\\/?)(team-message|ask-answer)/gi, "‹$1$2");\n';

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
  // ── Phase 2 (WO-019 plan v2 §6) ──────────────────────────────────────────
  {
    name: "options-max-off-by-one: /ask accepts 5 options",
    patches: [["        options.length > 4 ||\n", "        options.length > 5 ||\n"]],
    mustFail: ["/ask option count: 1 and 5 are 400, 2 and 4 are 200"],
    mustPass: ["/ask posts the text card and broadcasts session.ask"],
  },
  {
    name: "no-session-ask-broadcast: /ask stops mirroring the card",
    patches: [['        type: "session.ask",\n', '        type: "session.ask.disabled",\n']],
    mustFail: ["/ask posts the text card and broadcasts session.ask"],
    mustPass: ["a second answer to the same decision is 410"],
  },
  {
    name: "supersede-after-broadcast: old card cleared after the new card is shown",
    patches: [
      [SUPERSEDE_LOOP, ""],
      [ASKED_RETURN, SUPERSEDE_LOOP.replace("prior.sessionName === sessionName", "prior.sessionName === sessionName && prior.token !== token") + ASKED_RETURN],
    ],
    mustFail: ["supersede: C5(old) is broadcast before C4(new)"],
    mustPass: ["/ask posts the text card and broadcasts session.ask"],
  },
  {
    name: "idx-upper-bound-off-by-one: /ask-answer accepts idx N",
    patches: [["        idx >= pd.options.length\n", "        idx > pd.options.length\n"]],
    mustFail: ['idx bounds: -1, N, 1.5, "1" and null are 400; N-1 answers'],
    mustPass: ["idx 0 answers with the first option"],
  },
  {
    name: "ask-answer-no-410: a closed decision answers 404 instead of 410",
    patches: [[
      '          { error: "decision not found or already closed" },\n          { status: 410 }\n',
      '          { error: "decision not found or already closed" },\n          { status: 404 }\n',
    ]],
    mustFail: ["410 is checked before idx: unknown token with idx 99 is 410", "a second answer to the same decision is 410"],
    mustPass: ["delivers <ask-answer> only to the owning session's bridge"],
  },
  {
    name: "ask-answer-fanout: the answer is also sent to every other bridge",
    patches: [[DELIVERY_STATUS, DELIVERY_STATUS + FANOUT]],
    mustFail: ["delivers <ask-answer> only to the owning session's bridge"],
    mustPass: ["a second answer to the same decision is 410"],
  },
  {
    name: "no-resolved-on-resolve: answered decisions don't clear panel cards",
    patches: [["    choice: answer,\n", '    choice: answer,\n    type: "session.ask.resolved.disabled",\n']],
    mustFail: ["delivers <ask-answer> only to the owning session's bridge", '"1" answers with the first option and is not forwarded'],
    mustPass: ["supersede: C5(old) is broadcast before C4(new)"],
  },
  {
    name: "delivery-failure-swallowed: an undelivered answer reports success",
    patches: [["  if (error === undefined) {\n    await postToTopic(", "  error = undefined;\n  if (error === undefined) {\n    await postToTopic("]],
    mustFail: ["delivery failure: 502, decision closed, warning posted to the topic", "a typed answer that can't be delivered posts a warning"],
    mustPass: ["delivers <ask-answer> only to the owning session's bridge"],
  },
  {
    name: "typed-index-off-by-one: typed N+1 counts as an option",
    patches: [["    if (i < options.length) return options[i];\n", "    if (i <= options.length) return options[i];\n"]],
    mustFail: ['"4" (N+1) dismisses and is forwarded'],
    mustPass: ['"3" (N) answers with the last option'],
  },
  {
    name: "no-resolved-on-retire: retired decisions don't clear panel cards",
    patches: [["    choice: `(${reason})`,\n", '    choice: `(${reason})`,\n    type: "session.ask.resolved.disabled",\n']],
    mustFail: [
      "supersede: C5(old) is broadcast before C4(new)",
      "other text dismisses, is forwarded, and posts a breadcrumb",
      "at TTL-1 the decision stays open; at TTL it expires",
    ],
    mustPass: ["delivers <ask-answer> only to the owning session's bridge"],
  },
  {
    name: "expiry-off-by-one: decisions expire only after TTL, not at TTL",
    patches: [["    if (now - pd.createdAt >= ASK_STALE_EXPIRE_MS) {\n", "    if (now - pd.createdAt > ASK_STALE_EXPIRE_MS) {\n"]],
    mustFail: ["at TTL-1 the decision stays open; at TTL it expires"],
    mustPass: ["supersede: C5(old) is broadcast before C4(new)"],
  },
  {
    name: "team-kind-as-reply: team traffic mirrored as kind reply",
    patches: [[TEAM_MIRROR, TEAM_MIRROR.replace('"team", []', '"reply", []')]],
    mustFail: ["delivers only to the target bridge and mirrors kind team to the recipient"],
    mustPass: ["mirrors kind escalate to the source and posts to its topic"],
  },
  {
    name: "team-delivers-to-sender: team message posted to the sender's own bridge",
    patches: [["fetch(`http://localhost:${toSession.bridgePort}/message`", "fetch(`http://localhost:${fromSession.bridgePort}/message`"]],
    mustFail: ["delivers only to the target bridge and mirrors kind team to the recipient"],
    mustPass: ["mirrors kind escalate to the source and posts to its topic"],
  },
  {
    name: "team-mirror-before-delivery: team mirror fires even when delivery fails",
    patches: [
      [TEAM_MIRROR, ""],
      [TEAM_INBOUND, TEAM_MIRROR + TEAM_INBOUND],
    ],
    mustFail: ["a failed delivery is 502 and mirrors nothing"],
    mustPass: ["delivers only to the target bridge and mirrors kind team to the recipient"],
  },
  {
    name: "escalate-kind-as-reply: escalations mirrored as kind reply",
    patches: [[ESCALATE_MIRROR, ESCALATE_MIRROR.replace('"escalate", []', '"reply", []')]],
    mustFail: ["mirrors kind escalate to the source and posts to its topic", "a platform send failure is 502 and the mirror is kept"],
    mustPass: ["delivers only to the target bridge and mirrors kind team to the recipient"],
  },
  {
    name: "escalate-mirror-after-send: a failed platform send hides the escalation",
    patches: [
      [ESCALATE_MIRROR, ""],
      [ESCALATE_LOG, ESCALATE_MIRROR + ESCALATE_LOG],
    ],
    mustFail: ["a platform send failure is 502 and the mirror is kept"],
    mustPass: ["mirrors kind escalate to the source and posts to its topic"],
  },
  {
    name: "escalate-lookup-without-hasOwn: /escalate accepts prototype keys",
    patches: [[ESCALATE_LOOKUP, ESCALATE_LOOKUP.replace("!Object.hasOwn(registry.sessions, from)", "!registry.sessions[from]")]],
    mustFail: ["404 for an unknown or prototype-key source"],
    mustPass: ["mirrors kind escalate to the source and posts to its topic"],
  },
  {
    name: "resolve-delete-after-await: the decision stays open while the answer is delivered",
    patches: [
      [RESOLVE_HEAD, RESOLVE_BROADCAST],
      [AFTER_DELIVERY, "  pendingDecisions.delete(pd.token);\n" + AFTER_DELIVERY],
    ],
    mustFail: ["two answers at once: exactly one 200, one 410, one delivery"],
    mustPass: ["session.ask.resolved is broadcast before delivery completes"],
  },
  {
    name: "resolve-broadcast-after-await: the card clears only after delivery",
    patches: [
      [RESOLVE_HEAD, "  pendingDecisions.delete(pd.token);\n"],
      [AFTER_DELIVERY, RESOLVE_BROADCAST + AFTER_DELIVERY],
    ],
    mustFail: ["session.ask.resolved is broadcast before delivery completes"],
    mustPass: ["two answers at once: exactly one 200, one 410, one delivery"],
  },
  {
    name: "delete-leaves-decision: removing a session leaves its ask open",
    patches: [[DELETE_RETIRE, ""]],
    mustFail: ["removing a session closes its open ask"],
    mustPass: ["supersede: C5(old) is broadcast before C4(new)"],
  },
  {
    name: "attachments-answer: a captioned photo is taken as an answer",
    patches: [["    const hasAttachments = (message.attachments?.length ?? 0) > 0;\n", "    const hasAttachments = false;\n"]],
    mustFail: ["a message with attachments is never taken as an answer"],
    mustPass: ['"1" answers with the first option and is not forwarded'],
  },
  {
    name: "team-text-not-neutralized: forged framing tags pass through",
    patches: [[FRAMED_TEXT, "      const framedText = text;\n"]],
    mustFail: ["forged framing tags in team text are neutralized; other markup is verbatim"],
    mustPass: ["delivers only to the target bridge and mirrors kind team to the recipient"],
  },
  {
    name: "typed-answer-drops-identity: the typer's id is not passed on",
    patches: [["          senderId: answeredBy.id,\n", '          senderId: "",\n']],
    mustFail: ['"1" answers with the first option and is not forwarded'],
    mustPass: ["delivers <ask-answer> only to the owning session's bridge"],
  },
  // ── Wave 2 challenger gaps ───────────────────────────────────────────────
  {
    name: "ask-no-recheck-after-send: a session removed mid-send still gets its ask",
    patches: [[ASK_RECHECK, ""]],
    mustFail: ["a session removed while its ask card is being sent: 410 and no orphan ask"],
    mustPass: ["removing a session closes its open ask"],
  },
  {
    name: 'inject-allows-decision: /admin/inject forwards sender "decision"',
    patches: [['injectSender === "decision" || ', ""]],
    mustFail: ['400 for the router-only senders "decision" and "team:*"; near misses are delivered'],
    mustPass: ["delivers to the session's bridge and returns queued"],
  },
  {
    name: 'inject-allows-team: /admin/inject forwards "team:*" senders',
    patches: [[' || injectSender.startsWith("team:")', ""]],
    mustFail: ['400 for the router-only senders "decision" and "team:*"; near misses are delivered'],
    mustPass: ["delivers to the session's bridge and returns queued"],
  },
  {
    name: "no-sweep-timer: stale asks are never swept in production",
    patches: [["setInterval(() => sweepStaleDecisions(), 60_000).unref();\n", ""]],
    mustFail: ["the router schedules the expiry sweep every 60s when it boots"],
    mustPass: ["at TTL-1 the decision stays open; at TTL it expires"],
  },
  {
    name: "answeredby-unescaped: the typer's name goes into the attribute raw",
    patches: [["const safeAnsweredBy = attr(answeredBy.name);", "const safeAnsweredBy = answeredBy.name;"]],
    mustFail: ["quotes and newlines in the question and typer name are flattened in the attributes"],
    mustPass: ["quotes in the question become apostrophes in the <ask-answer> attribute"],
  },
  {
    name: "attr-keeps-newlines: newlines survive into the attributes",
    patches: [['.replace(/[\\r\\n]+/g, " ")', ""]],
    mustFail: ["quotes and newlines in the question and typer name are flattened in the attributes"],
    mustPass: ["quotes in the question become apostrophes in the <ask-answer> attribute"],
  },
  {
    name: "typed-fallback-name: a typer with no display name is credited as blank",
    patches: [["name: message.senderName || message.senderId,", "name: message.senderName,"]],
    mustFail: ["a typer with no display name is credited by id"],
    mustPass: ['"1" answers with the first option and is not forwarded'],
  },
  {
    name: "opening-tag-passes: a forged <team-message from=...> passes through",
    patches: [["(team-message|ask-answer)/gi", "(team-message(?!\\s+from)|ask-answer)/gi"]],
    mustFail: ["forged framing tags in team text are neutralized; other markup is verbatim"],
    mustPass: ["delivers only to the target bridge and mirrors kind team to the recipient"],
  },
  // ── bridge-tools.ts ──────────────────────────────────────────────────────
  {
    name: "bt-wrong-route: team_message posts to /team",
    file: "bridge-tools.ts",
    suite: "bridge-tools.test.ts",
    patches: [['postToRouter(ctx, "/team-message", ', 'postToRouter(ctx, "/team", ']],
    mustFail: ["POSTs {from, to, text} to /team-message and reports delivery"],
    mustPass: ["POSTs exactly {sessionName, text} as JSON to /reply and returns sent"],
  },
  {
    name: "bt-drops-sessionName: ask omits the session",
    file: "bridge-tools.ts",
    suite: "bridge-tools.test.ts",
    patches: [['postToRouter(ctx, "/ask", { sessionName: ctx.sessionName, question, options })', 'postToRouter(ctx, "/ask", { question, options })']],
    mustFail: ["POSTs {sessionName, question, options} to /ask and returns the token"],
    mustPass: ["POSTs exactly {sessionName, text} as JSON to /reply and returns sent"],
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

/** Copy the sources + suites into a temp dir, patch `file`, run `suite`. */
function runSuite(file: string, suite: string, patches: [string, string][]): SuiteResult {
  const dir = mkdtempSync(path.join(tmpdir(), "omt-router-control-"));
  tempDirs.push(dir);
  for (const entry of COPY) {
    cpSync(path.join(HERE, entry), path.join(dir, entry), { recursive: true });
  }
  const targetPath = path.join(dir, file);
  let source = readFileSync(targetPath, "utf-8");
  for (const [find, replace] of patches) {
    const n = countOccurrences(source, find);
    if (n !== 1) {
      throw new Error(
        `HARNESS BROKEN: patch on ${file} matched ${n} times (expected exactly 1): ${JSON.stringify(find.slice(0, 80))}`
      );
    }
    source = source.replace(find, replace);
  }
  writeFileSync(targetPath, source);

  const env = { ...process.env };
  delete env.OMT_HUB_DIR;
  delete env.ROUTER_PORT;
  const report = path.join(dir, "junit.xml");
  const proc = Bun.spawnSync(
    [process.execPath, "test", `./${suite}`, "--reporter=junit", `--reporter-outfile=${report}`],
    { cwd: dir, env, stdout: "pipe", stderr: "pipe" }
  );
  const output = proc.stdout.toString() + proc.stderr.toString();
  if (!existsSync(report)) {
    throw new Error(`HARNESS BROKEN: no JUnit report written for ${suite} (exit ${proc.exitCode})\n${output}`);
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

const suiteOf = (m: Mutant) => m.suite ?? ROUTER_SUITE;
const fileOf = (m: Mutant) => m.file ?? "router.ts";
const SUITES = Array.from(new Set(MUTANTS.map(suiteOf)));

describe("router-vscode removal control", () => {
  const baselineTitles = new Map<string, string[]>();

  for (const suite of SUITES) {
    test(`baseline: the unmutated copy of ${suite} passes (else HARNESS BROKEN)`, () => {
      const r = runSuite("router.ts", suite, []);
      if (r.exitCode !== 0 || r.failed.length > 0 || r.passed.length === 0) {
        throw new Error(`HARNESS BROKEN: unmutated ${suite} did not pass cleanly (exit ${r.exitCode})\n${r.output}`);
      }
      if (r.skipped.length > 0) {
        throw new Error(`HARNESS BROKEN: skipped/todo tests in ${suite} prove nothing: ${JSON.stringify(r.skipped)}`);
      }
      const dupes = r.passed.filter((t, i) => r.passed.indexOf(t) !== i);
      if (dupes.length > 0) {
        throw new Error(`HARNESS BROKEN: duplicate test titles in ${suite}: ${JSON.stringify(dupes)}`);
      }
      baselineTitles.set(suite, r.passed);
    }, 60_000);
  }

  test("every title named by a mutant exists in its suite (else HARNESS BROKEN)", () => {
    const missing: string[] = [];
    for (const m of MUTANTS) {
      const titles = baselineTitles.get(suiteOf(m)) ?? [];
      expect(titles.length).toBeGreaterThan(0);
      for (const t of [...m.mustFail, ...m.mustPass]) {
        if (!titles.includes(t)) missing.push(`${suiteOf(m)}: ${t}`);
      }
    }
    if (missing.length > 0) {
      throw new Error(`HARNESS BROKEN: mutant table names tests that don't exist: ${JSON.stringify(missing)}`);
    }
  });

  for (const m of MUTANTS) {
    test(`mutant caught: ${m.name}`, () => {
      const r = runSuite(fileOf(m), suiteOf(m), m.patches);
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

/**
 * Removal control for the sender binding (fork #56): origin.test.ts (O),
 * router-auth.test.ts (R) and bridge-origin.test.ts (B).
 *
 * Each mutant TEXTUALLY patches a temp copy of the sources (every find must
 * match exactly once), runs one suite against the copy in a child `bun test`
 * with a JUnit report, and asserts:
 *   - every row in mustFail fails;
 *   - every other row of that suite passes (mustPass is derived);
 *   - mustFailWith, when given: its text is in the child's stderr segment
 *     for that row, and absent from the copied non-test sources.
 * Rows are named by id; each id resolves to the one title starting "<id> ".
 *
 * "HARNESS BROKEN" means the control isn't measuring anything (a baseline
 * failed, a patch didn't match exactly once, an id doesn't resolve, the SDK
 * didn't resolve from channel/node_modules). Fix the harness or the table;
 * never delete a mutant to go green.
 *
 * The copy gets a symlink to channel/node_modules so the real bridge.ts (B15-
 * B17) loads the pinned SDK offline. The child env drops OMT_HUB_DIR,
 * ROUTER_PORT, ROUTER_URL, BRIDGE_PORT and SESSION_NAME.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = import.meta.dir;
type Suite = "O" | "R" | "B";
const SUITE_FILE: Record<Suite, string> = { O: "origin.test.ts", R: "router-auth.test.ts", B: "bridge-origin.test.ts" };
const COPY = [
  "router.ts",
  "origin.ts",
  "bridge-http.ts",
  "bridge-tools.ts",
  "bridge.ts",
  "dashboard-server.ts",
  "dashboard-pty.ts",
  "adapters",
  "origin.test.ts",
  "router-auth.test.ts",
  "bridge-origin.test.ts",
];
const SOURCES = ["router.ts", "origin.ts", "bridge-http.ts", "bridge-tools.ts", "bridge.ts"];

// Inline stand-in for today's raw router→bridge fetch (localhost, no nonce).
const RAW =
  '((s: SessionEntry, p: string, b: unknown, i: RequestInit = {}) => fetch(`http://localhost:${s.bridgePort}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), ...i }))';
const WRONG = '{ ...session, name: "\\u0000" }';
const WRONG_TO = '{ ...toSession, name: "\\u0000" }';

const C27A_FIND = '  bridgePost(session, "/message", {\n      content: message.text,';
const C27B_FIND = '    bridgePost(session, "/permission-response", { requestId, allow })';
const C27C_FIND =
  '      const res = await bridgePost(session, "/message", {\n          content: `<ask-answer question="${safeQuestion}" answered_by="${safeAnsweredBy}">\\n${answer}\\n</ask-answer>`,';
const C27D_FIND = '        const res = await bridgePost(session, "/message", {\n            content: escapeFraming(injectContent),';
const C27E_FIND = '        const res = await bridgePost(toSession, "/message", {';
const C53_FIND = "if (!r.ok) process.stderr.write(`omt-router: forward to ${session.name} responded ${r.status}\\n`);";

const REPLY_CHECK = '      const origin = await verifyOrigin("/reply", sessionName, session, req, originDeps);\n      if (!origin.ok) return notVerified(sessionName, origin.why);\n';
const ESC_CHECK = '      const origin = await verifyOrigin("/escalate", from, fromSession, req, originDeps);\n      if (!origin.ok) return notVerified(from, origin.why);\n';
const ASK_CHECK = '      const origin = await verifyOrigin("/ask", sessionName, session, req, originDeps);\n      if (!origin.ok) return notVerified(sessionName, origin.why);\n';
const REPLY_MIRROR = '      recordAndBroadcastReply(sessionName, text, "reply", fileList);\n';
const ESC_MIRROR = '      recordAndBroadcastReply(from, `🆘 Escalation — ${reason}\\n\\n${question}`, "escalate", []);\n';
const ASK_SEND = "        await adapter.send(session.threadId, formatAskCard(question, askOptions));\n";
const ALWAYS_OK = "({ ok: true, verified: true } as const)";

interface Mutant {
  name: string;
  suite: Suite;
  file: string;
  patches: [string, string][];
  mustFail: string[];
  mustFailWith?: [string, string];
}

const MUTANTS: Mutant[] = [
  { name: "C1 team-message origin check always ok", suite: "R", file: "router.ts", patches: [['verifyOrigin("/team-message", from, fromSession, req, originDeps)', ALWAYS_OK]], mustFail: ["R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R12b", "R12c", "R12d", "R12e", "R12f", "R25", "R33"] },
  { name: "C2 FAIL-OPEN router: a failed probe becomes legacy", suite: "R", file: "origin.ts", patches: [['return deny("health probe failed");', "return { ok: true, verified: false };"]], mustFail: ["R10", "R11", "R12", "R12b", "R12c"], mustFailWith: ["R10", "Expected: 403"] },
  { name: "C3 legacy despite an auth flag", suite: "R", file: "origin.ts", patches: [['  if (Object.hasOwn(probe.body, "auth")) return deny("new bridge sent no nonce");\n', ""]], mustFail: ["R3", "R12e", "R13", "R14", "R15"] },
  { name: "C4 session mismatch accepted", suite: "R", file: "origin.ts", patches: [['  if (Object.hasOwn(probe.body, "session") && probe.body.session !== name) return deny("health session mismatch");\n', ""]], mustFail: ["R9", "R12d"] },
  { name: "C5 take() keeps the nonce", suite: "O", file: "origin.ts", patches: [["    this.entries.delete(nonce);\n", ""]], mustFail: ["O4", "O6"] },
  { name: "C5r take() keeps the nonce (router rows)", suite: "R", file: "origin.ts", patches: [["    this.entries.delete(nonce);\n", ""]], mustFail: ["R5", "R16a", "R16b", "R16c", "R16d", "R16e", "R18", "R17b"] },
  { name: "C5b take() keeps the nonce (bridge rows)", suite: "B", file: "origin.ts", patches: [["    this.entries.delete(nonce);\n", ""]], mustFail: ["B9"] },
  { name: "C6 TTL <= becomes <", suite: "O", file: "origin.ts", patches: [["  return now - at <= NONCE_TTL_MS;", "  return now - at < NONCE_TTL_MS;"]], mustFail: ["O5", "O14"] },
  { name: "C7 TTL 10001", suite: "O", file: "origin.ts", patches: [["NONCE_TTL_MS = 10000", "NONCE_TTL_MS = 10001"]], mustFail: ["O1", "O5", "O14", "O6"] },
  { name: "C8 TTL 9999", suite: "O", file: "origin.ts", patches: [["NONCE_TTL_MS = 10000", "NONCE_TTL_MS = 9999"]], mustFail: ["O1", "O5", "O14"] },
  { name: "C9 probe timeout 1499", suite: "O", file: "origin.ts", patches: [["PROBE_TIMEOUT_MS = 1500", "PROBE_TIMEOUT_MS = 1499"]], mustFail: ["O1", "O11"] },
  { name: "C10 probe timeout 1501", suite: "O", file: "origin.ts", patches: [["PROBE_TIMEOUT_MS = 1500", "PROBE_TIMEOUT_MS = 1501"]], mustFail: ["O1", "O11"] },
  { name: "C11 NONCE_RE admits 31 and 33", suite: "O", file: "origin.ts", patches: [["/^[0-9a-f]{32}$/", "/^[0-9a-f]{31,33}$/"]], mustFail: ["O3"] },
  { name: "C11r NONCE_RE admits 31 (router rows)", suite: "R", file: "origin.ts", patches: [["/^[0-9a-f]{32}$/", "/^[0-9a-f]{31,33}$/"]], mustFail: ["R6"] },
  { name: "C12 max pending 1023", suite: "O", file: "origin.ts", patches: [["NONCE_MAX_PENDING = 1024", "NONCE_MAX_PENDING = 1023"]], mustFail: ["O1", "O7"] },
  { name: "C13 eviction drops the newest", suite: "O", file: "origin.ts", patches: [["      const oldest = this.entries.keys().next().value as string;", "      const oldest = Array.from(this.entries.keys()).pop() as string;"]], mustFail: ["O7"] },
  { name: "C14 legacy tag unmarked", suite: "R", file: "router.ts", patches: [["' verified=\"no\"'", '""']], mustFail: ["R7", "R8", "R33"] },
  { name: "C15 verified tag gains an attribute", suite: "R", file: "router.ts", patches: [['origin.verified ? "" :', "origin.verified ? ' verified=\"yes\"' :"]], mustFail: ["R2"] },
  { name: "C16 reply origin check always ok", suite: "R", file: "router.ts", patches: [['verifyOrigin("/reply", sessionName, session, req, originDeps)', ALWAYS_OK]], mustFail: ["R13"] },
  { name: "C17 ask origin check always ok", suite: "R", file: "router.ts", patches: [['verifyOrigin("/ask", sessionName, session, req, originDeps)', ALWAYS_OK]], mustFail: ["R14"] },
  { name: "C18 escalate origin check always ok", suite: "R", file: "router.ts", patches: [['verifyOrigin("/escalate", from, fromSession, req, originDeps)', ALWAYS_OK]], mustFail: ["R15"] },
  { name: "C19 verify-origin accepts any session", suite: "R", file: "origin.ts", patches: [["r.body.ok === true && r.body.session === name) return { ok: true, verified: true };", "r.body.ok === true) return { ok: true, verified: true };"]], mustFail: ["R4"] },
  { name: "C20 live-name rule removed", suite: "R", file: "router.ts", patches: [["        if (live && bridgePort !== probedPort) {", "        if (false) {"]], mustFail: ["R19"] },
  { name: "C21 live same-port also refused", suite: "R", file: "router.ts", patches: [["        if (live && bridgePort !== probedPort) {", "        if (live) {"]], mustFail: ["R20"] },
  { name: "C22 a failed probe counts as live", suite: "R", file: "router.ts", patches: [['  if (probe.kind !== "ok" || probe.status !== 200) return false;', '  if (probe.kind !== "ok" || probe.status !== 200) return true;']], mustFail: ["R21", "R23", "R23b", "R27", "R23f", "R26b", "R38"] },
  { name: "C23 any answer counts as live", suite: "R", file: "router.ts", patches: [["  return probe.body.session === name;", "  return true;"]], mustFail: ["R22", "R23c", "R23d"] },
  { name: "C24 inject content unescaped", suite: "R", file: "router.ts", patches: [["            content: escapeFraming(injectContent),", "            content: injectContent,"]], mustFail: ["R24"] },
  { name: "C25 health without auth", suite: "R", file: "router.ts", patches: [["        auth: AUTH_VERSION,\n", ""]], mustFail: ["R1"] },
  { name: "C26 verify-delivery ignores the session", suite: "R", file: "router.ts", patches: [["routerNonces.take(nonce) === session", "routerNonces.take(nonce) !== undefined"]], mustFail: ["R16a", "R16b", "R16c", "R16d", "R16e", "R17", "R18", "R17b"] },
  { name: "C27a platform delivery nonce for the wrong session", suite: "R", file: "router.ts", patches: [[C27A_FIND, C27A_FIND.replace("bridgePost(session,", `bridgePost(${WRONG},`)]], mustFail: ["R16a"] },
  { name: "C27b permission delivery nonce for the wrong session", suite: "R", file: "router.ts", patches: [[C27B_FIND, C27B_FIND.replace("bridgePost(session,", `bridgePost(${WRONG},`)]], mustFail: ["R16b", "R18"] },
  { name: "C27c ask-answer delivery nonce for the wrong session", suite: "R", file: "router.ts", patches: [[C27C_FIND, C27C_FIND.replace("bridgePost(session,", `bridgePost(${WRONG},`)]], mustFail: ["R16c"] },
  { name: "C27d inject delivery nonce for the wrong session", suite: "R", file: "router.ts", patches: [[C27D_FIND, C27D_FIND.replace("bridgePost(session,", `bridgePost(${WRONG},`)]], mustFail: ["R16d"] },
  { name: "C27e team delivery nonce for the wrong session", suite: "R", file: "router.ts", patches: [[C27E_FIND, C27E_FIND.replace("bridgePost(toSession,", `bridgePost(${WRONG_TO},`)]], mustFail: ["R16e"] },
  { name: "C28 loopbackUrl builds localhost", suite: "R", file: "origin.ts", patches: [["return `http://127.0.0.1:${port}${path}`;", "return `http://localhost:${port}${path}`;"]], mustFail: ["R25"] },
  { name: "C28o loopbackUrl builds localhost (origin row)", suite: "O", file: "origin.ts", patches: [["return `http://127.0.0.1:${port}${path}`;", "return `http://localhost:${port}${path}`;"]], mustFail: ["O12"] },
  { name: "C29 /message unverified", suite: "B", file: "bridge-http.ts", patches: [['      if (!(await verifyDelivery(req, vdeps))) return unverified("message");\n', ""]], mustFail: ["B3", "B5", "B5b", "B5c", "B6", "B6b", "B7", "B13"] },
  { name: "C30 FAIL-OPEN bridge: a failed router probe becomes legacy", suite: "B", file: "origin.ts", patches: [['return refuse("router probe failed");', "return true;"]], mustFail: ["B5", "B5b", "B5c"], mustFailWith: ["B5", "Expected: 401"] },
  { name: "C31 bridge legacy despite router auth", suite: "B", file: "origin.ts", patches: [['  if (Object.hasOwn(probe.body, "auth")) return refuse("router expects nonces");\n', ""]], mustFail: ["B3", "B7", "B8"] },
  { name: "C32 /permission-response unverified", suite: "B", file: "bridge-http.ts", patches: [['      if (!(await verifyDelivery(req, vdeps))) return unverified("permission-response");\n', ""]], mustFail: ["B8"] },
  { name: "C33 /verify-origin without take()", suite: "B", file: "bridge-http.ts", patches: [["NONCE_RE.test(nonce) && deps.nonces.take(nonce) === deps.sessionName;", "NONCE_RE.test(nonce);"]], mustFail: ["B10", "B9"] },
  { name: "C34 bridge health without auth", suite: "B", file: "bridge-http.ts", patches: [["session: deps.sessionName, auth: AUTH_VERSION });", "session: deps.sessionName });"]], mustFail: ["B1"] },
  { name: "C35 tool calls carry no nonce", suite: "B", file: "bridge-tools.ts", patches: [["  if (ctx.nonces) headers[NONCE_HEADER] = ctx.nonces.issue(ctx.sessionName);\n", ""]], mustFail: ["B9", "B11"] },
  { name: "C36 escapeFraming loses ask-answer", suite: "O", file: "origin.ts", patches: [["/<(\\/?)(team-message|ask-answer)/gi", "/<(\\/?)(team-message)/gi"]], mustFail: ["O8"] },
  { name: "C37 escapeFraming escapes every <", suite: "O", file: "origin.ts", patches: [['return text.replace(/<(\\/?)(team-message|ask-answer)/gi, "‹$1$2");', 'return text.replace(/</g, "‹");']], mustFail: ["O9"] },
  { name: "C37r escapeFraming escapes every < (router rows)", suite: "R", file: "origin.ts", patches: [['return text.replace(/<(\\/?)(team-message|ask-answer)/gi, "‹$1$2");', 'return text.replace(/</g, "‹");']], mustFail: ["R24"] },
  { name: "C38 routerLoopback keeps localhost", suite: "O", file: "origin.ts", patches: [['return `http://127.0.0.1:${u.port || "80"}`;', "return url;"]], mustFail: ["O13"] },
  { name: "C38b routerLoopback keeps localhost (bridge rows)", suite: "B", file: "origin.ts", patches: [['return `http://127.0.0.1:${u.port || "80"}`;', "return url;"]], mustFail: ["B13", "B17"] },
  { name: "C38v verifyDelivery builds its own localhost URL", suite: "B", file: "origin.ts", patches: [["`${deps.routerUrl}/verify-delivery`", '`${deps.routerUrl.replace("127.0.0.1", "localhost")}/verify-delivery`']], mustFail: ["B13"] },
  { name: "C39 DELETE writes no tombstone", suite: "R", file: "router.ts", patches: [["      rememberTombstone(name, session.bridgePort);\n", ""]], mustFail: ["R26", "R26c", "R35", "R23e", "R25", "R26b", "R26d", "R38"] },
  { name: "C40 tombstone not checked", suite: "R", file: "router.ts", patches: [["      if (!existing && tombstones.has(name)) {", "      if (false) {"]], mustFail: ["R26", "R26b", "R26c", "R26d", "R25"] },
  { name: "C41 isHub for any name", suite: "R", file: "router.ts", patches: [['      if (isHub && name === "hub") {', "      if (isHub) {"]], mustFail: ["R29"] },
  { name: "C42 name rule removed", suite: "R", file: "router.ts", patches: [["      if (!validName(name)) {", "      if (false) {"]], mustFail: ["R31i", "R32"] },
  { name: "C43 NAME_RE allows 65", suite: "O", file: "origin.ts", patches: [["[A-Za-z0-9._-]{0,63}$/", "[A-Za-z0-9._-]{0,64}$/"]], mustFail: ["O17"] },
  { name: "C44 registry lookup without hasOwn", suite: "R", file: "router.ts", patches: [["      const existing = Object.hasOwn(registry.sessions, name) ? registry.sessions[name] : undefined;", "      const existing = registry.sessions[name];"]], mustFail: ["R31ii"] },
  { name: "C45 name not escaped in the frame", suite: "R", file: "router.ts", patches: [["      const fromAttr = escapeName(from);", "      const fromAttr = from;"]], mustFail: ["R33"] },
  { name: "C46 port rule removed", suite: "R", file: "router.ts", patches: [["      if (!validPort(bridgePort, ROUTER_PORT)) {", "      if (false) {"]], mustFail: ["R34"] },
  { name: "C47 body cap removed", suite: "O", file: "origin.ts", patches: [['    if (total > BODY_CAP_BYTES) { await reader.cancel().catch(() => {}); return "cap"; }\n', ""]], mustFail: ["O16", "O16b", "O16c"] },
  { name: "C48 redirects followed", suite: "O", file: "origin.ts", patches: [['redirect: "manual", ', ""]], mustFail: ["O10"] },
  { name: "C49 no abort on timeout", suite: "O", file: "origin.ts", patches: [['if (winner === "timeout") { controller.abort(); return', 'if (winner === "timeout") { return']], mustFail: ["O15"] },
  { name: "C49b body read outside the race", suite: "O", file: "origin.ts", patches: [["    return readResult(res);\n  })()", '    return { kind: "ok", status: res.status, body: {}, res } as unknown as BoundedResult;\n  })()'], ["  return winner;\n}", '  return "res" in winner ? readResult((winner as unknown as { res: Response }).res) : winner;\n}']], mustFail: ["O15"] },
  { name: "C50 inject sender rule removed", suite: "R", file: "router.ts", patches: [['      if (injectSender.toLowerCase() === "hub" || Object.hasOwn(registry.sessions, injectSender)) {', "      if (false) {"]], mustFail: ["R24b"] },
  { name: "C51 re-read after the probe removed", suite: "R", file: "router.ts", patches: [["        if (current !== existing || current.bridgePort !== probedPort) {", "        if (false) {"]], mustFail: ["R23e", "R23f"] },
  { name: "C52 same-port re-register overwrites path", suite: "R", file: "router.ts", patches: [["        if (!live) existing.path = path;", "        existing.path = path;"]], mustFail: ["R20"] },
  { name: "C53 platform forward refusal not logged", suite: "R", file: "router.ts", patches: [[C53_FIND, ""]], mustFail: ["R18b"] },
  { name: "C54 issue keeps expired entries", suite: "O", file: "origin.ts", patches: [["    for (const [k, e] of this.entries) if (!isFresh(e.at, t)) this.entries.delete(k);\n", ""]], mustFail: ["O14"] },
  { name: "C55 bridge ignores stdin end", suite: "B", file: "bridge.ts", patches: [['process.stdin.on("end", () => process.exit(0));\nprocess.stdin.on("close", () => process.exit(0));\n', ""]], mustFail: ["B15"] },
  { name: "C56 hub case variants allowed", suite: "O", file: "origin.ts", patches: [[' && (s.toLowerCase() !== "hub" || s === "hub")', ""]], mustFail: ["O17"] },
  { name: "C57 tombstones never evicted", suite: "R", file: "router.ts", patches: [["  while (tombstones.size >= TOMBSTONE_MAX) tombstones.delete(tombstones.keys().next().value as string);\n", ""]], mustFail: ["R35"] },
  { name: "C58 tombstone max 1023", suite: "O", file: "origin.ts", patches: [["TOMBSTONE_MAX = 1024", "TOMBSTONE_MAX = 1023"]], mustFail: ["O1"] },
  { name: "C58r tombstone max 1023 (router rows)", suite: "R", file: "origin.ts", patches: [["TOMBSTONE_MAX = 1024", "TOMBSTONE_MAX = 1023"]], mustFail: ["R35"] },
  { name: "C59 the changed-409 writes a tombstone", suite: "R", file: "router.ts", patches: [["          return Response.json({ error: `session \"${name}\" changed during registration` }, { status: 409 });", "          rememberTombstone(name, existing.bridgePort);\n          return Response.json({ error: `session \"${name}\" changed during registration` }, { status: 409 });"]], mustFail: ["R23f"] },
  { name: "C60 pending not held across the tombstone probe", suite: "R", file: "router.ts", patches: [["        pendingRegistrations.add(name);\n        heldPending = true;\n", ""]], mustFail: ["R26b"] },
  { name: "C61 tombstone dropped before commit", suite: "R", file: "router.ts", patches: [["      if (!heldPending) {", "      tombstones.delete(name);\n      if (!heldPending) {"]], mustFail: ["R26c"] },
  { name: "C62 DELETE lookup without hasOwn", suite: "R", file: "router.ts", patches: [["      const session = Object.hasOwn(registry.sessions, name) ? registry.sessions[name] : undefined;", "      const session = registry.sessions[name];"]], mustFail: ["R36"] },
  { name: "C63 body cap counts chars", suite: "O", file: "origin.ts", patches: [["    total += value.byteLength;", "    total += new TextDecoder().decode(value).length;"]], mustFail: ["O16b"] },
  { name: "C27a' platform delivery reverted to the raw fetch", suite: "R", file: "router.ts", patches: [[C27A_FIND, C27A_FIND.replace("bridgePost(", `${RAW}(`)], [C53_FIND, ""]], mustFail: ["R16a", "R18b", "R25"] },
  { name: "C27b' permission delivery reverted to the raw fetch", suite: "R", file: "router.ts", patches: [[C27B_FIND, C27B_FIND.replace("bridgePost(", `${RAW}(`)]], mustFail: ["R16b", "R18", "R25"] },
  { name: "C27c' ask-answer delivery reverted to the raw fetch", suite: "R", file: "router.ts", patches: [[C27C_FIND, C27C_FIND.replace("bridgePost(", `${RAW}(`)]], mustFail: ["R16c", "R25"] },
  { name: "C27d' inject delivery reverted to the raw fetch", suite: "R", file: "router.ts", patches: [[C27D_FIND, C27D_FIND.replace("bridgePost(", `${RAW}(`)]], mustFail: ["R16d", "R25", "R17", "R17b"] },
  { name: "C27e' team delivery reverted to the raw fetch", suite: "R", file: "router.ts", patches: [[C27E_FIND, C27E_FIND.replace("bridgePost(", `${RAW}(`)]], mustFail: ["R16e", "R25"] },
  { name: "C64 tombstone 409 keeps the name pending", suite: "R", file: "router.ts", patches: [["          pendingRegistrations.delete(name);\n          process.stderr.write(`omt-router: refused registration of", "          process.stderr.write(`omt-router: refused registration of"]], mustFail: ["R26d"] },
  { name: "C65 reply check below the mirror", suite: "R", file: "router.ts", patches: [[REPLY_CHECK, ""], [REPLY_MIRROR, REPLY_MIRROR + REPLY_CHECK]], mustFail: ["R13"] },
  { name: "C66 escalate check below the mirror", suite: "R", file: "router.ts", patches: [[ESC_CHECK, ""], [ESC_MIRROR, ESC_MIRROR + ESC_CHECK]], mustFail: ["R15"] },
  { name: "C67 ask check below the card", suite: "R", file: "router.ts", patches: [[ASK_CHECK, ""], [ASK_SEND, ASK_SEND + ASK_CHECK.replace(/^ {6}/gm, "        ")]], mustFail: ["R14"] },
  { name: "C68 legacy probe to localhost", suite: "R", file: "origin.ts", patches: [['probeHealth(loopbackUrl(entry.bridgePort, ""), deps)', "probeHealth(`http://localhost:${entry.bridgePort}`, deps)"]], mustFail: ["R25"] },
  { name: "C69 holder probe to localhost", suite: "R", file: "router.ts", patches: [['probeHealth(loopbackUrl(port, ""), originDeps)', "probeHealth(`http://localhost:${port}`, originDeps)"]], mustFail: ["R25"] },
  { name: "C70 bridge talks to ROUTER_URL as given", suite: "B", file: "bridge.ts", patches: [["const ROUTER = routerLoopback(ROUTER_URL);", "const ROUTER = ROUTER_URL;"]], mustFail: ["B17"] },
  { name: "C72 no re-check after the thread reopen", suite: "R", file: "router.ts", patches: [["        if (afterReopen !== existing || afterReopen.bridgePort !== probedPort) {", "        if (false) {"]], mustFail: ["R38"] },
  { name: "C73 verifyDelivery accepts any bounded answer", suite: "B", file: "origin.ts", patches: [['    if (r.kind === "ok" && r.status === 200 && r.body.ok === true) return true;', '    if (r.kind === "ok") return true;']], mustFail: ["B6"] },
  { name: "C74 verifyOrigin ignores status and ok", suite: "R", file: "origin.ts", patches: [['if (r.kind === "ok" && r.status === 200 && r.body.ok === true && r.body.session === name)', 'if (r.kind === "ok" && r.body.session === name)']], mustFail: ["R4"] },
  { name: "C71 live-name refusal not logged", suite: "R", file: "router.ts", patches: [['          process.stderr.write(`omt-router: refused re-register of "${name}": live on port ${probedPort}\\n`);\n', ""]], mustFail: ["R19"] },
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
  stderr: string;
  output: string;
}

function makeCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "omt-team-auth-control-"));
  tempDirs.push(dir);
  for (const entry of COPY) cpSync(path.join(HERE, entry), path.join(dir, entry), { recursive: true });
  symlinkSync(realpathSync(path.join(HERE, "node_modules")), path.join(dir, "node_modules"));
  return dir;
}

/** Copy the sources and suites, patch `file`, run the suite. */
function runSuite(suite: Suite, file: string, patches: [string, string][]): SuiteResult & { dir: string } {
  const dir = makeCopy();
  if (patches.length > 0) {
    const target = path.join(dir, file);
    let source = readFileSync(target, "utf-8");
    for (const [find, replace] of patches) {
      const n = countOccurrences(source, find);
      if (n !== 1) {
        throw new Error(`HARNESS BROKEN: patch on ${file} matched ${n} times (expected exactly 1): ${JSON.stringify(find.slice(0, 100))}`);
      }
      source = source.replace(find, () => replace);
    }
    writeFileSync(target, source);
  }
  const env = { ...process.env };
  for (const k of ["OMT_HUB_DIR", "ROUTER_PORT", "ROUTER_URL", "BRIDGE_PORT", "SESSION_NAME"]) delete env[k];
  const report = path.join(dir, "junit.xml");
  const proc = Bun.spawnSync([process.execPath, "test", `./${SUITE_FILE[suite]}`, "--reporter=junit", `--reporter-outfile=${report}`], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = proc.stderr.toString();
  const output = proc.stdout.toString() + stderr;
  if (!existsSync(report)) {
    throw new Error(`HARNESS BROKEN: no JUnit report written for ${SUITE_FILE[suite]} (exit ${proc.exitCode})\n${output}`);
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
  return { exitCode: proc.exitCode ?? -1, passed, failed, skipped, stderr, output, dir };
}

/** stderr from just after the previous `(fail)` line (or the start) to the `(fail) … <title>` line. */
function failSegment(stderr: string, title: string): string | undefined {
  const lines = stderr.split("\n");
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("(fail)")) continue;
    if (lines[i].includes(title)) return lines.slice(start, i + 1).join("\n");
    start = i + 1;
  }
  return undefined;
}

const SUITES: Suite[] = ["O", "R", "B"];
const titles = new Map<Suite, string[]>();

function titleOf(suite: Suite, id: string): string {
  const all = titles.get(suite) ?? [];
  const hits = all.filter((t) => t.startsWith(`${id} `));
  if (hits.length !== 1) throw new Error(`HARNESS BROKEN: id ${id} resolves to ${hits.length} titles in ${SUITE_FILE[suite]}`);
  return hits[0];
}

describe("team-auth removal control", () => {
  for (const suite of SUITES) {
    test(`baseline: the unmutated copy of ${SUITE_FILE[suite]} passes (else HARNESS BROKEN)`, () => {
      const r = runSuite(suite, "", []);
      if (r.exitCode !== 0 || r.failed.length > 0 || r.passed.length === 0) {
        throw new Error(`HARNESS BROKEN: unmutated ${SUITE_FILE[suite]} did not pass cleanly (exit ${r.exitCode})\n${r.output}`);
      }
      if (r.skipped.length > 0) throw new Error(`HARNESS BROKEN: skipped/todo tests prove nothing: ${JSON.stringify(r.skipped)}`);
      const dupes = r.passed.filter((t, i) => r.passed.indexOf(t) !== i);
      if (dupes.length > 0) throw new Error(`HARNESS BROKEN: duplicate titles: ${JSON.stringify(dupes)}`);
      if (suite === "B") {
        const nm = realpathSync(path.join(HERE, "node_modules"));
        for (const spec of ["@modelcontextprotocol/sdk/server/index.js", "zod"]) {
          const resolved = Bun.resolveSync(spec, r.dir);
          if (!resolved.startsWith(nm)) throw new Error(`HARNESS BROKEN: ${spec} resolved to ${resolved}, not under ${nm}`);
        }
      }
      titles.set(suite, r.passed);
    }, 120_000);
  }

  test("every id named by a mutant resolves to exactly one title in its suite, and every mustFailWith text is absent from the copied sources (else HARNESS BROKEN)", () => {
    const sources = SOURCES.map((f) => readFileSync(path.join(HERE, f), "utf-8")).join("\n");
    for (const m of MUTANTS) {
      expect((titles.get(m.suite) ?? []).length).toBeGreaterThan(0);
      for (const id of m.mustFail) titleOf(m.suite, id);
      if (m.mustFailWith) {
        const [id, text] = m.mustFailWith;
        if (!m.mustFail.includes(id)) throw new Error(`HARNESS BROKEN: ${m.name}: mustFailWith row ${id} is not in mustFail`);
        if (sources.includes(text)) throw new Error(`HARNESS BROKEN: ${m.name}: mustFailWith text ${JSON.stringify(text)} occurs in the sources`);
      }
    }
  });

  for (const m of MUTANTS) {
    test(`mutant caught: ${m.name}`, () => {
      const r = runSuite(m.suite, m.file, m.patches);
      const mustFail = m.mustFail.map((id) => titleOf(m.suite, id));
      expect(r.exitCode).not.toBe(0);
      expect(r.failed.filter((t) => mustFail.includes(t)).sort()).toEqual([...mustFail].sort());
      const unexpected = (titles.get(m.suite) ?? []).filter((t) => !mustFail.includes(t) && !r.passed.includes(t));
      expect(unexpected).toEqual([]);
      if (m.mustFailWith) {
        const [id, text] = m.mustFailWith;
        const seg = failSegment(r.stderr, titleOf(m.suite, id));
        expect(seg ?? "").toContain(text);
      }
    }, 120_000);
  }
});

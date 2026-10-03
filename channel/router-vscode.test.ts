/**
 * Router surface used by the VS Code extension (omt-vscode-ext), WO-018 Phase 1.
 *
 * Boots the REAL router.ts in-process. The only substitution is the Telegram
 * adapter, swapped for a no-network fake via mock.module; the only thing
 * router.ts exports for tests is REPLY_LOG_CAP. OMT_HUB_DIR is a fresh temp dir and the router
 * listens on a free port (never 8800). A fake bridge records what the router
 * forwards to it, and a real WebSocket client listens on /ws/events.
 *
 * Fast path: `bun test router-vscode.test.ts` (~3s) runs just this suite.
 * The full `bun test` (~34s) also runs the removal control below.
 *
 * router-vscode.control.test.ts re-runs this file against mutated copies of
 * router.ts and asserts specific tests below FAIL. If you rename a test that
 * a mutant names, update the mutant table there too. Test titles must stay
 * unique across this file: the control identifies tests by title.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── Helpers ────────────────────────────────────────────────────────────────

/** The port a server is bound to (always set for a TCP listener). */
function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("server has no TCP port");
  return server.port;
}

/** A port nothing is listening on right now. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = portOf(probe);
  probe.stop(true);
  return port;
}

type Json = Record<string, unknown>;

// ── Fake bridge ────────────────────────────────────────────────────────────

const bridgeHits: { path: string; body: Json }[] = [];
let bridgeStatus = 200;
const bridge = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    bridgeHits.push({ path: url.pathname, body: (await req.json()) as Json });
    return Response.json({ status: "ok" }, { status: bridgeStatus });
  },
});
const BRIDGE_PORT = portOf(bridge);

// ── Fake platform adapter ──────────────────────────────────────────────────

const fake = {
  botCommands: undefined as undefined | { command: string; description: string }[],
  sendFails: false,
  promptFails: false,
  sent: [] as { threadId: string; text: string }[],
  permissionCallback: null as null | ((requestId: string, allow: boolean) => void),
};

const HERE = import.meta.dir;
mock.module(path.join(HERE, "adapters", "telegram"), () => ({
  TelegramAdapter: class {
    readonly name = "telegram";
    get botCommands() {
      return fake.botCommands;
    }
    async connect() {}
    async disconnect() {}
    async createThread(sessionName: string) {
      return { threadId: `thread-${sessionName}`, displayName: sessionName };
    }
    async closeThread() {}
    async send(threadId: string, text: string) {
      if (fake.sendFails) throw new Error("platform send failed");
      fake.sent.push({ threadId, text });
    }
    async sendPermissionPrompt() {
      if (fake.promptFails) throw new Error("platform prompt failed");
    }
    onMessage() {}
    onPermissionResponse(cb: (requestId: string, allow: boolean) => void) {
      fake.permissionCallback = cb;
    }
    getHubThreadId() {
      return null;
    }
  },
}));

// ── Boot the router ────────────────────────────────────────────────────────

const DEAD_PORT = freePort();
const hubDir = mkdtempSync(path.join(tmpdir(), "omt-router-vscode-test-"));
function seed(name: string, bridgePort: number, extra: Json = {}) {
  return {
    name,
    path: `/tmp/${name}`,
    bridgePort,
    threadId: `thread-${name}`,
    threadDisplayName: `Display ${name}`,
    startedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}
writeFileSync(
  path.join(hubDir, "hub-config.json"),
  JSON.stringify({ platform: "telegram", credentials: {} })
);
writeFileSync(
  path.join(hubDir, "hub-registry.json"),
  JSON.stringify({
    sessions: {
      modeled: seed("modeled", BRIDGE_PORT, { model: "claude-opus-5-5" }),
      plain: seed("plain", BRIDGE_PORT),
      dead: seed("dead", DEAD_PORT),
    },
  })
);

const ROUTER_PORT = freePort();
process.env.OMT_HUB_DIR = hubDir;
process.env.ROUTER_PORT = String(ROUTER_PORT);
const BASE = `http://127.0.0.1:${ROUTER_PORT}`;

const { REPLY_LOG_CAP } = (await import("./router")) as { REPLY_LOG_CAP: number };

// ── /ws/events listener ────────────────────────────────────────────────────

const events: Json[] = [];
const ws = new WebSocket(`ws://127.0.0.1:${ROUTER_PORT}/ws/events`);
ws.onmessage = (m) => events.push(JSON.parse(String(m.data)) as Json);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("ws/events connect failed"));
});

/** Resolve with the first event at index >= from that matches. */
async function waitForEvent(
  from: number,
  match: (e: Json) => boolean,
  timeoutMs = 2000
): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = events.slice(from).find(match);
    if (hit) return hit;
    await Bun.sleep(5);
  }
  throw new Error(`no matching event within ${timeoutMs}ms`);
}

/** Wait long enough for a stray event to arrive, then return what came. */
async function eventsAfter(from: number, settleMs = 150): Promise<Json[]> {
  await Bun.sleep(settleMs);
  return events.slice(from);
}

async function waitForBridgeHit(
  from: number,
  match: (h: { path: string; body: Json }) => boolean,
  timeoutMs = 2000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = bridgeHits.slice(from).find(match);
    if (hit) return hit;
    await Bun.sleep(5);
  }
  throw new Error(`no matching bridge request within ${timeoutMs}ms`);
}

function post(route: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function register(name: string, bridgePort = BRIDGE_PORT) {
  const res = await post("/sessions", { name, path: `/tmp/${name}`, bridgePort });
  expect(res.status).toBeLessThan(300);
}

function reply(sessionName: string, text: string, files?: unknown) {
  return post("/reply", files === undefined ? { sessionName, text } : { sessionName, text, files });
}

async function history(session: string, since?: string) {
  const q = since === undefined ? "" : `&since=${since}`;
  const res = await fetch(`${BASE}/history?session=${encodeURIComponent(session)}${q}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { events: Json[]; latest: number };
}

afterAll(() => {
  ws.close();
  bridge.stop(true);
  rmSync(hubDir, { recursive: true, force: true });
});

// ── C1 / D1 / D2: session.reply mirror + reply log ─────────────────────────

describe("C1/D2 /reply mirror", () => {
  test("broadcasts session.reply with every field and kind reply", async () => {
    await register("mirror-fields");
    const mark = events.length;
    const res = await reply("mirror-fields", "hello panel");
    expect(res.status).toBe(200);
    const e = await waitForEvent(mark, (x) => x.type === "session.reply" && x.name === "mirror-fields");
    expect(e).toEqual({
      type: "session.reply",
      name: "mirror-fields",
      text: "hello panel",
      kind: "reply",
      files: [],
      ts: expect.any(String),
      seq: 1,
    });
    expect(Number.isNaN(Date.parse(e.ts as string))).toBe(false);
    expect(fake.sent).toContainEqual({ threadId: "thread-mirror-fields", text: "hello panel" });
  });

  test("keeps only non-empty string file names", async () => {
    await register("mirror-files");
    const mark = events.length;
    await reply("mirror-files", "see attached", ["a.png", 3, "", "b.pdf"]);
    const e = await waitForEvent(mark, (x) => x.type === "session.reply" && x.name === "mirror-files");
    expect(e.files).toEqual(["a.png", "b.pdf"]);
  });

  test("mirror survives a platform send failure", async () => {
    await register("mirror-sendfail");
    const mark = events.length;
    fake.sendFails = true;
    let res: Response;
    try {
      res = await reply("mirror-sendfail", "platform is down");
    } finally {
      fake.sendFails = false;
    }
    expect(res.status).toBe(500);
    const e = await waitForEvent(mark, (x) => x.type === "session.reply" && x.name === "mirror-sendfail");
    expect(e.text).toBe("platform is down");
    const h = await history("mirror-sendfail", "0");
    expect(h.events.map((x) => x.text)).toEqual(["platform is down"]);
  });

  test("empty text is 400 and mirrors nothing", async () => {
    await register("mirror-badtext");
    const mark = events.length;
    const res = await reply("mirror-badtext", "");
    expect(res.status).toBe(400);
    expect((await eventsAfter(mark)).filter((x) => x.type === "session.reply")).toEqual([]);
    expect(await history("mirror-badtext", "0")).toEqual({ events: [], latest: 0 });
  });

  test("missing or non-string text is 400 and mirrors nothing", async () => {
    await register("mirror-nontext");
    const mark = events.length;
    for (const body of [{ sessionName: "mirror-nontext" }, { sessionName: "mirror-nontext", text: { a: 1 } }, { sessionName: "mirror-nontext", text: 7 }]) {
      const res = await post("/reply", body);
      expect(res.status).toBe(400);
    }
    expect((await eventsAfter(mark)).filter((x) => x.type === "session.reply")).toEqual([]);
    expect(await history("mirror-nontext", "0")).toEqual({ events: [], latest: 0 });
    expect(fake.sent.filter((m) => m.threadId === "thread-mirror-nontext")).toEqual([]);
  });

  test("unknown session is 404 and mirrors nothing", async () => {
    const mark = events.length;
    const res = await reply("no-such-session", "lost");
    expect(res.status).toBe(404);
    const after = await eventsAfter(mark);
    expect(after.filter((x) => x.type === "session.reply")).toEqual([]);
  });
});

describe("D1 reply log seq", () => {
  test("seq starts at 1 and increases per session, independently", async () => {
    await register("seq-a");
    await register("seq-b");
    await reply("seq-a", "a1");
    await reply("seq-a", "a2");
    await reply("seq-b", "b1");
    await reply("seq-a", "a3");
    const a = await history("seq-a", "0");
    const b = await history("seq-b", "0");
    expect(a.events.map((x) => [x.seq, x.text])).toEqual([[1, "a1"], [2, "a2"], [3, "a3"]]);
    expect(b.events.map((x) => [x.seq, x.text])).toEqual([[1, "b1"]]);
  });

  test("REPLY_LOG_CAP is exported and is the spec's 200", () => {
    // Pinned: the inventory (D1) specifies 200. The CAP/CAP+1 tests below
    // read the export, so they follow the constant; this line catches drift.
    expect(REPLY_LOG_CAP).toBe(200);
  });

  test("at exactly CAP replies the log keeps all of them", async () => {
    await register("cap-exact");
    for (let i = 1; i <= REPLY_LOG_CAP; i++) await reply("cap-exact", `m${i}`);
    const h = await history("cap-exact", "0");
    expect(h.events.length).toBe(REPLY_LOG_CAP);
    expect(h.events[0].seq).toBe(1);
    expect(h.latest).toBe(REPLY_LOG_CAP);
  });

  test("at CAP+1 replies the oldest is dropped and seq keeps counting", async () => {
    await register("cap-plus-one");
    for (let i = 1; i <= REPLY_LOG_CAP + 1; i++) await reply("cap-plus-one", `m${i}`);
    const h = await history("cap-plus-one", "0");
    expect(h.events.length).toBe(REPLY_LOG_CAP);
    expect(h.events[0].seq).toBe(2);
    expect(h.events[0].text).toBe("m2");
    expect(h.latest).toBe(REPLY_LOG_CAP + 1);
    await reply("cap-plus-one", "next");
    expect((await history("cap-plus-one", String(REPLY_LOG_CAP + 1))).events.map((x) => x.seq)).toEqual([
      REPLY_LOG_CAP + 2,
    ]);
  });
});

// ── B2: GET /history ───────────────────────────────────────────────────────

describe("B2 GET /history", () => {
  beforeAll(async () => {
    await register("hist");
    for (const t of ["h1", "h2", "h3"]) await reply("hist", t);
  });

  test("returns only events with seq > since, plus latest", async () => {
    const h = await history("hist", "1");
    expect(h.events.map((x) => x.seq)).toEqual([2, 3]);
    expect(h.latest).toBe(3);
    expect(h.events[0]).toMatchObject({ type: "session.reply", name: "hist", kind: "reply" });
  });

  test("since at or past latest returns no events but the real latest", async () => {
    const h = await history("hist", "3");
    expect(h).toEqual({ events: [], latest: 3 });
  });

  test("unknown session returns empty with latest 0", async () => {
    expect(await history("never-replied", "0")).toEqual({ events: [], latest: 0 });
  });

  test("missing or non-numeric since counts as 0", async () => {
    expect((await history("hist")).events.length).toBe(3);
    expect((await history("hist", "abc")).events.length).toBe(3);
  });
});

// ── B3 / D9: GET /commands ─────────────────────────────────────────────────

describe("B3/D9 GET /commands", () => {
  test("adapter without botCommands serves an empty list", async () => {
    fake.botCommands = undefined;
    const res = await fetch(`${BASE}/commands`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commands: [] });
  });

  test("adapter botCommands are served as-is", async () => {
    fake.botCommands = [{ command: "status", description: "Show status" }];
    try {
      const res = await fetch(`${BASE}/commands`);
      expect(await res.json()).toEqual({ commands: [{ command: "status", description: "Show status" }] });
    } finally {
      fake.botCommands = undefined;
    }
  });
});

// ── B4: POST /admin/inject ─────────────────────────────────────────────────

describe("B4 POST /admin/inject", () => {
  test("delivers to the session's bridge and returns queued", async () => {
    const mark = bridgeHits.length;
    const res = await post("/admin/inject", { session: "plain", content: "ping", sender: "vscode" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "queued" });
    const hit = await waitForBridgeHit(mark, (h) => h.path === "/message" && h.body.content === "ping");
    expect(hit.body).toEqual({
      content: "ping",
      sender: "vscode",
      senderId: "",
      messageId: expect.stringMatching(/^inject-\d+-\d+$/),
      timestamp: expect.any(String),
    });
  });

  test("defaults sender to omt-heartbeat when omitted", async () => {
    const mark = bridgeHits.length;
    await post("/admin/inject", { session: "plain", content: "tick" });
    const hit = await waitForBridgeHit(mark, (h) => h.path === "/message" && h.body.content === "tick");
    expect(hit.body.sender).toBe("omt-heartbeat");
  });

  test("400 when session or content is missing, or the body isn't JSON", async () => {
    expect((await post("/admin/inject", { content: "x" })).status).toBe(400);
    expect((await post("/admin/inject", { session: "plain" })).status).toBe(400);
    expect((await post("/admin/inject", { session: "plain", content: "" })).status).toBe(400);
    expect((await post("/admin/inject", "not json")).status).toBe(400);
    expect((await post("/admin/inject", "null")).status).toBe(400);
  });

  test("404 for an unknown session, including prototype keys", async () => {
    expect((await post("/admin/inject", { session: "ghost", content: "x" })).status).toBe(404);
    expect((await post("/admin/inject", { session: "__proto__", content: "x" })).status).toBe(404);
    expect((await post("/admin/inject", { session: "constructor", content: "x" })).status).toBe(404);
  });

  test("502 when the bridge is unreachable", async () => {
    const res = await post("/admin/inject", { session: "dead", content: "x", sender: "vscode" });
    expect(res.status).toBe(502);
  });

  test("502 when the bridge answers non-2xx", async () => {
    bridgeStatus = 500;
    try {
      const res = await post("/admin/inject", { session: "plain", content: "x", sender: "vscode" });
      expect(res.status).toBe(502);
    } finally {
      bridgeStatus = 200;
    }
  });
});

// ── Origin guard (beyond inventory: security) ──────────────────────────────
//
// One guard, applied before routing, to every /ws/* stream and every method
// other than GET/HEAD, so new write routes are covered by default. The table
// lists today's write routes; testing a new one is one row.

const FOREIGN_ORIGINS = [
  "https://evil.example",
  "null",
  "http://localhost.evil.example:8800",
  "vscode-webview://abc",
];
const LOCAL_ORIGINS: (string | undefined)[] = [
  undefined,
  "http://localhost:5173",
  "http://127.0.0.1:8800",
];

/** Today's write routes. `body(token)` must carry `token` somewhere so a
 *  leaked side effect (event, bridge call) can be found by searching for it. */
const GUARDED_ROUTES: { method: "POST" | "DELETE"; path: (t: string) => string; body?: (t: string) => Json }[] = [
  { method: "POST", path: () => "/admin/inject", body: (t) => ({ session: "plain", content: t }) },
  { method: "POST", path: () => "/permission-answer", body: (t) => ({ requestId: t, allow: true }) },
  { method: "POST", path: () => "/reply", body: (t) => ({ sessionName: "plain", text: t }) },
  { method: "POST", path: () => "/status", body: (t) => ({ sessionName: "plain", text: t, type: "stop" }) },
  {
    method: "POST",
    path: () => "/permission-request",
    body: (t) => ({ sessionName: "plain", requestId: t, toolName: "Bash", description: t, inputPreview: t }),
  },
  { method: "POST", path: () => "/sessions", body: (t) => ({ name: t, path: `/tmp/${t}`, bridgePort: BRIDGE_PORT }) },
  { method: "DELETE", path: (t) => `/sessions/${t}` },
];

/** Every guarded stream. Acceptance is only probed on /ws/events: accepting
 *  /ws/tmux/* would try to attach a real tmux PTY. */
const GUARDED_STREAMS = ["/ws/events", "/ws/tmux/plain"];

function send(route: (typeof GUARDED_ROUTES)[number], token: string, origin?: string) {
  return fetch(`${BASE}${route.path(token)}`, {
    method: route.method,
    headers: { "content-type": "text/plain", ...(origin === undefined ? {} : { origin }) },
    body: route.body ? JSON.stringify(route.body(token)) : undefined,
  });
}

/** Open a WebSocket and report whether the handshake was accepted. */
function wsHandshake(pathname: string, origin?: string): Promise<"open" | "refused" | "timeout"> {
  return new Promise((resolve) => {
    const sock = new WebSocket(
      `ws://127.0.0.1:${ROUTER_PORT}${pathname}`,
      origin === undefined ? undefined : ({ headers: { Origin: origin } } as unknown as string[])
    );
    const timer = setTimeout(() => {
      sock.close();
      resolve("timeout");
    }, 2000);
    sock.onopen = () => {
      clearTimeout(timer);
      sock.close();
      resolve("open");
    };
    sock.onerror = () => {
      clearTimeout(timer);
      resolve("refused");
    };
  });
}

describe("Origin guard (beyond inventory)", () => {
  for (const route of GUARDED_ROUTES) {
    const label = `${route.method} ${route.path("<token>")}`;

    test(`${label}: foreign Origin is 403 with no side effect`, async () => {
      const token = `foreign-probe-${route.method}-${route.path("x").replace(/\W/g, "")}`;
      const eMark = events.length;
      const bMark = bridgeHits.length;
      for (const origin of FOREIGN_ORIGINS) {
        const res = await send(route, token, origin);
        expect(res.status).toBe(403);
      }
      await Bun.sleep(100);
      expect(JSON.stringify(events.slice(eMark))).not.toContain(token);
      expect(JSON.stringify(bridgeHits.slice(bMark))).not.toContain(token);
      const sessions = (await (await fetch(`${BASE}/sessions`)).json()) as Record<string, Json>;
      expect(Object.keys(sessions)).not.toContain(token);
    });

    test(`${label}: missing or localhost Origin passes the guard`, async () => {
      const token = `local-probe-${route.method}-${route.path("x").replace(/\W/g, "")}`;
      for (const origin of LOCAL_ORIGINS) {
        const res = await send(route, token, origin);
        expect(res.status).not.toBe(403);
      }
    });
  }

  for (const pathname of GUARDED_STREAMS) {
    test(`WS ${pathname}: foreign Origin handshake is refused`, async () => {
      for (const origin of FOREIGN_ORIGINS) {
        expect(await wsHandshake(pathname, origin)).toBe("refused");
      }
    });
  }

  test("fails closed: unlisted routes and methods are guarded too", async () => {
    const unlisted: [string, string][] = [
      ["POST", "/not-a-route"],
      ["PUT", "/reply"],
      ["PATCH", "/sessions/plain"],
      ["OPTIONS", "/admin/inject"],
    ];
    for (const [method, route] of unlisted) {
      const foreign = await fetch(`${BASE}${route}`, { method, headers: { origin: "https://evil.example" } });
      expect([method, route, foreign.status]).toEqual([method, route, 403]);
      const local = await fetch(`${BASE}${route}`, { method, headers: { origin: "http://localhost:5173" } });
      expect([method, route, local.status]).toEqual([method, route, 404]);
    }
  });

  test("WS /ws/events: missing or localhost Origin handshake is accepted", async () => {
    for (const origin of LOCAL_ORIGINS) {
      expect(await wsHandshake("/ws/events", origin)).toBe("open");
    }
  });
});

// ── Prototype-key session names (beyond inventory: security) ───────────────

describe("prototype-key session names are unknown sessions", () => {
  test('/reply with sessionName "__proto__" is 404 and mirrors nothing', async () => {
    const mark = events.length;
    const res = await reply("__proto__", "proto-probe");
    expect(res.status).toBe(404);
    expect(JSON.stringify(await eventsAfter(mark))).not.toContain("proto-probe");
    expect(await history("__proto__", "0")).toEqual({ events: [], latest: 0 });
    expect(fake.sent.filter((m) => m.text === "proto-probe")).toEqual([]);
  });

  test('/permission-request with sessionName "__proto__" is 404 and broadcasts nothing', async () => {
    const mark = events.length;
    const res = await post("/permission-request", {
      sessionName: "__proto__",
      requestId: "proto-perm-probe",
      toolName: "Bash",
      description: "d",
      inputPreview: "p",
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await eventsAfter(mark))).not.toContain("proto-perm-probe");
  });
});

// ── B6 / D7 / C7: permission answer + resolved broadcast ───────────────────

describe("B6/D7/C7 POST /permission-answer", () => {
  test("forwards to the bridges and broadcasts session.permission.resolved", async () => {
    const eMark = events.length;
    const bMark = bridgeHits.length;
    const res = await post("/permission-answer", { requestId: "req-panel", allow: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "answered" });
    const e = await waitForEvent(
      eMark,
      (x) => x.type === "session.permission.resolved" && x.requestId === "req-panel"
    );
    expect(e).toEqual({ type: "session.permission.resolved", requestId: "req-panel" });
    const hit = await waitForBridgeHit(
      bMark,
      (h) => h.path === "/permission-response" && h.body.requestId === "req-panel"
    );
    expect(hit.body).toEqual({ requestId: "req-panel", allow: true });
  });

  test("400 unless requestId is a string and allow is boolean", async () => {
    expect((await post("/permission-answer", { requestId: "r", allow: "yes" })).status).toBe(400);
    expect((await post("/permission-answer", { allow: true })).status).toBe(400);
    expect((await post("/permission-answer", { requestId: "", allow: true })).status).toBe(400);
    expect((await post("/permission-answer", "not json")).status).toBe(400);
  });

  test("a platform answer also broadcasts session.permission.resolved", async () => {
    expect(fake.permissionCallback).not.toBeNull();
    const eMark = events.length;
    const bMark = bridgeHits.length;
    fake.permissionCallback!("req-telegram", false);
    const e = await waitForEvent(
      eMark,
      (x) => x.type === "session.permission.resolved" && x.requestId === "req-telegram"
    );
    expect(e).toEqual({ type: "session.permission.resolved", requestId: "req-telegram" });
    const hit = await waitForBridgeHit(
      bMark,
      (h) => h.path === "/permission-response" && h.body.requestId === "req-telegram"
    );
    expect(hit.body).toEqual({ requestId: "req-telegram", allow: false });
  });
});

// ── C6: session.permission ─────────────────────────────────────────────────

describe("C6 session.permission", () => {
  const prompt = {
    sessionName: "plain",
    requestId: "req-c6",
    toolName: "Bash",
    description: "run ls",
    inputPreview: "ls -la",
  };

  test("POST /permission-request broadcasts the prompt", async () => {
    const mark = events.length;
    const res = await post("/permission-request", prompt);
    expect(res.status).toBe(200);
    const e = await waitForEvent(mark, (x) => x.type === "session.permission" && x.requestId === "req-c6");
    expect(e).toEqual({
      type: "session.permission",
      name: "plain",
      requestId: "req-c6",
      toolName: "Bash",
      description: "run ls",
      inputPreview: "ls -la",
      ts: expect.any(String),
    });
  });

  test("the prompt is broadcast even when the platform prompt fails", async () => {
    const mark = events.length;
    fake.promptFails = true;
    let res: Response;
    try {
      res = await post("/permission-request", { ...prompt, requestId: "req-c6-fail" });
    } finally {
      fake.promptFails = false;
    }
    expect(res.status).toBe(500);
    const e = await waitForEvent(
      mark,
      (x) => x.type === "session.permission" && x.requestId === "req-c6-fail"
    );
    expect(e.requestId).toBe("req-c6-fail");
  });

  test("unknown session is 404 and broadcasts nothing", async () => {
    const mark = events.length;
    const res = await post("/permission-request", { ...prompt, sessionName: "ghost" });
    expect(res.status).toBe(404);
    expect((await eventsAfter(mark)).filter((x) => x.type === "session.permission")).toEqual([]);
  });
});

// ── E3: model passthrough ──────────────────────────────────────────────────

describe("E3 model in GET /sessions", () => {
  test("model from the registry is served; absent when unset", async () => {
    const sessions = (await (await fetch(`${BASE}/sessions`)).json()) as Record<string, Json>;
    expect(sessions.modeled.model).toBe("claude-opus-5-5");
    expect(sessions.modeled.threadDisplayName).toBe("Display modeled");
    expect("model" in sessions.plain).toBe(false);
  });

  test("model survives re-registration", async () => {
    const res = await post("/sessions", { name: "modeled", path: "/tmp/modeled-2", bridgePort: BRIDGE_PORT });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).model).toBe("claude-opus-5-5");
    const sessions = (await (await fetch(`${BASE}/sessions`)).json()) as Record<string, Json>;
    expect(sessions.modeled.model).toBe("claude-opus-5-5");
    expect(sessions.modeled.path).toBe("/tmp/modeled-2");
  });
});

// ── Already upstream: verify only (C2 C3 C8 C9) ────────────────────────────

describe("existing events (verify only)", () => {
  test("C2/C3 /status broadcasts session.status then session.status.cleared", async () => {
    const mark = events.length;
    await post("/status", { sessionName: "plain", text: "Reading files", type: "current" });
    const s = await waitForEvent(mark, (x) => x.type === "session.status" && x.name === "plain");
    expect(s).toMatchObject({ name: "plain", current: "Reading files", done: [] });
    expect(typeof s.elapsedMs).toBe("number");
    await post("/status", { sessionName: "plain", type: "stop" });
    await waitForEvent(mark, (x) => x.type === "session.status.cleared" && x.name === "plain");
  });

  test("C8/C9 register and DELETE broadcast session.registered / session.removed", async () => {
    const mark = events.length;
    await register("short-lived");
    await waitForEvent(mark, (x) => x.type === "session.registered" && x.name === "short-lived");
    const res = await fetch(`${BASE}/sessions/short-lived`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await waitForEvent(mark, (x) => x.type === "session.removed" && x.name === "short-lived");
  });
});

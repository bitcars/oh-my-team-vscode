#!/usr/bin/env bun
/**
 * LWO-018 (fork #56) live-check part (i): the sender binding end to end.
 *
 *   export TMPDIR=<scratch dir>; bun test/e2e-team-auth.ts
 *
 * Starts a throwaway router (real channel/router.ts with the no-network stub
 * adapter) and two REAL bridge.ts processes ("hub", "e2e-beta") driven by a
 * stub MCP client over stdio, plus one legacy fake bridge ("e2e-old"). Then it
 * forges what a local process could forge and checks each is refused, with a
 * presence control for each refusal.
 *
 * Never 8800-8899 or 9800-9809: every port is probed, range-checked and
 * confirmed free with lsof. Never the real claude, tmux or omt. The hub dir,
 * HOME and logs live in a fresh temp dir under $TMPDIR, removed on exit.
 *
 * Not a *.test.ts file on purpose: `bun test` never runs it.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHANNEL = path.join(import.meta.dir, "..", "channel");
const BUN = process.execPath;

// ── Ports ──────────────────────────────────────────────────────────────────

function banned(p: number): boolean {
  return (p >= 8800 && p <= 8899) || (p >= 9800 && p <= 9809);
}

function lsofFree(p: number): boolean {
  const r = Bun.spawnSync(["lsof", "-nP", `-iTCP:${p}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "pipe" });
  // exit 1 with empty output = nothing listening
  return r.stdout.toString().trim() === "";
}

function freePort(): number {
  for (let i = 0; i < 20; i++) {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const p = s.port as number;
    s.stop(true);
    if (!banned(p) && lsofFree(p)) return p;
  }
  throw new Error("no free port found");
}

// ── Temp dir, children, cleanup ────────────────────────────────────────────

const tmp = mkdtempSync(path.join(tmpdir(), "omt-e2e-team-auth-"));
const hubDir = path.join(tmp, "hub");
const home = path.join(tmp, "home");
mkdirSync(hubDir, { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(path.join(hubDir, "hub-config.json"), JSON.stringify({ platform: "telegram", credentials: {} }));
writeFileSync(path.join(hubDir, "hub-registry.json"), JSON.stringify({ sessions: {} }));
const routerLog = path.join(tmp, "router.log");

const children: { kill: () => void }[] = [];
const servers: { stop: (f?: boolean) => void }[] = [];
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      // already gone
    }
  }
  for (const s of servers) {
    try {
      s.stop(true);
    } catch {
      // already stopped
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

// ── Results ────────────────────────────────────────────────────────────────

const ORDER = ["E1", "E2", "E3", "E4", "E5", "E6", "E6b", "E7", "E8", "E9", "E6c"];
const results = new Map<string, "PASS" | "FAIL" | "SKIP">();
function pass(id: string, text: string) {
  results.set(id, "PASS");
  console.log(`PASS ${id} ${text}`);
}
function fail(id: string, detail: string) {
  results.set(id, "FAIL");
  console.log(`FAIL ${id} ${detail}`);
}
function skip(id: string, why: string) {
  results.set(id, "SKIP");
  console.log(`SKIP ${id} (${why})`);
}
async function check(id: string, fn: () => Promise<string>) {
  try {
    pass(id, await fn());
  } catch (err) {
    fail(id, err instanceof Error ? err.message : String(err));
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── Router ─────────────────────────────────────────────────────────────────

async function startRouter(): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = freePort();
    const proc = Bun.spawn([BUN, "run", "--no-orphans", "--preload", "./dev/stub-adapter-preload.ts", "router.ts"], {
      cwd: CHANNEL,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), OMT_HUB_DIR: hubDir, ROUTER_PORT: String(port) },
      stdout: Bun.file(path.join(tmp, "router.out")),
      stderr: Bun.file(routerLog),
    });
    children.push(proc);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (res.status === 200) return port;
      } catch {
        // not up yet
      }
      await Bun.sleep(100);
    }
    const tail = (() => {
      try {
        return readFileSync(routerLog, "utf-8").split("\n").slice(-15).join("\n");
      } catch {
        return "";
      }
    })();
    proc.kill();
    if (!/EADDRINUSE/.test(tail) || attempt === 2) {
      console.log(`FAIL BOOT router did not answer /health\n${tail}`);
      cleanup();
      process.exit(1);
    }
  }
  throw new Error("unreachable");
}

// ── Real bridges with a stub MCP client ────────────────────────────────────

interface Bridge {
  name: string;
  port: number;
  /** End the bridge's stdin, as Claude Code going away would. */
  endStdin: () => void;
  messages: Record<string, unknown>[];
  send: (o: unknown) => void;
  call: (id: number, name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function startBridge(name: string, routerPort: number): Promise<Bridge> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = freePort();
    const proc = Bun.spawn([BUN, "run", "bridge.ts"], {
      cwd: CHANNEL,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TMPDIR: tmpdir(),
        OMT_HUB_DIR: hubDir,
        BRIDGE_PORT: String(port),
        ROUTER_URL: `http://localhost:${routerPort}`,
        SESSION_NAME: name,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: Bun.file(path.join(tmp, `bridge-${name}.err`)),
    });
    children.push(proc);
    const messages: Record<string, unknown>[] = [];
    (async () => {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            messages.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // not JSON-RPC
          }
        }
      }
    })().catch(() => {});
    const send = (o: unknown) => {
      proc.stdin.write(`${JSON.stringify(o)}\n`);
      proc.stdin.flush();
    };
    const call = async (id: number, tool: string, args: Record<string, unknown>) => {
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const r = messages.find((m) => m.id === id);
        if (r) return r;
        await Bun.sleep(20);
      }
      throw new Error(`no reply to tools/call ${tool} (id ${id})`);
    };
    const deadline = Date.now() + 10_000;
    let up = false;
    while (Date.now() < deadline && proc.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        const body = (await res.json()) as { session?: string };
        if (res.status === 200 && body.session === name) {
          up = true;
          break;
        }
      } catch {
        // not up yet
      }
      await Bun.sleep(100);
    }
    if (up) {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return { name, port, endStdin: () => void proc.stdin.end(), messages, send, call };
    }
    proc.kill();
    const err = (() => {
      try {
        return readFileSync(path.join(tmp, `bridge-${name}.err`), "utf-8");
      } catch {
        return "";
      }
    })();
    if (!/EADDRINUSE/.test(err) || attempt === 2) throw new Error(`bridge ${name} did not start: ${err.slice(-400)}`);
  }
  throw new Error("unreachable");
}

function channelNotes(b: Bridge, from = 0): { content: string; sender: string }[] {
  return b.messages
    .slice(from)
    .filter((m) => m.method === "notifications/claude/channel")
    .map((m) => {
      const p = m.params as { content: string; meta: { sender: string } };
      return { content: p.content, sender: p.meta.sender };
    });
}

async function waitNote(b: Bridge, from: number, match: (n: { content: string; sender: string }) => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const n = channelNotes(b, from).find(match);
    if (n) return n;
    await Bun.sleep(20);
  }
  return undefined;
}

// ── Run ────────────────────────────────────────────────────────────────────

const R = await startRouter();
const BASE = `http://127.0.0.1:${R}`;
const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const routerLines = () => {
  try {
    return readFileSync(routerLog, "utf-8").split("\n");
  } catch {
    return [];
  }
};

// The [::1] decoy on the router's port: every bridge uses ROUTER_URL=localhost.
const decoyHits: string[] = [];
let decoyOk = true;
try {
  servers.push(Bun.serve({ port: R, hostname: "::1", fetch: (req) => (decoyHits.push(req.url), new Response("decoy")) }));
} catch {
  decoyOk = false;
}
if (decoyOk) {
  try {
    await fetch(`http://[::1]:${R}/`, { signal: AbortSignal.timeout(1000) });
  } catch {
    // counted below
  }
}
const decoyPresence = decoyHits.length;

const hub = await startBridge("hub", R);
const beta = await startBridge("e2e-beta", R);
const oldFake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/health" ? Response.json({ status: "ok", session: "e2e-old" }) : Response.json({ status: "ok" })) });
servers.push(oldFake);

const reg = async (name: string, port: number, extra: Record<string, unknown> = {}) =>
  post("/sessions", { name, path: path.join(tmp, name), bridgePort: port, ...extra });
assert((await reg("hub", hub.port, { isHub: true })).status === 201, "hub registration failed");
assert((await reg("e2e-beta", beta.port)).status === 201, "e2e-beta registration failed");
assert((await reg("e2e-old", oldFake.port as number)).status === 201, "e2e-old registration failed");

let callId = 10;

await check("E1", async () => {
  const mark = beta.messages.length;
  const r = await hub.call(++callId, "team_message", { to: "e2e-beta", text: "e1 hello" });
  assert(!(r.result as { isError?: boolean })?.isError, `tool error: ${JSON.stringify(r.result)}`);
  const n = await waitNote(beta, mark, (x) => x.content.includes("e1 hello"));
  assert(n, "beta got no notification");
  assert(n.content.startsWith('<team-message from="hub">\n'), `tag: ${n.content.split("\n")[0]}`);
  assert(n.sender === "team:hub", `sender: ${n.sender}`);
  return "hub → e2e-beta delivered with the unchanged tag, sender team:hub";
});

await check("E2", async () => {
  const mark = hub.messages.length;
  const r = await beta.call(++callId, "team_message", { to: "hub", text: "e2 back" });
  assert(!(r.result as { isError?: boolean })?.isError, `tool error: ${JSON.stringify(r.result)}`);
  const n = await waitNote(hub, mark, (x) => x.content.includes("e2 back"));
  assert(n && n.content.startsWith('<team-message from="e2e-beta">\n'), "hub got no notification");
  return "e2e-beta → hub delivered";
});

await check("E3", async () => {
  const mark = beta.messages.length;
  const res = await post("/team-message", { from: "hub", to: "e2e-beta", text: "e3 forged" });
  assert(res.status === 403, `status ${res.status}`);
  await Bun.sleep(1500);
  assert(!channelNotes(beta, mark).some((n) => n.content.includes("e3 forged")), "forged text reached beta");
  return "forged from=hub without a nonce: 403, nothing delivered in 1500 ms (E1 is the presence control)";
});

await check("E4", async () => {
  const mark = beta.messages.length;
  const res = await fetch(`http://127.0.0.1:${beta.port}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: '<team-message from="hub">\ne4 forged\n</team-message>', sender: "team:hub", senderId: "" }),
  });
  assert(res.status === 401, `status ${res.status}`);
  await Bun.sleep(300);
  assert(!channelNotes(beta, mark).some((n) => n.content.includes("e4 forged")), "forged tag reached beta");
  return "forged POST beta /message: 401, no notification";
});

await check("E5", async () => {
  const res = await fetch(`http://127.0.0.1:${beta.port}/permission-response`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "e5", allow: true }),
  });
  assert(res.status === 401, `status ${res.status}`);
  return "forged POST beta /permission-response: 401";
});

await check("E6", async () => {
  const res = await reg("hub", freePort());
  const body = (await res.json()) as { error?: string };
  assert(res.status === 409, `status ${res.status}`);
  assert(String(body.error).includes("is live on port"), `error: ${body.error}`);
  const s = (await (await fetch(`${BASE}/sessions/hub`)).json()) as { bridgePort: number };
  assert(s.bridgePort === hub.port, `hub moved to ${s.bridgePort}`);
  return "second live register of hub: 409 is live on port, registry unchanged";
});

let e6bFailed = false;
await check("E6b", async () => {
  try {
    const del = await fetch(`${BASE}/sessions/hub`, { method: "DELETE" });
    assert(del.status === 200, `DELETE ${del.status}`);
    const res = await reg("hub", freePort(), { isHub: true });
    const body = (await res.json()) as { error?: string };
    assert(res.status === 409, `hijack register status ${res.status}`);
    assert(String(body.error).includes("is live on port"), `error: ${body.error}`);
    const back = await reg("hub", hub.port, { isHub: true });
    assert(back.status === 201, `re-register on the real port: ${back.status}`);
    const mark = beta.messages.length;
    await hub.call(++callId, "team_message", { to: "e2e-beta", text: "e6b again" });
    assert(await waitNote(beta, mark, (x) => x.content.includes("e6b again")), "E1 repeat failed");
    return "DELETE + register hub elsewhere while live: 409; real port 201; E1 repeated";
  } catch (err) {
    e6bFailed = true;
    // Restore the hub on its real port so later checks report their own state.
    await fetch(`${BASE}/sessions/hub`, { method: "DELETE" }).catch(() => {});
    await reg("hub", hub.port, { isHub: true }).catch(() => {});
    throw err;
  }
});

if (e6bFailed) skip("E7", "after E6b");
else
  await check("E7", async () => {
    const r = await hub.call(++callId, "reply", { text: "e7 reply" });
    assert(!(r.result as { isError?: boolean })?.isError, `tool error: ${JSON.stringify(r.result)}`);
    await Bun.sleep(200);
    assert(!routerLines().some((l) => l.includes('from "hub" unverified')), "router logged hub as unverified");
    return "hub reply tool call 200; no unverified line for hub";
  });

await check("E8", async () => {
  const res = await post("/reply", { sessionName: "e2e-old", text: "e8 legacy" });
  assert(res.status === 200, `status ${res.status}`);
  await Bun.sleep(200);
  const n = routerLines().filter((l) => l === 'omt-router: /reply from "e2e-old" unverified (legacy bridge)').length;
  assert(n === 1, `${n} legacy lines`);
  return "legacy bridge nonceless /reply: 200, exactly one unverified line";
});

await check("E9", async () => {
  assert(decoyOk, "the [::1] decoy could not bind");
  assert(decoyPresence === 1, `presence fetch gave ${decoyPresence} decoy hits`);
  assert(decoyHits.length === 1, `decoy got ${decoyHits.length - 1} bridge requests`);
  return "[::1] decoy: 1 presence hit, 0 bridge requests";
});

if (e6bFailed) skip("E6c", "after E6b");
else
  await check("E6c", async () => {
    hub.endStdin();
    const deadline = Date.now() + 3000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${hub.port}/health`, { signal: AbortSignal.timeout(300) });
      } catch {
        gone = true;
        break;
      }
      await Bun.sleep(100);
    }
    assert(gone, "hub bridge still listening 3 s after stdin end");
    const res = await reg("hub", freePort());
    assert(res.status === 200, `status ${res.status}`);
    return "hub bridge exited on stdin end; register elsewhere then 200 (control for E6)";
  });

const passed = ORDER.filter((id) => results.get(id) === "PASS").length;
console.log(`E2E ${passed}/${ORDER.length} ${passed === ORDER.length ? "PASS" : "FAIL"}`);
cleanup();
process.exit(passed === ORDER.length ? 0 : 1);

#!/usr/bin/env bun
/**
 * Stub router for local extension testing (WO-018).
 *
 * ┌─ HARD RULE ──────────────────────────────────────────────────────────────┐
 * │ This clone's router must NEVER run with the fleet's Telegram bot token,  │
 * │ NEVER on port 8800, and NEVER with the fleet's OMT_HUB_DIR               │
 * │ (~/.oh-my-team). The Telegram adapter long-polls getUpdates: two routers │
 * │ on one bot token fight over updates and break the live fleet's inbound.  │
 * │ This launcher enforces all three: it refuses port 8800, always creates a │
 * │ fresh temp hub dir, writes a config with NO credentials, and swaps the   │
 * │ Telegram adapter for an in-process stub that never touches the network. │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Boots the REAL channel/router.ts with:
 *   - a stub platform adapter (logs what would have gone to Telegram), and
 *   - one echo bridge per session, standing in for a Claude session.
 * So a VS Code panel pointed at it gets the full loop: send (POST
 * /admin/inject) → bridge → reply (POST /reply) → session.reply event with
 * seq → reload → GET /history backfill, with no Telegram and no fleet.
 *
 * Usage:
 *   bun channel/dev/stub-router.ts [--port 18800 | --port=18800]
 * Then set the extension's "omt.routerUrl" to http://localhost:<port>.
 *
 * Message commands understood by the echo bridges (send them from the panel):
 *   anything     → replies "echo: <text>" after ~300 ms
 *   /burst N     → sends N numbered replies back to back (1 ≤ N ≤ 50)
 *   /perm        → raises a permission prompt; answering it (panel Allow/Deny
 *                  or POST /permission-answer) replies "permission <id>: allow|deny"
 *   /fail        → the bridge answers 500, so /admin/inject returns 502
 *   /ask         → this session asks a 3-option question (text card in the
 *                  topic + session.ask card in the panel); the answer comes
 *                  back as "ask answered: <choice>"
 *   /topic TEXT  → feeds TEXT into the router as if typed in this session's
 *                  Telegram topic: a number or option text answers the open
 *                  ask, anything else dismisses it and is delivered as usual.
 *                  Text typed in the PANEL never answers an ask; use /topic.
 *   /team        → after 5 s, this session sends the OTHER session a
 *                  team_message (kind "team": shown there, NO toast)
 *   /ping-other  → after 5 s, a plain reply on the OTHER session (presence
 *                  control: it MUST toast)
 *   /escalate    → after 5 s, a plain reply on the OTHER session, then it
 *                  escalates within 1 s (both toast; the escalation despite
 *                  the panel's 2 s cooldown)
 * Switch the panel to this session (away from the other one) during the 5 s.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── Arguments and guards ───────────────────────────────────────────────────

const FLEET_PORT = 8800;

function parsePort(argv: string[]): number {
  const i = argv.indexOf("--port");
  const eq = argv.find((a) => a.startsWith("--port="));
  const raw = eq !== undefined ? eq.slice("--port=".length) : i >= 0 ? argv[i + 1] : "18800";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`stub-router: invalid --port ${JSON.stringify(raw)}\n`);
    process.exit(2);
  }
  return port;
}

const ROUTER_PORT = parsePort(process.argv.slice(2));
if (ROUTER_PORT === FLEET_PORT) {
  process.stderr.write(
    `stub-router: refusing port ${FLEET_PORT}: that is the fleet router's port. Pick another --port.\n`
  );
  process.exit(2);
}

// A fresh hub dir every run. There is deliberately no option to pass one in,
// so this can never read or write the fleet's registry or config.
const hubDir = mkdtempSync(path.join(tmpdir(), "omt-stub-router-"));
process.on("exit", () => rmSync(hubDir, { recursive: true, force: true }));

// ── Stub platform adapter ──────────────────────────────────────────────────

let stubConnected = false;
let messageCallback: ((message: Record<string, unknown>) => void) | null = null;

function stubLog(line: string): void {
  process.stderr.write(`[stub-telegram] ${line}\n`);
}

class StubTelegramAdapter {
  readonly name = "stub-telegram";
  readonly botCommands = [
    { command: "stub", description: "Sample command served by the stub adapter" },
  ];
  async connect() {
    stubConnected = true;
    stubLog("connected (no network)");
  }
  async disconnect() {}
  async createThread(sessionName: string) {
    return { threadId: `stub-thread-${sessionName}`, displayName: sessionName };
  }
  async closeThread(threadId: string) {
    stubLog(`closeThread ${threadId}`);
  }
  async send(threadId: string, text: string) {
    stubLog(`send ${threadId}: ${text}`);
  }
  async sendPermissionPrompt(threadId: string, prompt: { requestId: string; toolName: string }) {
    stubLog(`permission prompt ${threadId}: ${prompt.toolName} (${prompt.requestId})`);
  }
  onMessage(cb: (message: Record<string, unknown>) => void) {
    messageCallback = cb;
  }
  // No platform to answer from; answers come via POST /permission-answer.
  onPermissionResponse() {}
  getHubThreadId() {
    return null;
  }
}

// Swap the real Telegram adapter module for the stub before the router loads it.
Bun.plugin({
  name: "omt-stub-telegram-adapter",
  setup(build) {
    build.onLoad({ filter: /[\\/]adapters[\\/]telegram\.ts$/ }, () => ({
      exports: { TelegramAdapter: StubTelegramAdapter },
      loader: "object",
    }));
  },
});

// ── Echo bridges (one per session, like real bridges) ──────────────────────

const ROUTER_URL = `http://127.0.0.1:${ROUTER_PORT}`;

function postRouter(route: string, body: unknown): Promise<Response> {
  return fetch(`${ROUTER_URL}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sendReply(sessionName: string, text: string): void {
  postRouter("/reply", { sessionName, text }).catch((err) =>
    process.stderr.write(`stub-router: echo reply failed: ${err}\n`)
  );
}

/** The other stub session, for /team. */
function otherSession(sessionName: string): string {
  return SESSIONS.map((s) => s.name).find((n) => n !== sessionName) ?? sessionName;
}

function startEchoBridge(sessionName: string): number {
  let permCounter = 0;
  const threadId = `stub-thread-${sessionName}`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

      if (req.method === "POST" && url.pathname === "/message") {
        const content = typeof body.content === "string" ? body.content.trim() : "";
        const sender = typeof body.sender === "string" ? body.sender : "?";
        process.stderr.write(`[echo ${sessionName}] message from ${sender}: ${content}\n`);

        if (content === "/fail") {
          return Response.json({ error: "stub bridge failure (requested)" }, { status: 500 });
        }
        const topic = /^\/topic\s+([\s\S]+)$/.exec(content);
        const other = otherSession(sessionName);
        if (sender === "decision") {
          // The router delivered an <ask-answer>; report what came back.
          const answer = content.replace(/^<ask-answer[^>]*>\n?/, "").replace(/\n?<\/ask-answer>$/, "");
          setTimeout(() => sendReply(sessionName, `ask answered: ${answer}`), 300);
        } else if (sender.startsWith("team:")) {
          // A team_message arrived; it is already mirrored as kind "team".
          stubLog(`team message delivered to ${sessionName} from ${sender.slice(5)}`);
        } else if (content === "/ask") {
          setTimeout(() => {
            postRouter("/ask", {
              sessionName,
              question: "Stub decision: which option?",
              options: ["Option A", "Option B", "Option C"],
            }).catch(() => {});
          }, 300);
        } else if (topic) {
          setTimeout(() => {
            messageCallback?.({
              threadId,
              text: topic[1],
              senderId: "stub-user",
              senderName: "Stub Telegram user",
              messageId: `stub-typed-${Date.now()}`,
              timestamp: new Date().toISOString(),
            });
          }, 300);
        } else if (content === "/team") {
          setTimeout(() => {
            postRouter("/team-message", {
              from: sessionName,
              to: other,
              text: `Stub team message from ${sessionName}`,
            }).catch(() => {});
          }, 5000);
        } else if (content === "/ping-other") {
          setTimeout(() => sendReply(other, `Stub plain reply on ${other} (should toast)`), 5000);
        } else if (content === "/escalate") {
          setTimeout(() => {
            sendReply(other, `Stub plain reply on ${other} before the escalation`);
            setTimeout(() => {
              postRouter("/escalate", {
                from: other,
                reason: "Stub escalation",
                question: "Stub: approve the stub action?",
              }).catch(() => {});
            }, 500);
          }, 5000);
        } else if (content === "/perm") {
          const requestId = `stub-${sessionName}-${++permCounter}`;
          setTimeout(() => {
            postRouter("/permission-request", {
              sessionName,
              requestId,
              toolName: "Bash",
              description: "Stub permission prompt",
              inputPreview: "echo hello",
            }).catch(() => {});
          }, 300);
        } else {
          const burst = /^\/burst\s+(\d+)$/.exec(content);
          if (burst) {
            const n = Math.min(Math.max(Number(burst[1]), 1), 50);
            setTimeout(async () => {
              for (let i = 1; i <= n; i++) {
                await postRouter("/reply", { sessionName, text: `burst ${i}/${n}` }).catch(() => {});
              }
            }, 300);
          } else {
            setTimeout(() => sendReply(sessionName, `echo: ${content}`), 300);
          }
        }
        return Response.json({ status: "delivered" });
      }

      if (req.method === "POST" && url.pathname === "/permission-response") {
        // The router fans answers out to every bridge; only the owner replies.
        const requestId = typeof body.requestId === "string" ? body.requestId : "";
        if (requestId.startsWith(`stub-${sessionName}-`)) {
          sendReply(sessionName, `permission ${requestId}: ${body.allow ? "allow" : "deny"}`);
        }
        return Response.json({ status: "applied" });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  if (server.port === undefined) throw new Error("echo bridge has no TCP port");
  return server.port;
}

// ── Seed hub dir and boot the real router ──────────────────────────────────

const SESSIONS: { name: string; model?: string }[] = [
  { name: "stub-echo", model: "stub-model" },
  { name: "stub-plain" },
];

const registry: Record<string, unknown> = {};
for (const s of SESSIONS) {
  registry[s.name] = {
    name: s.name,
    path: hubDir,
    bridgePort: startEchoBridge(s.name),
    threadId: `stub-thread-${s.name}`,
    threadDisplayName: `${s.name} (stub)`,
    startedAt: new Date().toISOString(),
    ...(s.model ? { model: s.model } : {}),
  };
}
writeFileSync(
  path.join(hubDir, "hub-config.json"),
  JSON.stringify({ platform: "telegram", credentials: {} })
);
writeFileSync(path.join(hubDir, "hub-registry.json"), JSON.stringify({ sessions: registry }, null, 2));

process.env.OMT_HUB_DIR = hubDir;
process.env.ROUTER_PORT = String(ROUTER_PORT);

await import("../router");

if (!stubConnected) {
  process.stderr.write("stub-router: the stub adapter did not load; refusing to continue.\n");
  process.exit(1);
}

process.stderr.write(
  [
    "",
    `stub-router: ready on ${ROUTER_URL} (hub dir ${hubDir}, removed on exit)`,
    `  VS Code setting:  "omt.routerUrl": "http://localhost:${ROUTER_PORT}"`,
    `  sessions:         ${SESSIONS.map((s) => s.name).join(", ")}`,
    "  panel commands:   any text → echo · /burst N · /perm · /fail",
    "                    /ask · /topic TEXT · /team · /ping-other · /escalate",
    "  acceptance:",
    `    curl -s ${ROUTER_URL}/sessions | jq 'to_entries[] | .value | {name, threadDisplayName, model}'`,
    `    curl -s -XPOST ${ROUTER_URL}/admin/inject -H 'content-type: application/json' -d '{"session":"stub-echo","content":"ping","sender":"vscode"}'`,
    `    curl -s '${ROUTER_URL}/history?session=stub-echo&since=0' | jq '{n: (.events|length), latest}'`,
    "",
  ].join("\n")
);

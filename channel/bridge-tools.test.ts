/**
 * Bridge MCP tools (bridge-tools.ts), WO-019 Phase 2.
 *
 * bridge.ts itself needs the MCP SDK, so these tests drive callTool directly
 * against a fake router on 127.0.0.1 (free port, never 8800) that records
 * every request and answers with a configurable status and body.
 *
 * The reply tests pin today's behaviour exactly: reply moved out of bridge.ts
 * and must not change.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { TOOLS, callTool, type ToolContext } from "./bridge-tools";

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

/** The message a promise rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a rejection, but the promise resolved");
}

/** Run fn while recording everything written to stdout and stderr. */
async function captureStdio<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

// ── Fake router ────────────────────────────────────────────────────────────

const hits: { method: string; path: string; contentType: string | null; body: unknown }[] = [];
let routerStatus = 200;
let routerBody = "{}";

const router = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    hits.push({
      method: req.method,
      path: new URL(req.url).pathname,
      contentType: req.headers.get("content-type"),
      body: JSON.parse(await req.text()),
    });
    return new Response(routerBody, { status: routerStatus, headers: { "Content-Type": "application/json" } });
  },
});

function respond(status: number, body: unknown): void {
  routerStatus = status;
  routerBody = typeof body === "string" ? body : JSON.stringify(body);
}

const SESSION = "alpha";
const ctx: ToolContext = { routerUrl: `http://127.0.0.1:${portOf(router)}`, sessionName: SESSION };

beforeEach(() => {
  hits.length = 0;
  respond(200, { status: "ok" });
});

afterAll(() => {
  router.stop(true);
});

// ── TOOLS ──────────────────────────────────────────────────────────────────

describe("TOOLS", () => {
  test("lists exactly reply, ask, escalate, team_message", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["reply", "ask", "escalate", "team_message"]);
  });

  test("each tool's schema requires the right fields", () => {
    const required = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema.required]));
    expect(required).toEqual({
      reply: ["text"],
      ask: ["question", "options"],
      escalate: ["reason", "question"],
      team_message: ["to", "text"],
    });
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([...tool.inputSchema.required].sort());
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test("reply's definition is unchanged", () => {
    expect(TOOLS[0]).toEqual({
      name: "reply",
      description:
        "Send a message back to the user through the messaging platform. " +
        "Keep messages concise and readable on a phone screen.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The message to send. Markdown is supported on most platforms.",
          },
        },
        required: ["text"],
      },
    });
  });
});

// ── reply ──────────────────────────────────────────────────────────────────

describe("reply", () => {
  test("POSTs exactly {sessionName, text} as JSON to /reply and returns sent", async () => {
    const result = await callTool("reply", { text: "hello" }, ctx);

    expect(result).toEqual({ content: [{ type: "text", text: "sent" }] });
    expect(hits).toEqual([
      { method: "POST", path: "/reply", contentType: "application/json", body: { sessionName: SESSION, text: "hello" } },
    ]);
  });

  test("a router error becomes an isError result and one stderr line", async () => {
    respond(500, "boom");
    const { result, stdout, stderr } = await captureStdio(() => callTool("reply", { text: "hello" }, ctx));

    expect(result).toEqual({
      content: [{ type: "text", text: "reply failed: Router responded 500: boom" }],
      isError: true,
    });
    expect(stderr).toBe("omt-bridge: reply failed: Router responded 500: boom\n");
    expect(stdout).toBe("");
  });

  test("missing, empty, or non-string text throws without contacting the router", async () => {
    const message = "reply tool requires a non-empty 'text' argument";
    expect(await rejection(callTool("reply", {}, ctx))).toBe(message);
    expect(await rejection(callTool("reply", { text: "" }, ctx))).toBe(message);
    expect(await rejection(callTool("reply", { text: 42 }, ctx))).toBe(message);
    expect(await rejection(callTool("reply", undefined, ctx))).toBe(message);
    expect(hits).toEqual([]);
  });
});

// ── ask ────────────────────────────────────────────────────────────────────

describe("ask", () => {
  test("POSTs {sessionName, question, options} to /ask and returns the token", async () => {
    respond(200, { status: "asked", token: "tok123" });
    const options = ["Ship it", "Hold"];
    const result = await callTool("ask", { question: "Ship?", options }, ctx);

    expect(hits).toEqual([
      { method: "POST", path: "/ask", contentType: "application/json", body: { sessionName: SESSION, question: "Ship?", options } },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: "text",
        text:
          "Decision posted (token tok123). The user answers by typing the number or option text in your topic, " +
          "or in the VS Code panel; the answer arrives as an <ask-answer> inbound. " +
          "Continue non-dependent work; don't block unless this decision gates everything.",
      },
    ]);
  });

  test("accepts 2 and 4 options, rejects 1 and 5", async () => {
    const message = "ask requires 2–4 non-empty string 'options'";
    expect(await rejection(callTool("ask", { question: "q", options: ["a"] }, ctx))).toBe(message);
    expect(await rejection(callTool("ask", { question: "q", options: ["a", "b", "c", "d", "e"] }, ctx))).toBe(message);
    expect(hits).toEqual([]);

    respond(200, { status: "asked", token: "t" });
    expect((await callTool("ask", { question: "q", options: ["a", "b"] }, ctx)).isError).toBeUndefined();
    expect((await callTool("ask", { question: "q", options: ["a", "b", "c", "d"] }, ctx)).isError).toBeUndefined();
    expect(hits.length).toBe(2);
  });

  test("rejects empty, blank, or non-string options and a non-array", async () => {
    const message = "ask requires 2–4 non-empty string 'options'";
    expect(await rejection(callTool("ask", { question: "q", options: ["a", ""] }, ctx))).toBe(message);
    expect(await rejection(callTool("ask", { question: "q", options: ["a", "   "] }, ctx))).toBe(message);
    expect(await rejection(callTool("ask", { question: "q", options: ["a", 2] }, ctx))).toBe(message);
    expect(await rejection(callTool("ask", { question: "q", options: "a,b" }, ctx))).toBe(message);
    expect(await rejection(callTool("ask", { question: "q" }, ctx))).toBe(message);
    expect(hits).toEqual([]);
  });

  test("rejects a missing, empty, or blank question", async () => {
    const message = "ask requires a non-empty 'question'";
    expect(await rejection(callTool("ask", { question: "", options: ["a", "b"] }, ctx))).toBe(message);
    expect(await rejection(callTool("ask", { question: "   ", options: ["a", "b"] }, ctx))).toBe(message);
    expect(await rejection(callTool("ask", { options: ["a", "b"] }, ctx))).toBe(message);
    expect(hits).toEqual([]);
  });

  test("a router error becomes an isError result that suggests a fallback", async () => {
    respond(502, "bad gateway");
    const lines: string[] = [];
    const { result, stdout } = await captureStdio(() =>
      callTool("ask", { question: "q", options: ["a", "b"] }, { ...ctx, log: (line) => lines.push(line) })
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "ask failed: Router responded 502: bad gateway — fall back to reply or escalate." }],
      isError: true,
    });
    expect(lines).toEqual(["ask failed: Router responded 502: bad gateway"]);
    expect(stdout).toBe("");
  });
});

// ── escalate ───────────────────────────────────────────────────────────────

describe("escalate", () => {
  test("POSTs {from, reason, question} to /escalate", async () => {
    const result = await callTool("escalate", { reason: "needs approval", question: "Drop the table?" }, ctx);

    expect(hits).toEqual([
      {
        method: "POST",
        path: "/escalate",
        contentType: "application/json",
        body: { from: SESSION, reason: "needs approval", question: "Drop the table?" },
      },
    ]);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text:
            "escalated: posted to your topic and flagged as important in the VS Code panel. " +
            "The user answers by replying in your topic.",
        },
      ],
    });
  });

  test("rejects a missing reason or question", async () => {
    const noReason = "escalate requires a non-empty 'reason' (one line, why blocked)";
    const noQuestion = "escalate requires a non-empty 'question' (the decision needed)";
    expect(await rejection(callTool("escalate", { question: "q" }, ctx))).toBe(noReason);
    expect(await rejection(callTool("escalate", { reason: "", question: "q" }, ctx))).toBe(noReason);
    expect(await rejection(callTool("escalate", { reason: "   ", question: "q" }, ctx))).toBe(noReason);
    expect(await rejection(callTool("escalate", { reason: "r", question: " \n " }, ctx))).toBe(noQuestion);
    expect(await rejection(callTool("escalate", { reason: "r" }, ctx))).toBe(noQuestion);
    expect(await rejection(callTool("escalate", { reason: "r", question: 7 }, ctx))).toBe(noQuestion);
    expect(hits).toEqual([]);
  });

  test("a router error becomes an isError result", async () => {
    respond(400, { error: "reason required" });
    const result = await callTool("escalate", { reason: "r", question: "q" }, ctx);

    expect(result).toEqual({
      content: [{ type: "text", text: 'escalate failed: Router responded 400: {"error":"reason required"}' }],
      isError: true,
    });
  });
});

// ── team_message ───────────────────────────────────────────────────────────

describe("team_message", () => {
  test("POSTs {from, to, text} to /team-message and reports delivery", async () => {
    const result = await callTool("team_message", { to: "beta", text: "need a citation" }, ctx);

    expect(hits).toEqual([
      {
        method: "POST",
        path: "/team-message",
        contentType: "application/json",
        body: { from: SESSION, to: "beta", text: "need a citation" },
      },
    ]);
    expect(result).toEqual({ content: [{ type: "text", text: "delivered to beta" }] });
  });

  test("rejects a missing target, empty text, and messaging itself", async () => {
    expect(await rejection(callTool("team_message", { text: "hi" }, ctx))).toBe(
      "team_message requires 'to' (target session name)"
    );
    expect(await rejection(callTool("team_message", { to: "beta", text: "" }, ctx))).toBe(
      "team_message requires non-empty 'text'"
    );
    expect(await rejection(callTool("team_message", { to: "beta", text: "   " }, ctx))).toBe(
      "team_message requires non-empty 'text'"
    );
    expect(await rejection(callTool("team_message", { to: "  ", text: "hi" }, ctx))).toBe(
      "team_message requires 'to' (target session name)"
    );
    expect(await rejection(callTool("team_message", { to: SESSION, text: "hi" }, ctx))).toBe(
      "team_message: target equals current session — use reply instead"
    );
    expect(hits).toEqual([]);
  });

  test("a 404 keeps the router's available_sessions list verbatim", async () => {
    const body = '{"error":"target session \\"x\\" not found","available_sessions":["a","b"]}';
    respond(404, body);
    const result = await callTool("team_message", { to: "x", text: "hi" }, ctx);

    expect(result).toEqual({
      content: [{ type: "text", text: `team_message failed: Router responded 404: ${body}` }],
      isError: true,
    });
  });
});

// ── Network failure and dispatch ───────────────────────────────────────────

describe("network failure and dispatch", () => {
  const calls: [string, Record<string, unknown>][] = [
    ["reply", { text: "hi" }],
    ["ask", { question: "q", options: ["a", "b"] }],
    ["escalate", { reason: "r", question: "q" }],
    ["team_message", { to: "beta", text: "hi" }],
  ];

  test("a router that is not listening gives an isError result for every tool", async () => {
    const closed: ToolContext = { ...ctx, routerUrl: `http://127.0.0.1:${freePort()}`, log: () => {} };
    for (const [name, args] of calls) {
      const { result, stdout } = await captureStdio(() => callTool(name, args, closed));
      expect(result.isError).toBe(true);
      expect(result.content[0].text.startsWith(`${name} failed: `)).toBe(true);
      expect(stdout).toBe("");
    }
  });

  test("uses ctx.fetchImpl when given", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      async (input: string | URL | Request): Promise<Response> => {
        urls.push(String(input));
        throw new Error("injected");
      },
      { preconnect: fetch.preconnect }
    );
    const injected: ToolContext = { ...ctx, fetchImpl, log: () => {} };
    for (const [name, args] of calls) {
      const { result } = await captureStdio(() => callTool(name, args, injected));
      expect(result.content[0].text.startsWith(`${name} failed: injected`)).toBe(true);
    }
    expect(urls).toEqual(["/reply", "/ask", "/escalate", "/team-message"].map((route) => `${ctx.routerUrl}${route}`));
    expect(hits).toEqual([]);
  });

  test("an unknown tool name throws", async () => {
    expect(await rejection(callTool("nope", {}, ctx))).toBe("Unknown tool: nope");
    expect(hits).toEqual([]);
  });
});

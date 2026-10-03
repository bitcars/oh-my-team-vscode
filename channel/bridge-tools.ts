/**
 * Oh My Team — Bridge tools
 *
 * The MCP tool definitions and handlers the bridge exposes to Claude Code.
 * Kept free of the MCP SDK so it can be tested without it: bridge.ts wires
 * TOOLS into ListTools and callTool into CallTool.
 *
 * Every tool POSTs to a router route. Nothing here writes to stdout, which
 * is the MCP channel.
 */

export interface ToolContext {
  routerUrl: string;
  sessionName: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

// A type alias, not an interface: the SDK's result type has an index
// signature, which only object type aliases satisfy implicitly.
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const TOOLS = [
  {
    name: "reply",
    description:
      "Send a message back to the user through the messaging platform. " +
      "Keep messages concise and readable on a phone screen.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "The message to send. Markdown is supported on most platforms.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "ask",
    description:
      "Ask the user to pick one of 2–4 options. The question is posted to your topic as numbered " +
      "options and as a card in the VS Code panel. The user answers by typing the option number " +
      "(or its text) in your topic, or by clicking it in the panel; " +
      "the choice comes back to you as an <ask-answer> inbound. " +
      "The call returns immediately, so keep doing work that does not depend on the answer. " +
      "For an open-ended question use reply; for a true blocker with no clean set of options use escalate.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The decision, phrased so that picking one option is an unambiguous answer.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "2–4 distinct choices, your recommended option first. Each one a short, self-contained line.",
        },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "escalate",
    description:
      "Flag a decision you cannot make on your own. Use ONLY for true blockers: a destructive or " +
      "irreversible action that needs approval, a missing credential or decision, or repeated hard failure. " +
      "NOT for status, progress, or FYI — that's reply. " +
      "Posts your reason and question to your topic and flags them as important in the VS Code panel. " +
      "The user answers by replying in your topic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "One short line: why you are blocked, e.g. 'needs approval to drop the prod table'.",
        },
        question: {
          type: "string",
          description: "The full decision you need, with enough context to answer without opening the codebase.",
        },
      },
      required: ["reason", "question"],
    },
  },
  {
    name: "team_message",
    description:
      "Send a message to another omt session's agent. It arrives there as a <team-message from=\"...\"> tag, " +
      "and that agent answers with its own team_message back to you. " +
      "Use it for help, context, or coordination from another session. " +
      "Do NOT use it to message the user — use reply for that. " +
      "If the target name is wrong, the error lists the available sessions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description: "Target session name. Cannot be the current session.",
        },
        text: {
          type: "string",
          description: "Message body. Say what you need and how the other session should respond.",
        },
      },
      required: ["to", "text"],
    },
  },
];

function argsOf(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** POST JSON to a router route; a non-2xx response throws with its body. */
async function postToRouter(ctx: ToolContext, route: string, payload: unknown): Promise<Response> {
  const response = await (ctx.fetchImpl ?? fetch)(`${ctx.routerUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Router responded ${response.status}: ${body}`);
  }
  return response;
}

async function reply(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { text } = argsOf(args);
  if (!text || typeof text !== "string") {
    throw new Error("reply tool requires a non-empty 'text' argument");
  }

  try {
    await postToRouter(ctx, "/reply", { sessionName: ctx.sessionName, text });
    return textResult("sent");
  } catch (err) {
    const message = errorMessage(err);
    process.stderr.write(`omt-bridge: reply failed: ${message}\n`);
    return errorResult(`reply failed: ${message}`);
  }
}

async function ask(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { question, options } = argsOf(args);
  if (typeof question !== "string" || !question.trim()) {
    throw new Error("ask requires a non-empty 'question'");
  }
  if (
    !Array.isArray(options) ||
    options.length < 2 ||
    options.length > 4 ||
    !options.every((o) => typeof o === "string" && o.trim().length > 0)
  ) {
    throw new Error("ask requires 2–4 non-empty string 'options'");
  }

  try {
    const response = await postToRouter(ctx, "/ask", { sessionName: ctx.sessionName, question, options });
    const { token } = (await response.json()) as { token?: string };
    return textResult(
      `Decision posted (token ${token ?? "n/a"}). The user answers by typing the number or option text in your topic, ` +
        `or in the VS Code panel; the answer arrives as an <ask-answer> inbound. ` +
        `Continue non-dependent work; don't block unless this decision gates everything.`
    );
  } catch (err) {
    const message = errorMessage(err);
    ctx.log?.(`ask failed: ${message}`);
    return errorResult(`ask failed: ${message} — fall back to reply or escalate.`);
  }
}

async function escalate(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { reason, question } = argsOf(args);
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("escalate requires a non-empty 'reason' (one line, why blocked)");
  }
  if (typeof question !== "string" || !question.trim()) {
    throw new Error("escalate requires a non-empty 'question' (the decision needed)");
  }

  try {
    await postToRouter(ctx, "/escalate", { from: ctx.sessionName, reason, question });
    return textResult(
      "escalated: posted to your topic and flagged as important in the VS Code panel. " +
        "The user answers by replying in your topic."
    );
  } catch (err) {
    const message = errorMessage(err);
    ctx.log?.(`escalate failed: ${message}`);
    return errorResult(`escalate failed: ${message}`);
  }
}

async function teamMessage(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { to, text } = argsOf(args);
  if (typeof to !== "string" || !to.trim()) {
    throw new Error("team_message requires 'to' (target session name)");
  }
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("team_message requires non-empty 'text'");
  }
  if (to === ctx.sessionName) {
    throw new Error("team_message: target equals current session — use reply instead");
  }

  try {
    await postToRouter(ctx, "/team-message", { from: ctx.sessionName, to, text });
    return textResult(`delivered to ${to}`);
  } catch (err) {
    const message = errorMessage(err);
    ctx.log?.(`team_message failed: ${message}`);
    return errorResult(`team_message failed: ${message}`);
  }
}

export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case "reply":
      return reply(args, ctx);
    case "ask":
      return ask(args, ctx);
    case "escalate":
      return escalate(args, ctx);
    case "team_message":
      return teamMessage(args, ctx);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

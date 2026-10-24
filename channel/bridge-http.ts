/**
 * Oh My Team — Bridge HTTP handler
 *
 * The bridge's HTTP surface (the router talks to it on 127.0.0.1), moved out
 * of bridge.ts so it can be tested without the MCP SDK. bridge.ts wires
 * makeBridgeFetch into Bun.serve.
 *
 * Routes:
 *   GET  /health               liveness + `auth` (this bridge sends and expects nonces)
 *   POST /verify-origin        the router asks: did this bridge issue that nonce?
 *   POST /message              inbound message, only when verifyDelivery passes
 *   POST /permission-response  permission answer, only when verifyDelivery passes
 */

import { AUTH_VERSION, NONCE_RE, NonceBook, verifyDelivery, type DeliveryDeps } from "./origin";

// ── Attachment formatting ──────────────────────────────────────────────────

interface ChannelAttachment {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  kind: string;
}

/**
 * Compose a channel message that makes attachments visible to the session.
 *
 * The user's original caption/text comes first. Below it we include a
 * structured block listing each file with its local path and metadata so
 * Claude can use the Read tool to view any that are relevant.
 *
 * The XML-ish tags are easy for the model to parse and unlikely to collide
 * with normal prose. We intentionally avoid putting raw paths on a bare
 * line so nothing looks like a command.
 */
export function formatContentWithAttachments(
  text: string,
  attachments: ChannelAttachment[]
): string {
  const lines: string[] = [];
  if (text) {
    lines.push(text);
    lines.push("");
  }
  lines.push(`<attachments count="${attachments.length}">`);
  for (const a of attachments) {
    lines.push(
      `  <file kind="${a.kind}" name="${escapeAttr(a.name)}" mime="${escapeAttr(a.mimeType)}" size="${a.size}" path="${escapeAttr(a.path)}" />`
    );
  }
  lines.push(`</attachments>`);
  lines.push("");
  lines.push(
    `(The user shared ${attachments.length === 1 ? "a file" : `${attachments.length} files`} — use the Read tool on any of the paths above to view the contents.)`
  );
  return lines.join("\n");
}

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Handler ────────────────────────────────────────────────────────────────

// A type alias, not an interface: the SDK's notification params have an
// index signature, which only object type aliases satisfy implicitly.
export type ChannelNotificationParams = {
  content: string;
  meta: { session: string; sender: string; sender_id: string; message_id: string; ts: string };
};

export interface BridgeHttpDeps {
  sessionName: string;
  /** Already routerLoopback'd by bridge.ts. */
  routerUrl: string;
  nonces: NonceBook;
  notify: (params: ChannelNotificationParams) => Promise<void>;
  notifyPermission: (params: { request_id: string; behavior: "allow" | "deny" }) => Promise<void>;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  after?: (ms: number) => Promise<"timeout">;
}

export function makeBridgeFetch(deps: BridgeHttpDeps): (req: Request) => Promise<Response> {
  const vdeps: DeliveryDeps = {
    routerUrl: deps.routerUrl,
    sessionName: deps.sessionName,
    fetchImpl: deps.fetchImpl,
    after: deps.after,
    log: deps.log,
  };
  const unverified = (what: string): Response => {
    deps.log(`${what}: delivery not verified`);
    return Response.json({ error: "delivery not verified" }, { status: 401 });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", session: deps.sessionName, auth: AUTH_VERSION });
    }

    // The router asks whether this bridge issued a nonce (one use).
    if (req.method === "POST" && url.pathname === "/verify-origin") {
      const body = (await req.json().catch(() => null)) as { nonce?: unknown } | null;
      const nonce = body?.nonce;
      const ok = typeof nonce === "string" && NONCE_RE.test(nonce) && deps.nonces.take(nonce) === deps.sessionName;
      return ok
        ? Response.json({ ok: true, session: deps.sessionName })
        : Response.json({ ok: false }, { status: 403 });
    }

    // Inbound message from router
    if (req.method === "POST" && url.pathname === "/message") {
      if (!(await verifyDelivery(req, vdeps))) return unverified("message");
      try {
        const body = await req.json();
        const { content, sender, senderId, messageId, timestamp, attachments } = body as {
          content: string;
          sender: string;
          senderId: string;
          messageId?: string;
          timestamp?: string;
          attachments?: Array<{
            path: string;
            name: string;
            mimeType: string;
            size: number;
            kind: string;
          }>;
        };

        const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
        const text = typeof content === "string" ? content : "";

        deps.log(`/message text=${text.length}b attachments=${hasAttachments ? attachments!.length : 0}`);

        // Require at least one of: text content or at least one attachment.
        // (Users can send photo-only messages with no caption.)
        if (!text && !hasAttachments) {
          return Response.json(
            { error: "content or attachments required" },
            { status: 400 }
          );
        }

        // Compose the channel content: original text first, then a structured
        // attachments block so Claude can Read the files directly.
        const finalContent = hasAttachments
          ? formatContentWithAttachments(text, attachments!)
          : text;

        try {
          // Note: we intentionally don't add attachment metadata to `meta` here —
          // Claude Code's channel notification schema appears to reject unknown
          // fields and close the MCP connection if they're present. The content
          // string already carries the <attachments> block so the model sees them.
          await deps.notify({
            content: finalContent,
            meta: {
              session: deps.sessionName,
              sender: sender || "unknown",
              sender_id: senderId || "",
              message_id: messageId || "",
              ts: timestamp || new Date().toISOString(),
            },
          });
          deps.log(`notification delivered`);
        } catch (notifyErr) {
          const m = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
          deps.log(`notification FAILED: ${m}`);
          throw notifyErr;
        }

        return Response.json({ status: "delivered" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log(`/message handler error: ${message}`);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    // Permission response from router (user replied yes/no)
    if (req.method === "POST" && url.pathname === "/permission-response") {
      if (!(await verifyDelivery(req, vdeps))) return unverified("permission-response");
      try {
        const body = await req.json();
        const { requestId, allow } = body as {
          requestId: string;
          allow: boolean;
        };

        await deps.notifyPermission({
          request_id: requestId,
          behavior: allow ? "allow" : "deny",
        });

        return Response.json({ status: "applied" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `omt-bridge: permission response failed: ${message}\n`
        );
        return Response.json({ error: message }, { status: 500 });
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  };
}

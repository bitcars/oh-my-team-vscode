/** Mirrors CtxQuotaWindow in channel/dashboard-server.ts. */
export type CtxQuotaWindow = { pct: number; resetsAt: string | null };

/** Mirrors CtxEntry in channel/dashboard-server.ts. */
export type CtxEntry = {
  ts: number;
  at: number;
  sid: string | null;
  model: string | null;
  tokens: number | null;
  window: number;
  pct: number | null;
  quota: { fiveHour: CtxQuotaWindow | null; sevenDay: CtxQuotaWindow | null } | null;
  agents: { running: number; alive: number } | null;
};

/**
 * Events pushed to dashboard clients over /ws/events. Mirrors the server's
 * DashboardEvent union in channel/dashboard-server.ts, plus a client-generated
 * `system.heartbeat` variant used to detect a stalled connection.
 */
export type DashboardEvent =
  | { type: "session.registered"; name: string; path: string; threadId: string; bridgePort: number; threadDisplayName: string; startedAt: string }
  | { type: "session.removed"; name: string }
  | { type: "session.status"; name: string; current: string | null; done: string[]; elapsedMs: number }
  | { type: "session.status.cleared"; name: string }
  | { type: "session.reply"; name: string; text: string; kind: "reply" | "escalate" | "team"; files?: string[]; ts: string; seq: number }
  | { type: "session.permission"; name: string; requestId: string; toolName: string; description: string; inputPreview: string; ts: string }
  | { type: "session.permission.resolved"; requestId: string }
  | { type: "session.ask"; name: string; token: string; question: string; options: string[]; ts: string }
  | { type: "session.ask.resolved"; name: string; token: string; choice: string }
  | { type: "session.ctx"; name: string; ctx: CtxEntry | null }
  | { type: "router.log"; line: string }
  | { type: "system.heartbeat"; ts: number };

export type EventType = DashboardEvent["type"];

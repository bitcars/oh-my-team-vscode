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
  | { type: "router.log"; line: string }
  | { type: "system.heartbeat"; ts: number };

export type EventType = DashboardEvent["type"];

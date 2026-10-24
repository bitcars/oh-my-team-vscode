/**
 * Oh My Team — sender binding for router ↔ bridge traffic (fork #56)
 *
 * A team-message's `from`, and every other identity a bridge claims, used to
 * be a body field any local process could set. Both legs now carry a one-use
 * nonce in the x-omt-nonce header, and the receiver calls the sender back on
 * its own registered 127.0.0.1 port to confirm it issued that nonce:
 *   bridge → router: the router asks the claimed session's bridge
 *                    (POST /verify-origin).
 *   router → bridge: the bridge asks its router (POST /verify-delivery).
 * Nothing is stored on disk or in env. The trust anchor is "the process on
 * 127.0.0.1:<registered port> is that session" (docs/omtv.md, Trust boundary).
 *
 * A peer without the header is a legacy (pre-#56) peer only if its /health
 * answers 200 with no `auth` field; any doubt fails closed.
 *
 * SDK-free on purpose, so tests import it directly.
 */

export const NONCE_HEADER = "x-omt-nonce";
export const NONCE_RE = /^[0-9a-f]{32}$/;
export const NONCE_TTL_MS = 10000;
export const NONCE_MAX_PENDING = 1024;
export const PROBE_TIMEOUT_MS = 1500;
export const BODY_CAP_BYTES = 65536;
export const TOMBSTONE_MAX = 1024;
export const AUTH_VERSION = 1;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// ── Nonces ─────────────────────────────────────────────────────────────────

export function isFresh(at: number, now: number): boolean {
  return now - at <= NONCE_TTL_MS;
}

function randomHex16(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One-use nonces with a TTL and a cap; insertion order is age order. */
export class NonceBook {
  private readonly entries = new Map<string, { session: string; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(session: string): string {
    const t = this.now();
    for (const [k, e] of this.entries) if (!isFresh(e.at, t)) this.entries.delete(k);
    while (this.entries.size >= NONCE_MAX_PENDING) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    const nonce = randomHex16();
    this.entries.set(nonce, { session, at: t });
    return nonce;
  }

  take(nonce: string): string | undefined {
    const e = this.entries.get(nonce);
    this.entries.delete(nonce);
    if (!e || !isFresh(e.at, this.now())) return undefined;
    return e.session;
  }

  get size(): number {
    return this.entries.size;
  }

  has(nonce: string): boolean {
    return this.entries.has(nonce);
  }
}

// ── Escapers, names, ports, URLs ───────────────────────────────────────────

export function escapeFraming(text: string): string {
  return text.replace(/<(\/?)(team-message|ask-answer)/gi, "‹$1$2");
}

export function escapeName(s: string): string {
  return s.replace(/"/g, "'").replace(/[\r\n]+/g, " ").replace(/</g, "‹").replace(/>/g, "›");
}

export function validName(s: unknown): boolean {
  return typeof s === "string" && NAME_RE.test(s) && (s.toLowerCase() !== "hub" || s === "hub");
}

export function validPort(p: unknown, routerPort: number): boolean {
  return typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535 && p !== routerPort;
}

export function loopbackUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

export function routerLoopback(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return `http://127.0.0.1:${u.port || "80"}`;
  return url;
}

// ── Bounded calls ──────────────────────────────────────────────────────────

export type BoundedResult =
  | { kind: "ok"; status: number; body: Record<string, unknown> }
  | { kind: "fail"; why: "redirect" | "cap" | "body" | "network" | "timeout" };

export interface OriginDeps {
  fetchImpl?: typeof fetch;
  after?: (ms: number) => Promise<"timeout">;
  log?: (line: string) => void;
}

const defaultAfter = (ms: number): Promise<"timeout"> => Bun.sleep(ms).then(() => "timeout" as const);

export async function readJsonCapped(res: Response): Promise<Record<string, unknown> | "cap" | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_CAP_BYTES) { await reader.cancel().catch(() => {}); return "cap"; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function readResult(res: Response): Promise<BoundedResult> {
  const body = await readJsonCapped(res);
  if (body === "cap") return { kind: "fail", why: "cap" };
  if (body === undefined) return { kind: "fail", why: "body" };
  return { kind: "ok", status: res.status, body };
}

/** One request, body included, bounded by PROBE_TIMEOUT_MS; never throws. */
export async function boundedFetch(url: string, init: RequestInit, deps: OriginDeps): Promise<BoundedResult> {
  const controller = new AbortController();
  const work = (async (): Promise<BoundedResult> => {
    const res = await (deps.fetchImpl ?? fetch)(url, { ...init, redirect: "manual", signal: controller.signal });
    if (res.status >= 300 && res.status < 400) return { kind: "fail", why: "redirect" };
    return readResult(res);
  })().catch((): BoundedResult => ({ kind: "fail", why: "network" }));
  const winner = await Promise.race([work, (deps.after ?? defaultAfter)(PROBE_TIMEOUT_MS)]);
  if (winner === "timeout") { controller.abort(); return { kind: "fail", why: "timeout" }; }
  return winner;
}

export function probeHealth(baseUrl: string, deps: OriginDeps): Promise<BoundedResult> {
  return boundedFetch(`${baseUrl}/health`, { method: "GET" }, deps);
}

// ── Router side: is this request really from the session it names? ─────────

export type OriginResult = { ok: true; verified: boolean } | { ok: false; why: string };

export type RouterOriginDeps = OriginDeps & { log: (line: string) => void };

export async function verifyOrigin(route: string, name: string, entry: { bridgePort: number }, req: Request, deps: RouterOriginDeps): Promise<OriginResult> {
  const deny = (why: string): OriginResult => ({ ok: false, why });
  const nonce = req.headers.get(NONCE_HEADER);
  if (nonce !== null) {
    if (!NONCE_RE.test(nonce)) return deny("malformed nonce");
    const r = await boundedFetch(loopbackUrl(entry.bridgePort, "/verify-origin"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce }) }, deps);
    if (r.kind === "ok" && r.status === 200 && r.body.ok === true && r.body.session === name) return { ok: true, verified: true };
    return deny("verify-origin refused");
  }
  const probe = await probeHealth(loopbackUrl(entry.bridgePort, ""), deps);
  if (probe.kind !== "ok" || probe.status !== 200) return deny("health probe failed");
  if (Object.hasOwn(probe.body, "auth")) return deny("new bridge sent no nonce");
  if (Object.hasOwn(probe.body, "session") && probe.body.session !== name) return deny("health session mismatch");
  deps.log(`omt-router: ${route} from "${name}" unverified (legacy bridge)`);
  return { ok: true, verified: false };
}

// ── Bridge side: did our router really send this delivery? ─────────────────

export interface DeliveryDeps extends OriginDeps {
  routerUrl: string;
  sessionName: string;
}

export async function verifyDelivery(req: Request, deps: DeliveryDeps): Promise<boolean> {
  const refuse = (why: string): boolean => { deps.log?.(`delivery refused: ${why}`); return false; };
  const nonce = req.headers.get(NONCE_HEADER);
  if (nonce !== null) {
    if (!NONCE_RE.test(nonce)) return refuse("malformed nonce");
    const r = await boundedFetch(`${deps.routerUrl}/verify-delivery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce, session: deps.sessionName }) }, deps);
    if (r.kind === "ok" && r.status === 200 && r.body.ok === true) return true;
    return refuse("router refused");
  }
  const probe = await probeHealth(deps.routerUrl, deps);
  if (probe.kind !== "ok" || probe.status !== 200) return refuse("router probe failed");
  if (Object.hasOwn(probe.body, "auth")) return refuse("router expects nonces");
  return true;
}

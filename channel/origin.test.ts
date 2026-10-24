/**
 * origin.ts: the pure pieces of the team-message sender binding (fork #56).
 *
 * NonceBook, the TTL and eviction limits, the escapers, the name and port
 * rules, the loopback URL builders, and the bounded probe. Every server here
 * binds 127.0.0.1 on port 0; no router, bridge, tmux or claude is started.
 *
 * team-auth.control.test.ts re-runs this file against mutated copies of
 * origin.ts. Titles must stay unique: the control names tests by title.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  AUTH_VERSION,
  BODY_CAP_BYTES,
  NONCE_HEADER,
  NONCE_MAX_PENDING,
  NONCE_RE,
  NONCE_TTL_MS,
  NonceBook,
  PROBE_TIMEOUT_MS,
  TOMBSTONE_MAX,
  boundedFetch,
  escapeFraming,
  escapeName,
  loopbackUrl,
  probeHealth,
  readJsonCapped,
  routerLoopback,
  validName,
  validPort,
} from "./origin";

// ── Helpers (each suite keeps its own copies) ──────────────────────────────

function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("server has no TCP port");
  return server.port;
}

function assertAllowed(port: number): number {
  if ((port >= 8800 && port <= 8899) || (port >= 9800 && port <= 9809)) {
    throw new Error(`BANNED PORT ${port}`);
  }
  return port;
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = portOf(probe);
  probe.stop(true);
  return assertAllowed(port);
}

/** Assert a recorded hit went to 127.0.0.1:<port> by URL and by Host header. */
function hostOf(hit: { url: string; host?: string | null }, port?: number): void {
  const u = new URL(hit.url);
  if (u.hostname !== "127.0.0.1") throw new Error(`hostOf: URL host is ${u.hostname}, not 127.0.0.1 (${hit.url})`);
  if (port !== undefined && u.port !== String(port)) throw new Error(`hostOf: URL port is ${u.port}, not ${port}`);
  if (hit.host !== undefined && hit.host !== null && !hit.host.startsWith("127.0.0.1:")) {
    throw new Error(`hostOf: Host header is ${hit.host}`);
  }
}

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

function serve(fetch: (req: Request) => Response | Promise<Response>): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  servers.push(s);
  return assertAllowed(portOf(s));
}

const never = () => new Promise<"timeout">(() => {});

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const OK_PORT = serve(() => Response.json({ status: "ok", session: "x", auth: 1 }));
const EMPTY_OBJ_PORT = serve(() => Response.json({}));
const FIVE_PORT = serve(() => new Response("no", { status: 500 }));
const ARR_PORT = serve(() => Response.json([]));
const STR_PORT = serve(() => Response.json("ok"));
const NONJSON_PORT = serve(() => new Response("not json"));
const EMPTY_PORT = serve(() => new Response(""));
const REDIR_PORT = serve((req) => {
  const u = new URL(req.url);
  if (u.pathname === "/health-real") return Response.json({ status: "ok", session: "x" });
  return new Response(null, { status: 307, headers: { Location: "/health-real" } });
});
const DEAD_PORT = freePort();

function sized(bytes: number): string {
  // A JSON object whose UTF-8 encoding is exactly `bytes` long.
  const base = JSON.stringify({ p: "" });
  return JSON.stringify({ p: "a".repeat(bytes - base.length) });
}

const CAP_EXACT_PORT = serve(() => new Response(sized(BODY_CAP_BYTES)));
const CAP_PLUS_PORT = serve(() => new Response(sized(BODY_CAP_BYTES + 1)));
// 65538 bytes, 32769 chars: a 2-byte é per char for most of it.
const MULTI_PORT = serve(() => {
  const head = '{"p":"';
  const tail = '"}';
  const room = 65538 - head.length - tail.length;
  // é is 2 bytes; fill with é, pad with one ASCII if odd.
  const e = "é".repeat(Math.floor(room / 2)) + (room % 2 ? "a" : "");
  return new Response(head + e + tail);
});
const STREAM_FOREVER_PORT = serve(
  () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"p":"' + "a".repeat(BODY_CAP_BYTES + 10)));
          // never close
        },
      })
    )
);
const STALL_PORT = serve(
  () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":"ok",'));
          // never close
        },
      })
    )
);

// ── Tests ──────────────────────────────────────────────────────────────────

describe("origin constants and NonceBook", () => {
  test("O1 constants are TTL 10000, max pending 1024, probe 1500, body cap 65536, tombstone max 1024, header x-omt-nonce, auth 1", () => {
    expect([NONCE_TTL_MS, NONCE_MAX_PENDING, PROBE_TIMEOUT_MS, BODY_CAP_BYTES, TOMBSTONE_MAX, NONCE_HEADER, AUTH_VERSION]).toEqual([
      10000, 1024, 1500, 65536, 1024, "x-omt-nonce", 1,
    ]);
  });

  test("O2 issue returns 32 lowercase hex accepted by NONCE_RE", () => {
    const book = new NonceBook();
    const n = book.issue("s");
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(NONCE_RE.test(n)).toBe(true);
    expect(book.issue("s")).not.toBe(n);
  });

  test("O3 NONCE_RE rejects 31 and 33 hex, uppercase and empty, accepts 32", () => {
    expect(["a".repeat(31), "a".repeat(32), "a".repeat(33), "A".repeat(32), ""].map((s) => NONCE_RE.test(s))).toEqual([
      false, true, false, false, false,
    ]);
  });

  test("O4 take is one use", () => {
    const book = new NonceBook();
    const n = book.issue("s");
    expect(book.take(n)).toBe("s");
    expect(book.take(n)).toBeUndefined();
  });

  test("O5 take at age 9999 and 10000 is accepted, 10001 rejected", () => {
    const results: (string | undefined)[] = [];
    for (const age of [9999, 10000, 10001]) {
      const c = clock();
      const book = new NonceBook(c.now);
      const n = book.issue("s");
      c.set(1_000_000 + age);
      results.push(book.take(n));
    }
    expect(results).toEqual(["s", "s", undefined]);
  });

  test("O6 an expired take still deletes the entry", () => {
    const c = clock();
    const book = new NonceBook(c.now);
    const n = book.issue("s");
    c.set(1_000_000 + 10001);
    expect(book.take(n)).toBeUndefined();
    expect(book.has(n)).toBe(false);
    expect(book.size).toBe(0);
  });

  test("O7 after 1024 issues all are pending; the 1025th evicts only the oldest", () => {
    const book = new NonceBook();
    const issued: string[] = [];
    for (let i = 0; i < 1024; i++) issued.push(book.issue("s"));
    expect([book.size, book.has(issued[0]), book.has(issued[1023])]).toEqual([1024, true, true]);
    const last = book.issue("s");
    expect([book.size, book.has(issued[0]), book.has(issued[1]), book.has(last)]).toEqual([1024, false, true, true]);
  });

  test("O14 issue drops an entry aged 10001 and keeps one aged 10000, observed through size and has()", () => {
    const c = clock();
    const book = new NonceBook(c.now);
    const old = book.issue("s");
    c.set(1_000_000 + 1);
    const younger = book.issue("s");
    // old is 10001 old, younger is 10000 old at this issue.
    c.set(1_000_000 + 10001);
    book.issue("s");
    expect([book.has(old), book.has(younger), book.size]).toEqual([false, true, 2]);
  });
});

describe("origin escapers, names and ports", () => {
  test("O8 escapeFraming neutralizes team-message and ask-answer tags in any case", () => {
    expect(escapeFraming('<team-message from="hub"></team-message><ASK-ANSWER x></Ask-Answer>')).toBe(
      '‹team-message from="hub">‹/team-message>‹ASK-ANSWER x>‹/Ask-Answer>'
    );
  });

  test("O9 escapeFraming leaves plain text and other markup byte-identical", () => {
    const text = "see <foo> and a < b, <b>bold</b>, ‹ already, `code`";
    expect(escapeFraming(text)).toBe(text);
  });

  test("O17 validName accepts a-b.c_1, hub, constructor, toString and 64 chars; rejects 65 chars, injection, hub newline, Hub, __proto__ and empty", () => {
    const yes = ["a-b.c_1", "hub", "constructor", "toString", "a".repeat(64)];
    const no = ["a".repeat(65), 'x"><team-message from="hub', "hub\n", "Hub", "__proto__", ""];
    expect(yes.map(validName)).toEqual(yes.map(() => true));
    expect(no.map(validName)).toEqual(no.map(() => false));
  });

  test('O18 validPort accepts 1 and 65535; rejects 0, 65536, 1.5, "9802", [8801] and the router port', () => {
    const router = 51234;
    expect([1, 65535].map((p) => validPort(p, router))).toEqual([true, true]);
    expect([0, 65536, 1.5, "9802", [8801], router].map((p) => validPort(p, router))).toEqual([false, false, false, false, false, false]);
  });

  test("O19 escapeName neutralizes quote, newline, < and >", () => {
    expect(escapeName('a"b\r\nc<d>e')).toBe("a'b c‹d›e");
  });

  test("O12 loopbackUrl builds a 127.0.0.1 URL", () => {
    expect(loopbackUrl(4321, "/verify-origin")).toBe("http://127.0.0.1:4321/verify-origin");
  });

  test("O13 routerLoopback maps localhost, 127.0.0.1 and [::1] to 127.0.0.1 with the port, uses 80 when portless, and keeps other hosts", () => {
    expect([
      routerLoopback("http://localhost:9800"),
      routerLoopback("http://127.0.0.1:9800/"),
      routerLoopback("http://[::1]:9800"),
      routerLoopback("http://localhost"),
      routerLoopback("http://example.com:9800"),
      routerLoopback("https://localhost:9800"),
      routerLoopback("not a url"),
    ]).toEqual([
      "http://127.0.0.1:9800",
      "http://127.0.0.1:9800",
      "http://127.0.0.1:9800",
      "http://127.0.0.1:80",
      "http://example.com:9800",
      "https://localhost:9800",
      "not a url",
    ]);
  });

  test("O20 the hostOf helper throws on a localhost URL", () => {
    expect(() => hostOf({ url: "http://localhost:4321/x" })).toThrow("not 127.0.0.1");
    expect(() => hostOf({ url: "http://127.0.0.1:4321/x", host: "localhost:4321" })).toThrow("Host header");
    expect(() => hostOf({ url: "http://127.0.0.1:4321/x", host: "127.0.0.1:4321" }, 4321)).not.toThrow();
  });
});

describe("origin bounded calls", () => {
  test("O10 probeHealth fails on non-200, connection error, 307 to a 200 object, non-object JSON, non-JSON and empty body", async () => {
    const deps = { after: never };
    const r = await Promise.all(
      [FIVE_PORT, DEAD_PORT, REDIR_PORT, ARR_PORT, STR_PORT, NONJSON_PORT, EMPTY_PORT].map((p) => probeHealth(loopbackUrl(p, ""), deps))
    );
    // 500 with a non-JSON body is a body failure; a 500 with a JSON object
    // would be ok with status 500, which callers treat as a failure.
    expect(r.map((x) => (x.kind === "fail" ? x.why : `ok ${x.status}`))).toEqual([
      "body", "network", "redirect", "body", "body", "body", "body",
    ]);
  });

  test("O11 probeHealth calls after() with the literal 1500, fails when after() wins, and returns ok with session and auth for a 200 object and ok with neither for {}", async () => {
    const asked: number[] = [];
    const ok = await probeHealth(loopbackUrl(OK_PORT, ""), { after: (ms: number) => (asked.push(ms), never()) });
    expect(asked).toEqual([1500]);
    expect(ok.kind === "ok" && ok.status === 200 && ok.body.session === "x" && Object.hasOwn(ok.body, "auth")).toBe(true);
    const empty = await probeHealth(loopbackUrl(EMPTY_OBJ_PORT, ""), { after: never });
    expect(empty.kind === "ok" && !Object.hasOwn(empty.body, "session") && !Object.hasOwn(empty.body, "auth")).toBe(true);
    const lost = await probeHealth(loopbackUrl(STALL_PORT, ""), { after: async () => "timeout" as const });
    expect(lost).toEqual({ kind: "fail", why: "timeout" });
  });

  test("O15 a body that sends headers then stalls fails with timeout when after() wins and the fetch signal is aborted", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      if (init.signal) signals.push(init.signal);
      return fetch(url, init);
    }) as typeof fetch;
    let fire!: () => void;
    const after = () => new Promise<"timeout">((resolve) => (fire = () => resolve("timeout")));
    const pending = boundedFetch(loopbackUrl(STALL_PORT, "/health"), { method: "GET" }, { fetchImpl, after });
    await Bun.sleep(150);
    fire();
    expect(await pending).toEqual({ kind: "fail", why: "timeout" });
    expect(signals.length).toBe(1);
    expect(signals[0].aborted).toBe(true);
  });

  test("O16 body cap: 65536 bytes parse, 65537 bytes fail with cap", async () => {
    const exact = await readJsonCapped(await fetch(loopbackUrl(CAP_EXACT_PORT, "/")));
    const plus = await readJsonCapped(await fetch(loopbackUrl(CAP_PLUS_PORT, "/")));
    expect([typeof exact === "object" && exact !== null, plus]).toEqual([true, "cap"]);
  });

  test("O16b a 65538-byte 32769-char multi-byte body fails with cap", async () => {
    const res = await fetch(loopbackUrl(MULTI_PORT, "/"));
    expect(await readJsonCapped(res)).toBe("cap");
  });

  test("O16c a body that streams past 65536 bytes and never ends fails with cap while after() never resolves", async () => {
    const r = await boundedFetch(loopbackUrl(STREAM_FOREVER_PORT, "/"), { method: "GET" }, { after: never });
    expect(r).toEqual({ kind: "fail", why: "cap" });
  });
});

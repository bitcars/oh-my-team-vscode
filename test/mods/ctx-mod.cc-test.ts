// Kit tests for hooks/ctx-mod.js, run by `claude plugin test` (Claude Code's
// mod test kit), never by bun: bun ignores this file name. test/ctx-mod.test.ts
// copies this file and the mod into a temp plugin, runs the kit sandboxed, and
// turns each title below into one bun test. Keep every title in that file's
// TITLES list, and keep titles unique: the removal control names them.
import { expect, mock, test } from 'claude-code/testing'

const ROUTER = 'http://127.0.0.1:1' // a port nothing listens on; an unhooked fetch throws in the kit anyway
const ENV = { SESSION_NAME: 'lab1', ROUTER_URL: ROUTER }
const U = {
  startedAt: 1,
  context: { tokens: 36299, window: 1_000_000, percent: 4 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 7, resetsAt: '2026-10-05T00:20:00.000Z' },
    { kind: 'seven_day', percentUsed: 11.5, resetsAt: '2026-10-08T06:00:00.000Z' },
    { kind: 'spend_limit', percentUsed: 50 },
  ],
  cost: { usd: 0.3 },
}
const KEPT = [{ role: 'user', text: 'summary of the conversation so far', toolUses: [] }]
const OK = { value: { status: 200, ok: true, headers: {}, text: '{}' } }
const NEVER = () => new Promise(() => {})

type Post = { url: string; body: Record<string, any> }
/** usage / list: a value to answer with, or a hook (e.g. NEVER) to answer instead. */
type Opts = { env?: Record<string, string>; usage?: unknown; list?: unknown; fetch?: (url: string) => unknown }
const logs: string[] = [] // $.ui.log lines, per test (cleared by setup)

/** The world beneath the mod: env, clock, usage, session id, agent list, a
 *  recording fetch, and valid bottom results for every event the mod hooks. */
function setup(on: any, o: Opts = {}) {
  const clock = mock.clock(on)
  const box = {
    env: { ...(o.env ?? ENV) } as Record<string, string>,
    usage: o.usage ?? U,
    step: stepResult(0, null),
    compact: { messages: KEPT } as unknown,
  }
  const posts: Post[] = []
  logs.length = 0
  on('ui.log', async (_$: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('env.get', async (_$: any, e: any) => ({ value: box.env[e.name] }))
  on('session.usage', typeof o.usage === 'function' ? o.usage : async () => ({ value: box.usage }))
  on('session.id', async () => ({ value: 'sid-1' }))
  on('agent.list', typeof o.list === 'function' ? o.list : async () => ({ value: o.list ?? [] }))
  on('http.fetch', async (_$: any, e: any) => {
    posts.push({ url: e.url, body: JSON.parse(String(e.init && e.init.body)) })
    return o.fetch ? o.fetch(e.url) : OK
  })
  on('session.measure', async (_$: any, e: any) => ({ changed: e.changed }))
  on('turn.complete', async () => ({ text: '' }))
  on('session.end', async () => ({ sessionId: 'sid-1' }))
  on('session.compact', async () => box.compact)
  on('turn.step', async function* () {
    return box.step
  })
  return { clock, posts, box }
}

function stepResult(index: number, usage: unknown) {
  return { turnId: 't1', index, answer: 'a-' + index, toolUses: [], stopReason: 'end_turn', usage }
}
const usage = (input: number, cr: number, cc: number, model: string, output = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cc,
  model,
})
const measureInput = (tokens: number | null, rateLimits: unknown = U.rateLimits) => ({
  context: tokens === null ? { window: 1_000_000 } : { tokens, window: 1_000_000, percent: 0 },
  rateLimits,
  changed: ['context'],
})

async function runStep($: any, e: Record<string, unknown> = {}) {
  const st = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...e })
  let it = await st.next()
  while (!it.done) it = await st.next()
  return it.value // the step's result: what the chain returned
}
const complete = ($: any) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
const end = ($: any, reason: string) => $.session.end({ reason, sessionId: 'sid-1', resume: {} })
const compact = ($: any, e: Record<string, unknown>) => $.session.compact({ trigger: 'manual', messages: KEPT, ...e })
/** Spin until Date.now() moves on (the kit has no timers). */
function nextMs() {
  const t = Date.now()
  while (Date.now() === t) {
    // spin
  }
}

// ── M1 gate ────────────────────────────────────────────────────────────────

test('M1a no SESSION_NAME and no ROUTER_URL: no post', async ($, on) => {
  const { clock, posts } = setup(on, { env: {} })
  await $.session.measure(measureInput(5))
  await clock.settle()
  expect(posts.length).toBe(0)
})

test('M1b a non-local ROUTER_URL: no post', async ($, on) => {
  const { clock, posts } = setup(on, { env: { SESSION_NAME: 'lab1', ROUTER_URL: 'http://evil.example:80' } })
  await $.session.measure(measureInput(5))
  await clock.settle()
  expect(posts.length).toBe(0)
})

test('M1c ROUTER_URL without SESSION_NAME: no post', async ($, on) => {
  const { clock, posts } = setup(on, { env: { ROUTER_URL: ROUTER } })
  await $.session.measure(measureInput(5))
  await clock.settle()
  expect(posts.length).toBe(0)
})

test('M1d a teammate process (CLAUDE_CODE_TEAMMATE) never posts', async ($, on) => {
  const { clock, posts } = setup(on, { env: { ...ENV, CLAUDE_CODE_TEAMMATE: '1' } })
  await $.session.measure(measureInput(5))
  await clock.settle()
  expect(posts.length).toBe(0)
})

test('M1e only http on localhost/127.0.0.1 with an explicit port and no path counts as local', async ($, on) => {
  const { clock, posts, box } = setup(on)
  const refused = [
    'http://localhost.evil.example:80',
    'http://127.0.0.1.evil:1',
    'https://localhost:1',
    'http://localhost:1/x',
    'http://u:p@localhost:1',
    'http://localhost:1/?q',
    'http://localhost:1/#x',
    'http://localhost:80',
    '',
  ]
  const leaked: string[] = []
  for (const url of refused) {
    box.env.ROUTER_URL = url
    const before = posts.length
    await $.session.measure(measureInput(posts.length + 100))
    await clock.settle()
    if (posts.length !== before) leaked.push(url)
  }
  expect(leaked).toEqual([])
})

test('M1f SESSION_NAME plus a local ROUTER_URL posts once to <router>/ctx', async ($, on) => {
  const { clock, posts } = setup(on, { env: { SESSION_NAME: 'lab1', ROUTER_URL: 'http://localhost:1/' } })
  await $.session.measure(measureInput(5))
  await clock.settle()
  expect(posts.map((p) => [p.url, p.body.session])).toEqual([['http://localhost:1/ctx', 'lab1']])
})

// ── M2-M4 tokens and model ─────────────────────────────────────────────────

test('M2 tokens = input + cache_read + cache_creation of the main step; output never counts', async ($, on) => {
  const { clock, posts, box } = setup(on)
  box.step = stepResult(0, usage(2, 36082, 215, 'claude-opus-5-5', 74))
  await runStep($)
  await clock.settle()
  expect(posts.map((p) => p.body.ctx)).toEqual([{ tokens: 36299, window: 1_000_000 }])
})

test("M3 a subagent's step reports the lead's context and keeps the model", async ($, on) => {
  const { clock, posts, box } = setup(on)
  box.step = stepResult(0, usage(5, 20000, 495, 'claude-haiku-4-5'))
  await runStep($, { agentId: 'a1', model: 'claude-haiku-4-5' })
  await clock.settle()
  expect(posts.map((p) => [p.body.ctx.tokens, p.body.model])).toEqual([[36299, null]])
})

test("M4 model comes from the main step's result.usage.model, never session.model", async ($, on) => {
  const { clock, posts, box } = setup(on)
  on('session.model', async () => ({ value: 'registry-x' }))
  box.step = stepResult(0, usage(1, 1, 1, 'claude-sonnet-5-5'))
  await runStep($, { model: 'claude-sonnet-5-5' })
  await clock.settle()
  expect(posts.map((p) => p.body.model)).toEqual(['claude-sonnet-5-5'])
})

// ── M5-M6 clear, dedupe, end ───────────────────────────────────────────────

test('M5 /clear posts tokens 0, not the stale usage() of the ended conversation', async ($, on) => {
  const { clock, posts } = setup(on, { usage: { ...U, context: { tokens: 33890, window: 1_000_000, percent: 3 } } })
  await end($, 'clear')
  await clock.settle()
  expect(posts.map((p) => p.body.ctx.tokens)).toEqual([0])
})

test('M6a an unchanged report is not sent twice, even a millisecond later', async ($, on) => {
  const { clock, posts } = setup(on)
  await $.session.measure(measureInput(5))
  await clock.settle()
  nextMs()
  await $.session.measure(measureInput(5))
  await clock.settle()
  expect(posts.length).toBe(1)
})

test('M6b every /clear posts, even when the report is unchanged', async ($, on) => {
  const { clock, posts } = setup(on)
  await end($, 'clear')
  await clock.settle()
  await end($, 'clear')
  await clock.settle()
  expect(posts.map((p) => p.body.ctx.tokens)).toEqual([0, 0])
})

test('M6c session end for exit or other reasons posts nothing', async ($, on) => {
  const { clock, posts } = setup(on)
  await end($, 'prompt_input_exit')
  await end($, 'other')
  await end($, 'logout')
  await clock.settle()
  expect(posts.length).toBe(0)
})

test('M6d /resume posts tokens null', async ($, on) => {
  const { clock, posts } = setup(on)
  await end($, 'resume')
  await clock.settle()
  expect(posts.map((p) => p.body.ctx.tokens)).toEqual([null])
})

// ── M7 compaction ──────────────────────────────────────────────────────────

test('M7a a manual main-conversation compaction posts tokens null after it ran', async ($, on) => {
  const { clock, posts } = setup(on)
  await compact($, { trigger: 'manual' })
  await clock.settle()
  expect(posts.map((p) => p.body.ctx.tokens)).toEqual([null])
})

test("M7b a subagent's own compaction posts nothing", async ($, on) => {
  const { clock, posts } = setup(on)
  await compact($, { trigger: 'auto', agentId: 'a1' })
  await clock.settle()
  expect(posts.length).toBe(0)
})

test('M7c a precompute compaction posts nothing', async ($, on) => {
  const { clock, posts } = setup(on)
  await compact($, { trigger: 'precompute' })
  await clock.settle()
  expect(posts.length).toBe(0)
})

test('M7d a vetoed compaction posts nothing', async ($, on) => {
  const { clock, posts, box } = setup(on)
  box.compact = { skip: 'vetoed' }
  await compact($, { trigger: 'manual' })
  await clock.settle()
  expect(posts.length).toBe(0)
})

// ── M8-M11 agents, quota, wire ─────────────────────────────────────────────

test('M8 running = pending + running + waiting; alive = running + idle', async ($, on) => {
  const statuses = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed']
  const { clock, posts } = setup(on, { list: statuses.map((status, i) => ({ id: 'a' + i, type: 'general-purpose', status })) })
  await $.session.measure(measureInput(5))
  await clock.settle()
  expect(posts.map((p) => p.body.agents)).toEqual([{ running: 3, alive: 4 }])
})

test('M9a quota maps five_hour and seven_day only; an empty list gives two nulls', async ($, on) => {
  const { clock, posts } = setup(on)
  await $.session.measure(measureInput(5))
  await clock.settle()
  await $.session.measure(measureInput(5, []))
  await clock.settle()
  expect(posts.map((p) => p.body.quota)).toEqual([
    {
      fiveHour: { pct: 7, resetsAt: '2026-10-05T00:20:00.000Z' },
      sevenDay: { pct: 11.5, resetsAt: '2026-10-08T06:00:00.000Z' },
    },
    { fiveHour: null, sevenDay: null },
  ])
})

test('M9b no rateLimits at all: quota null and the report still goes out', async ($, on) => {
  const { clock, posts } = setup(on, { usage: { startedAt: 1, context: { tokens: 9, window: 1_000_000, percent: 0 } } })
  await complete($)
  await clock.settle()
  expect(posts.map((p) => [p.body.quota, p.body.ctx.tokens])).toEqual([[null, 9]])
})

test('M10 the wire carries exactly session, sid, at, model, ctx{tokens, window}, quota, agents', async ($, on) => {
  const { clock, posts } = setup(on)
  await $.session.measure(measureInput(5))
  await clock.settle()
  expect(posts.length).toBe(1)
  expect(Object.keys(posts[0].body).sort()).toEqual(['agents', 'at', 'ctx', 'model', 'quota', 'session', 'sid'])
  expect(Object.keys(posts[0].body.ctx).sort()).toEqual(['tokens', 'window'])
  expect(posts[0].body.sid).toBe('sid-1')
})

test('M11 an agent list that is refused gives agents null; the report still goes out', async ($, on) => {
  const { clock, posts } = setup(on, { list: async () => ({ deny: 'not available in this mode' }) })
  await $.session.measure(measureInput(5))
  await clock.settle()
  expect(posts.map((p) => [p.body.agents, p.body.ctx.tokens])).toEqual([[null, 5]])
})

// ── M12-M14 never block a turn ─────────────────────────────────────────────

test('M12a a hung agent list holds turn.step for 150 ms of hook time, then the result passes through', async ($, on) => {
  const { clock, box } = setup(on, { list: NEVER })
  box.step = stepResult(0, usage(1, 1, 1, 'claude-opus-5-5'))
  let done = false
  const p = runStep($).then((r: any) => {
    done = true
    return r
  })
  await clock.settle()
  const atStart = done
  await clock.advance(149)
  const at149 = done
  await clock.advance(1)
  const r = await p
  expect([atStart, at149, r.answer]).toEqual([false, false, 'a-0'])
})

test('M12b a hung usage() holds turn.complete for 150 ms of hook time, no more', async ($, on) => {
  const { clock } = setup(on, { usage: NEVER })
  let done = false
  const p = complete($).then(() => {
    done = true
  })
  await clock.settle()
  const atStart = done
  await clock.advance(150)
  await p
  expect([atStart, done]).toEqual([false, true])
})

test('M13 a POST that never settles holds no hook: step, measure and clear all return at once', async ($, on) => {
  const { clock, posts, box } = setup(on, { fetch: NEVER })
  box.step = stepResult(0, usage(1, 1, 1, 'claude-opus-5-5'))
  const flags = { step: false, measure: false, clear: false }
  const ps = [
    runStep($).then((r: any) => {
      flags.step = r.answer === 'a-0'
    }),
    $.session.measure(measureInput(5)).then(() => {
      flags.measure = true
    }),
    end($, 'clear').then(() => {
      flags.clear = true
    }),
  ]
  await clock.settle()
  expect([flags, posts.length]).toEqual([{ step: true, measure: true, clear: true }, 3])
  await Promise.all(ps)
})

test('M14a at most 4 POSTs are in flight', async ($, on) => {
  const { clock, posts } = setup(on, { fetch: NEVER })
  for (let i = 1; i <= 6; i++) {
    await $.session.measure(measureInput(i))
    await clock.settle()
  }
  expect(posts.map((p) => p.body.ctx.tokens)).toEqual([1, 2, 3, 4])
})

test('M14b a report skipped at the cap is sent by the next event once a slot frees', async ($, on) => {
  const release: (() => void)[] = []
  const { clock, posts } = setup(on, {
    fetch: () =>
      new Promise((resolve) => {
        release.push(() => resolve(OK))
      }),
  })
  for (let i = 1; i <= 6; i++) {
    await $.session.measure(measureInput(i))
    await clock.settle()
  }
  const capped = posts.length
  for (const r of release.splice(0)) r()
  await clock.settle()
  await $.session.measure(measureInput(6))
  await clock.settle()
  expect([capped, posts.map((p) => p.body.ctx.tokens)]).toEqual([4, [1, 2, 3, 4, 6]])
})

test('M14c a refused POST frees its slot: six refused POSTs all go out', async ($, on) => {
  const { clock, posts } = setup(on, { fetch: async () => ({ deny: 'connection refused' }) })
  for (let i = 1; i <= 6; i++) {
    await $.session.measure(measureInput(i))
    await clock.settle()
  }
  expect(posts.map((p) => p.body.ctx.tokens)).toEqual([1, 2, 3, 4, 5, 6])
})

test('M17 a report the router refuses is logged once, not swallowed', async ($, on) => {
  const { clock, posts } = setup(on, { fetch: () => ({ value: { status: 400, ok: false, headers: {}, text: '{}' } }) })
  await $.session.measure(measureInput(5))
  await clock.settle()
  await $.session.measure(measureInput(6))
  await clock.settle()
  expect([posts.length, logs]).toEqual([2, ['ctx-mod: router answered 400']])
})

test('M18 a 404 (the session not registered yet) is not logged and leaves the warning for a real refusal', async ($, on) => {
  let n = 0
  const { clock, posts } = setup(on, {
    fetch: () => ({ value: { status: ++n === 1 ? 404 : 400, ok: false, headers: {}, text: '{}' } }),
  })
  await $.session.measure(measureInput(5))
  await clock.settle()
  await $.session.measure(measureInput(6))
  await clock.settle()
  expect([posts.length, logs]).toEqual([2, ['ctx-mod: router answered 400']])
})

test("M15 at is the mod's Date.now() when the event fired, never decreasing", async ($, on) => {
  // agent.list takes real time, so an `at` taken after the reads would come out later than listDone
  let listDone = 0
  const { clock, posts } = setup(on, {
    list: async () => {
      nextMs()
      nextMs()
      listDone = Date.now()
      return { value: [] }
    },
  })
  const t0 = Date.now()
  await $.session.measure(measureInput(5))
  await clock.settle()
  const firstListDone = listDone
  nextMs()
  await $.session.measure(measureInput(6))
  await clock.settle()
  const t1 = Date.now()
  const ats = posts.map((p) => p.body.at)
  expect(ats.every((a) => Number.isInteger(a) && a >= t0 && a <= t1)).toBe(true)
  expect(ats.length === 2 && ats[0] < ats[1]).toBe(true)
  expect(ats[0]).toBeLessThan(firstListDone)
})

test('M16 a report that finishes after a newer one is dropped, and dedupe follows the newer one', async ($, on) => {
  let call = 0
  let releaseFirst = () => {}
  const { clock, posts } = setup(on, {
    list: async () => {
      call++
      if (call === 1) {
        // the first report loses the 150 ms race and finishes only when released
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        return { value: [] }
      }
      return { value: call === 2 ? [{ id: 'a1', type: 'general-purpose', status: 'running' }] : [] }
    },
  })
  const first = $.session.measure(measureInput(5))
  await clock.advance(150)
  await first
  nextMs()
  await $.session.measure(measureInput(5)) // newer: 1 running
  await clock.settle()
  releaseFirst() // the first report finishes now, older than the one sent
  await clock.settle()
  await $.session.measure(measureInput(5)) // the truth again: 0 running, same as the late report
  await clock.settle()
  const ats = posts.map((p) => p.body.at)
  expect([posts.map((p) => p.body.agents.running), ats.every((a, i) => i === 0 || a > ats[i - 1])]).toEqual([[1, 0], true])
})

// Kit tests for hooks/ctx-log.js (LWO-007 / fork #37), run by `claude plugin
// test` (Claude Code's mod test kit), never by bun: bun ignores this file name.
// test/ctx-log.test.ts copies this file, hooks/mods.js and both mods into a temp
// plugin, runs the kit sandboxed, and turns each title below into one bun test.
// Keep every title in that file's TITLES list, and keep titles unique: the
// removal control names them. Limits are written out (4,128,768 and 64), never
// imported, so a mutant that moves them is seen.
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/lab'
const DIR = `${HOME}/.omt-scratch/lab-ctx/`
const ENV = { SESSION_NAME: 'lab1', HOME }
const DAY_D = Date.UTC(2026, 9, 13, 10, 0, 0) // 2026-10-13T10:00:00Z
const U = { startedAt: 1, context: { tokens: 69977, window: 1_000_000, percent: 7 }, rateLimits: [], cost: { usd: 0 } }
const KEPT = [{ role: 'user', text: 'summary of the conversation so far', toolUses: [] }]
const NEVER = () => new Promise(() => {})
const LIMIT = 4128768

type Write = { path: string; text: string }
/** usage / fsWrite: a value to answer with, or a hook (e.g. NEVER) to answer instead. */
type Opts = { env?: Record<string, string>; usage?: unknown; fsWrite?: (e: any) => unknown; now?: number }
const logs: string[] = []

/** The world beneath the mods: env, clock, usage, a recording fs.write and valid bottom results. */
function setup(on: any, o: Opts = {}) {
  const clock = mock.clock(on, { now: o.now ?? DAY_D })
  const box = {
    env: { ...(o.env ?? ENV) } as Record<string, string>,
    step: stepResult(null) as unknown,
    compact: { messages: KEPT } as unknown,
    compactIn: [] as unknown[],
    throwCompact: null as Error | null,
  }
  const writes: Write[] = []
  logs.length = 0
  on('ui.log', async (_$: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('env.get', async (_$: any, e: any) => ({ value: box.env[e.name] }))
  on('session.usage', typeof o.usage === 'function' ? o.usage : async () => ({ value: o.usage ?? U }))
  on('session.id', async () => ({ value: 'sid-1' }))
  on('agent.list', async () => ({ value: [] }))
  on('fs.write', async (_$: any, e: any) => {
    writes.push({ path: e.path, text: e.text })
    return o.fsWrite ? o.fsWrite(e) : { value: undefined }
  })
  on('session.measure', async (_$: any, e: any) => ({ changed: e.changed }))
  on('turn.complete', async () => ({ text: '' }))
  on('session.end', async () => ({ sessionId: 'sid-1' }))
  on('session.compact', async (_$: any, e: any) => {
    box.compactIn.push(e)
    if (box.throwCompact) throw box.throwCompact
    return box.compact
  })
  on('turn.step', async function* (_$: any, e: any) {
    // the step answered for: the host checks its turnId and index
    return { ...(box.step as object), turnId: e.turnId, index: e.index }
  })
  return { clock, writes, box }
}

function stepResult(usage: unknown) {
  return { turnId: 't1', index: 0, answer: 'a-0', toolUses: [], stopReason: 'end_turn', usage }
}
const usage = (input: number, cr: number, cc: number, output = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, model: 'claude-haiku-5-5' })

async function runStep($: any, e: Record<string, unknown> = {}) {
  const st = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, ...e })
  let it = await st.next()
  while (!it.done) it = await st.next()
  return it.value
}
const complete = ($: any, e: Record<string, unknown> = {}) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...e })
const end = ($: any) => $.session.end({ reason: 'prompt_input_exit', sessionId: 'sid-1', resume: {} })
const compact = ($: any, e: Record<string, unknown> = {}) => $.session.compact({ trigger: 'manual', messages: KEPT, ...e })
/** Every JSON line in a write's text. */
const lines = (w: Write | undefined) => (w ? w.text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [])
const last = (writes: Write[]) => writes[writes.length - 1]

// ── turn lines ─────────────────────────────────────────────────────────────

test('L1 a main turn writes one turn line: tokens from the last main step, window from usage()', async ($, on) => {
  const { clock, writes, box } = setup(on)
  box.step = stepResult(usage(1, 30000, 500))
  await runStep($)
  box.step = stepResult(usage(2, 60855, 9120, 4))
  await runStep($, { index: 1 })
  await complete($)
  await clock.settle()
  const ls = lines(last(writes))
  expect(ls.map(({ v, at, session, agentId, kind, tokens, window }) => ({ v, at, session, agentId, kind, tokens, window }))).toEqual([
    { v: 1, at: '2026-10-13T10:00:00.000Z', session: 'lab1', agentId: null, kind: 'turn', tokens: 69977, window: 1_000_000 },
  ])
})

test("L2 a subagent turn writes its agentId and its own last step's tokens, with window null", async ($, on) => {
  const { clock, writes, box } = setup(on)
  box.step = stepResult(usage(2, 40000, 8617))
  await runStep($, { agentId: 'a05733' })
  await complete($, { agentId: 'a05733' })
  await clock.settle()
  expect(lines(last(writes)).map(({ agentId, kind, tokens, window }) => ({ agentId, kind, tokens, window }))).toEqual([{ agentId: 'a05733', kind: 'turn', tokens: 48619, window: null }])
})

test('L20 a turn with no step after a turn that had usage logs tokens null', async ($, on) => {
  const { clock, writes, box } = setup(on)
  box.step = stepResult(usage(1, 2, 3))
  await runStep($)
  await complete($)
  await clock.settle()
  await complete($)
  await clock.settle()
  expect(lines(last(writes)).map((l) => l.tokens)).toEqual([6, null])
})

test("L25 interleaved main and subagent steps: each loop's line has its own last step", async ($, on) => {
  const { clock, writes, box } = setup(on)
  box.step = stepResult(usage(1, 10, 0))
  await runStep($)
  box.step = stepResult(usage(2, 20, 0))
  await runStep($, { agentId: 'a1' })
  box.step = stepResult(usage(3, 30, 0))
  await runStep($, { index: 1 })
  box.step = stepResult(usage(4, 40, 0))
  await runStep($, { agentId: 'a1', index: 1 })
  await complete($, { agentId: 'a1' })
  await complete($)
  await clock.settle()
  expect(lines(last(writes)).map((l) => [l.agentId, l.tokens])).toEqual([
    ['a1', 44],
    [null, 33],
  ])
})

// ── compaction lines ───────────────────────────────────────────────────────

test('L3 a main compaction writes one compact line: trigger, before and after from the result, agentId null, the main window', async ($, on) => {
  const { clock, writes, box } = setup(on)
  await complete($) // a main turn first: the compact line takes its window
  await clock.settle()
  box.compact = { messages: KEPT, tokensBefore: 69981, tokensAfter: 1693 }
  await compact($, { trigger: 'plugin' })
  await clock.settle()
  expect(lines(last(writes)).slice(1).map(({ agentId, kind, trigger, before, after, tokens, window }) => ({ agentId, kind, trigger, before, after, tokens, window }))).toEqual([
    { agentId: null, kind: 'compact', trigger: 'plugin', before: 69981, after: 1693, tokens: null, window: 1_000_000 },
  ])
})

test('L4 a subagent compaction writes its agentId, before and after', async ($, on) => {
  const { clock, writes, box } = setup(on)
  await complete($) // a main turn first: its window must not reach the subagent's line
  await clock.settle()
  box.compact = { messages: KEPT, tokensBefore: 98766, tokensAfter: 29929 }
  await compact($, { trigger: 'auto', agentId: 'a05733' })
  await clock.settle()
  expect(lines(last(writes)).slice(1).map(({ agentId, trigger, before, after, window }) => ({ agentId, trigger, before, after, window }))).toEqual([
    { agentId: 'a05733', trigger: 'auto', before: 98766, after: 29929, window: null },
  ])
})

test('L5 a skipped compaction writes nothing', async ($, on) => {
  const { clock, writes, box } = setup(on)
  box.compact = { skip: 'held' }
  await compact($)
  await clock.settle()
  expect(writes).toEqual([])
})

test('L6 a precompute compaction writes nothing', async ($, on) => {
  const { clock, writes, box } = setup(on)
  box.compact = { messages: KEPT, tokensBefore: 5 }
  await compact($, { trigger: 'precompute' })
  await clock.settle()
  expect(writes).toEqual([])
})

test('L7 a next(e) that throws is rethrown as the same error and writes nothing', async ($, on) => {
  const { clock, writes, box } = setup(on)
  box.throwCompact = new Error('reactive compaction did not settle ok')
  let thrown: unknown = null
  try {
    await compact($, { trigger: 'auto' })
  } catch (err) {
    thrown = err
  }
  await clock.settle()
  // The host wraps a hook's throw (identity is not kept, nor the text); what holds is that it still arrives as a throw.
  expect({ threw: thrown instanceof Error, writes: writes.length }).toEqual({ threw: true, writes: 0 })
})

test("L8 the hook returns next(e)'s result unchanged", async ($, on) => {
  const { clock, box } = setup(on)
  const r = { messages: [...KEPT], tokensBefore: 119585, tokensAfter: 8617, usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  box.compact = r
  const fresh = structuredClone(r)
  const got = await compact($, { trigger: 'auto' })
  await clock.settle()
  expect([got, r]).toEqual([fresh, fresh])
})

test("L8b next receives the hook's input unchanged", async ($, on) => {
  const { clock, box } = setup(on)
  const input = { trigger: 'manual', instructions: 'keep the ledger', messages: [...KEPT, { role: 'assistant', text: 'the last answer', toolUses: [] }] }
  const fresh = structuredClone(input)
  await $.session.compact(input)
  await clock.settle()
  expect(box.compactIn).toEqual([fresh])
})

// ── who logs ───────────────────────────────────────────────────────────────

test('L9 no SESSION_NAME (OMT_HUB_DIR set or not): no fs call', async ($, on) => {
  const { clock, writes, box } = setup(on, { env: { HOME, OMT_HUB_DIR: '/hub' } })
  box.step = stepResult(usage(1, 1, 1))
  await runStep($)
  await complete($)
  await compact($)
  await clock.settle()
  box.env = { HOME }
  await complete($)
  await compact($)
  await clock.settle()
  expect(writes).toEqual([])
})

test('L10 SESSION_NAME with OMT_HUB_DIR also set: the line and the file use SESSION_NAME', async ($, on) => {
  const { clock, writes } = setup(on, { env: { SESSION_NAME: 't1', HOME, OMT_HUB_DIR: '/hub' } })
  await complete($)
  await clock.settle()
  expect([last(writes).path.startsWith(`${DIR}t1-`), lines(last(writes))[0].session]).toEqual([true, 't1'])
})

test('L11 HOME unset, or relative: no fs call', async ($, on) => {
  const { clock, writes, box } = setup(on, { env: { SESSION_NAME: 'lab1' } })
  await complete($)
  await compact($)
  await clock.settle()
  const unset = writes.length
  box.env = { SESSION_NAME: 'lab1', HOME: 'home/lab' }
  await complete($)
  await compact($)
  await clock.settle()
  expect([unset, writes.length]).toEqual([0, 0])
})

test('L12 a write that throws: one warning, then no fs call, even for the rest of its own batch', async ($, on) => {
  let calls = 0
  let releaseFirst = () => {}
  const { clock, writes } = setup(on, {
    fsWrite: () => {
      calls++
      if (calls === 1)
        return new Promise((resolve) => {
          releaseFirst = () => resolve({ value: undefined })
        })
      return { deny: 'EACCES: permission denied' }
    },
  })
  await complete($) // write 1 is held
  await clock.settle()
  await complete($) // day D, queued
  await clock.set(Date.UTC(2026, 9, 14, 10, 0, 0))
  await complete($) // day D+1, queued: the next batch spans two files
  await clock.settle()
  releaseFirst()
  await clock.settle() // batch 2: the day D write is refused, the day D+1 write must not be tried
  await complete($)
  await compact($)
  await clock.settle()
  expect([writes.length, logs.length, logs[0]?.startsWith('ctx-log: ')]).toEqual([2, 1, true])
})

// ── never slows a turn ─────────────────────────────────────────────────────

test('L13a a write that never settles holds neither turn.complete nor session.compact: both return at once', async ($, on) => {
  const { clock, writes } = setup(on, { fsWrite: NEVER })
  const flags = { complete: false, compact: false }
  const ps = [
    complete($).then(() => {
      flags.complete = true
    }),
    compact($).then(() => {
      flags.compact = true
    }),
  ]
  await clock.settle()
  expect([flags, writes.length]).toEqual([{ complete: true, compact: true }, 1])
  await Promise.all(ps)
})

test('L13b session.end waits for the queue up to 150 ms of hook time', async ($, on) => {
  const { clock } = setup(on, { fsWrite: NEVER })
  await complete($)
  await clock.settle()
  let done = false
  const p = end($).then(() => {
    done = true
  })
  await clock.settle()
  const atStart = done
  await clock.advance(149)
  const at149 = done
  await clock.advance(1)
  await p
  expect([atStart, at149, done]).toEqual([false, false, true])
})

test('L13c a usage() that never answers holds turn.complete only 150 ms, and the line has window null', async ($, on) => {
  const { clock, writes } = setup(on, { usage: NEVER })
  let done = false
  const p = complete($).then(() => {
    done = true
  })
  await clock.settle()
  const atStart = done
  await clock.advance(149)
  const at149 = done
  await clock.advance(1)
  await p
  await clock.settle()
  expect([atStart, at149, done, lines(last(writes)).map((l) => l.window)]).toEqual([false, false, true, [null]])
})

// ── files ──────────────────────────────────────────────────────────────────

test('L14 the path is <HOME>/.omt-scratch/lab-ctx/<name>-<inst>-<YYYYMMDD>.jsonl; a later UTC day opens a new file', async ($, on) => {
  const { clock, writes } = setup(on)
  await complete($)
  await clock.settle()
  const first = last(writes)
  await clock.set(Date.UTC(2026, 9, 14, 0, 0, 1))
  await complete($)
  await clock.settle()
  const second = last(writes)
  const inst = lines(first)[0].inst
  expect([first.path, second.path, lines(second).length]).toEqual([`${DIR}lab1-${inst}-20261013.jsonl`, `${DIR}lab1-${inst}-20261014.jsonl`, 1])
})

test('L19 a line built before midnight and queued after a newer one goes to the newer file; day D keeps all its lines', async ($, on) => {
  let usageCalls = 0
  const { clock, writes, box } = setup(on, {
    now: Date.UTC(2026, 9, 13, 23, 0, 0),
    usage: async () => (++usageCalls === 3 ? new Promise(() => {}) : { value: U }),
  })
  await complete($) // 23:00, day D
  await clock.settle()
  await clock.set(Date.UTC(2026, 9, 13, 23, 30, 0))
  await complete($) // 23:30, day D
  await clock.settle()
  const dayD = writes.filter((w) => w.path.endsWith('-20261013.jsonl'))
  const dayDLines = lines(dayD[dayD.length - 1]).length
  await clock.set(Date.UTC(2026, 9, 13, 23, 59, 59, 900))
  const late = complete($) // built at 23:59:59.900; its usage() hangs for 150 ms
  await clock.settle()
  await clock.advance(100) // now 00:00:00.000, day D+1
  box.compact = { messages: KEPT, tokensBefore: 10, tokensAfter: 1 }
  await compact($) // built and queued on day D+1, before the late turn line
  await clock.settle()
  await clock.advance(50)
  await late
  await clock.settle()
  const d = writes.filter((w) => w.path.endsWith('-20261013.jsonl'))
  const d1 = writes.filter((w) => w.path.endsWith('-20261014.jsonl'))
  expect([dayDLines, lines(d[d.length - 1]).length, lines(d1[d1.length - 1]).map((l) => l.kind)]).toEqual([2, 2, ['compact', 'turn']])
})

test('L15 rotation: a line ending exactly at 4,128,768 stays, one character more goes to -2; an oversize line is written alone, in part 1 when the file is new', async ($, on) => {
  const { clock, writes, box } = setup(on)
  box.compact = { messages: KEPT, tokensBefore: 1, tokensAfter: 1 }
  // day 1: a second line that ends exactly at the limit stays in part 1
  await compact($, { agentId: 'a' })
  await clock.settle()
  const len1 = last(writes).text.length // base + 1
  const base = len1 - 1
  await compact($, { agentId: 'x'.repeat(LIMIT - len1 - base) })
  await clock.settle()
  const exact = last(writes)
  // day 2: the same, one character longer, goes to part 2
  await clock.set(Date.UTC(2026, 9, 14, 10, 0, 0))
  await compact($, { agentId: 'a' })
  await clock.settle()
  await compact($, { agentId: 'x'.repeat(LIMIT - len1 - base + 1) })
  await clock.settle()
  const over = last(writes)
  // day 3: a line larger than the limit is written alone in a fresh part, and the next line opens another
  await clock.set(Date.UTC(2026, 9, 15, 10, 0, 0))
  await compact($, { agentId: 'a' })
  await clock.settle()
  await compact($, { agentId: 'y'.repeat(LIMIT + 10) })
  await clock.settle()
  const alone = last(writes)
  await compact($, { agentId: 'c' })
  await clock.settle()
  const after = last(writes)
  // day 4: an oversize first line of a fresh day is written alone in part 1
  await clock.set(Date.UTC(2026, 9, 16, 10, 0, 0))
  await compact($, { agentId: 'y'.repeat(LIMIT + 10) })
  await clock.settle()
  const first = last(writes)
  expect([
    first.path.endsWith('-20261016.jsonl'),
    lines(first).length,
    exact.text.length,
    exact.path.endsWith('-20261013.jsonl'),
    over.path.endsWith('-20261014-2.jsonl'),
    lines(over).length,
    alone.path.endsWith('-20261015-2.jsonl'),
    lines(alone).length,
    after.path.endsWith('-20261015-3.jsonl'),
  ]).toEqual([true, 1, LIMIT, true, true, 1, true, 1, true])
})

test('L16 queue: 64 pending are all written, the 63 queued in one write; a 65th is dropped, the next line carries dropped:1 and the one after none', async ($, on) => {
  const release: (() => void)[] = []
  const { clock, writes, box } = setup(on, {
    fsWrite: () =>
      new Promise((resolve) => {
        release.push(() => resolve({ value: undefined }))
      }),
  })
  box.compact = { messages: KEPT, tokensBefore: 1, tokensAfter: 1 }
  for (let i = 1; i <= 65; i++) {
    await compact($, { agentId: 'q' + i })
    await clock.settle()
  }
  const held = writes.length // only the first is in flight
  release.shift()!()
  await clock.settle()
  const batch = lines(last(writes)).slice(1).map((l) => l.agentId) // the coalesced write: previous text plus 63 lines
  release.shift()!()
  await clock.settle()
  await compact($, { agentId: 'z' })
  await clock.settle()
  const next = lines(last(writes)).pop()
  release.shift()!()
  await clock.settle()
  await compact($, { agentId: 'z2' })
  await clock.settle()
  release.shift()!()
  await clock.settle()
  const after = lines(last(writes)).pop()
  expect([held, batch.length, batch[0], batch[62], writes.length, next.agentId, next.dropped, after.agentId, 'dropped' in after]).toEqual([1, 63, 'q2', 'q64', 4, 'z', 1, 'z2', false])
})

test('L17 each write is the previous text plus the new lines, in event order', async ($, on) => {
  const { clock, writes } = setup(on)
  await complete($)
  await clock.settle()
  await compact($)
  await clock.settle()
  const [a, b] = writes
  expect([b.text.startsWith(a.text), b.text.length > a.text.length, lines(b).map((l) => l.kind)]).toEqual([true, true, ['turn', 'compact']])
})

test('L18 a session name with / and spaces is sanitised in the path, but kept as given in the line', async ($, on) => {
  const { clock, writes } = setup(on, { env: { SESSION_NAME: 'team a/b', HOME } })
  await complete($)
  await clock.settle()
  const w = last(writes)
  expect([w.path.startsWith(`${DIR}team_a_b-`), lines(w)[0].session]).toEqual([true, 'team a/b'])
})

test('L22 a line enqueued after the first hook returned is written when the held write is released', async ($, on) => {
  const release: (() => void)[] = []
  const { clock, writes } = setup(on, {
    fsWrite: () =>
      new Promise((resolve) => {
        release.push(() => resolve({ value: undefined }))
      }),
  })
  await complete($)
  await clock.settle()
  await compact($)
  await clock.settle()
  const held = writes.length
  release.shift()!()
  await clock.settle()
  expect([held, lines(last(writes)).map((l) => l.kind)]).toEqual([1, ['turn', 'compact']])
})

test("L23 a non-ASCII session name is escaped, so the line's length equals its UTF-8 byte count", async ($, on) => {
  const { clock, writes } = setup(on, { env: { SESSION_NAME: 'lab-é✓😀', HOME } })
  await complete($)
  await clock.settle()
  const t = last(writes).text
  expect([/[^\x00-\x7f]/.test(t), t.includes('lab-\\u00e9\\u2713\\ud83d\\ude00'), lines(last(writes))[0].session]).toEqual([false, true, 'lab-é✓😀'])
})

test('L24 every line carries the same 6-character base36 inst, and so does the filename', async ($, on) => {
  const { clock, writes } = setup(on)
  await complete($)
  await compact($)
  await clock.settle()
  const ls = lines(last(writes))
  const inst = ls[0].inst
  expect([/^[0-9a-z]{6}$/.test(inst), ls.every((l) => l.inst === inst), last(writes).path.includes(`-${inst}-`)]).toEqual([true, true, true])
})

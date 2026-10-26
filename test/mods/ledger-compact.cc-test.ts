// Kit tests for hooks/ledger-compact.js (LWO-019 / fork #66, plan v4.2), run by `claude plugin
// test` (Claude Code's mod test kit), never by bun: bun ignores this file name.
// test/ledger-compact.test.ts copies this file, hooks/ (all six files) and docs/corp-mode-spec.md
// into a temp plugin named "ledger-compact-kit", writes tests/fixtures.js from
// test/fixtures/ledger-compact/, runs the kit once per run variant (§5.4) and turns each title
// below into one bun test. A title tagged [hold], [above-soft] or [net-off] is required green only
// in that run; an untagged title only in the shipped run. Limits are written out, never imported.
//
// Kit facts this file works with (plan v4.2, R22): a plugin's own $.session.compact() reaches the
// test's bottom with no trigger and no messages, and the kit's own $ raises events with the
// engine's origin (no plugin named). So a flow title counts the bottom's plugin calls at
// turn.complete, then raises the own-call event itself ({ trigger: 'plugin' }, nameless origin)
// while the bottom holds that call in flight.
import { expect, mock, test } from 'claude-code/testing'
import { afterNext, ledgerNow, ownerOf, stateOf, tailOf, waitOf } from '../hooks/ledger-compact.js'
import { FIX } from './fixtures.js'

const HOME = '/home/lab'
const V = '/vault'
const TASKS = `${V}/lab/tasks`
const ROOT = '/root'
const LOGDIR = `${HOME}/.omt-scratch/lab-ctx/`
const W = 1_000_000
const T0 = Date.UTC(2026, 9, 24, 6, 0, 0)
const HUB_ENV = { SESSION_NAME: 'hub', HOME, OMT_VAULT_ROOT: V }
const TEAM_ENV = { SESSION_NAME: 'team1', HOME, OMT_VAULT_ROOT: V }
const NEVER = () => new Promise(() => {})
const P019 = `${TASKS}/LWO-019-ledger-compact-hook.md`
const P018 = `${TASKS}/LWO-018-router-team-message-auth.md`
const NOWMD = `${ROOT}/.sisyphus/now.md`
const HELD = 'ledger-compact: held at'
const CORE = 'This session is being continued from a previous conversation'

type Row = { role: 'user' | 'assistant'; text: string; toolUses: { tool_use_id: string; tool: string; input: unknown }[]; toolResults?: { tool_use_id: string; text: string; isError: boolean }[]; handle?: string }

const ledger = (state: string, extra = '') => `# LWO — x\nIssue: y\n## Now\nOrder: "Start now". Tier: L. State: ${state}.\nWaiting for: x.${extra}\n## Log\n- 03:58Z created. State: STARTING.\n`

/** Rows from a shape: U, A, At (assistant with one tool_use), Ur (user with the oldest open tool_result), ×N repeats. */
function rows(spec: string): Row[] {
  const out: Row[] = []
  const open: string[] = []
  let id = 0
  for (const tok of spec.split(' ')) {
    const m = /^(U|A|At|Ur)(?:×(\d+))?$/.exec(tok)
    if (!m) throw new Error('bad shape token ' + tok)
    for (let i = 0; i < Number(m[2] ?? 1); i++) {
      const handle = 'h' + out.length
      if (m[1] === 'At') {
        const t = 'tu' + id++
        open.push(t)
        out.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: t, tool: 'Read', input: {} }], handle })
      } else if (m[1] === 'Ur') out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: open.shift()!, text: 'r', isError: false }], handle })
      else out.push({ role: m[1] === 'U' ? 'user' : 'assistant', text: m[1] + out.length, toolUses: [], handle })
    }
  }
  return out
}
function unmatched(tail: Row[]) {
  const have = new Set(tail.flatMap((r) => r.toolUses.map((u) => u.tool_use_id)))
  return tail.reduce((n, r) => n + (r.toolResults ?? []).filter((x) => !have.has(x.tool_use_id)).length, 0)
}

type Opts = { env?: Record<string, string>; files?: Record<string, string> }

/** The world beneath the mods: env, clock, usage, an in-memory fs, session.root/messages and bottoms. */
function setup(on: any, o: Opts = {}) {
  const clock = mock.clock(on, { now: T0 })
  const box = {
    env: { ...(o.env ?? HUB_ENV) } as Record<string, string>,
    files: { [`${V}/lab/standing.md`]: FIX.standing, SPEC: FIX.spec, ...(o.files ?? {}) } as Record<string, string>,
    mtimes: {} as Record<string, number>,
    dirs: new Set<string>([TASKS]),
    usage: { startedAt: 1, context: { tokens: 359000, window: W, percent: 36 }, rateLimits: [], cost: { usd: 0 } } as unknown,
    usageHook: null as null | (() => unknown),
    step: null as unknown,
    coreOut: null as unknown,
    coreIn: [] as any[],
    pluginCalls: 0,
    pluginGate: null as null | Promise<unknown>,
    release: null as null | ((v: unknown) => void),
    pluginReject: null as Error | null,
    readHook: null as null | ((path: string) => unknown),
    existsThrow: false,
    envThrow: false,
    transcript: rows('U A U A U A'),
    reads: [] as string[],
  }
  const writes: { path: string; text: string }[] = []
  const logs: string[] = []
  on('ui.log', async (_$: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('env.get', async (_$: any, e: any) => {
    if (box.envThrow && e.name === 'OMT_LEDGER_COMPACT') throw new TypeError('boom')
    return { value: box.env[e.name] }
  })
  on('session.usage', async () => (box.usageHook ? box.usageHook() : { value: box.usage }))
  on('session.id', async () => ({ value: 'sid-1' }))
  on('session.root', async () => ({ value: ROOT }))
  on('session.messages', async () => ({ value: box.transcript }))
  on('agent.list', async () => ({ value: [] }))
  on('fs.write', async (_$: any, e: any) => {
    writes.push({ path: e.path, text: e.text })
    if (box.env.__WRITE_THROWS) throw new Error('ENOSPC')
    return { value: undefined }
  })
  const fileFor = (p: string) => (p.endsWith('/docs/corp-mode-spec.md') ? box.files.SPEC : box.files[p])
  on('fs.read', async (_$: any, e: any) => {
    box.reads.push(e.path)
    if (box.readHook) {
      const r = await box.readHook(e.path)
      if (r !== undefined) return r
    }
    const t = fileFor(e.path)
    if (t === undefined) throw new Error('ENOENT: ' + e.path)
    return { value: t }
  })
  on('fs.exists', async (_$: any, e: any) => {
    if (box.existsThrow) throw new TypeError('boom')
    return { value: fileFor(e.path) !== undefined }
  })
  on('fs.stat', async (_$: any, e: any) => {
    if (fileFor(e.path) === undefined) throw new Error('ENOENT: ' + e.path)
    return { value: { kind: 'file', size: 1, mtimeMs: box.mtimes[e.path] ?? 1, isLink: false } }
  })
  on('fs.list', async (_$: any, e: any) => {
    if (!box.dirs.has(e.path)) throw new Error('ENOENT: ' + e.path)
    const names = Object.keys(box.files).filter((p) => p.startsWith(e.path + '/') && !p.slice(e.path.length + 1).includes('/'))
    return { value: names.map((p) => ({ name: p.slice(e.path.length + 1), kind: box.files[p] === '<dir>' ? 'directory' : 'file', size: 1, mtimeMs: box.mtimes[p] ?? 1, isLink: false })) }
  })
  on('turn.start', async (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('session.compact', async (_$: any, e: any) => {
    if (e.trigger === undefined) {
      // a plugin's own $.session.compact(), as the kit raises it
      box.pluginCalls++
      if (box.pluginReject) throw box.pluginReject
      if (box.pluginGate) return box.pluginGate
      return { messages: [{ role: 'user', text: 'rebuilt', toolUses: [] }] }
    }
    box.coreIn.push({ trigger: e.trigger, instructions: e.instructions ?? null, n: e.messages.length })
    return box.coreOut ?? { messages: [{ role: 'user', text: CORE, toolUses: [], handle: 'new-1' }, ...e.messages.slice(-1)], tokensBefore: 1, tokensAfter: 1 }
  })
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'a', toolUses: [], stopReason: 'end_turn', usage: box.step }
  })
  const hold = () => {
    box.pluginGate = new Promise((r) => (box.release = r))
  }
  return { clock, box, writes, logs, hold }
}

const lines = (writes: { text: string }[]) => {
  const w = writes[writes.length - 1]
  return w ? w.text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : []
}
const ours = (writes: { text: string }[]) => lines(writes).filter((l) => ['hold', 'holds', 'rebuild', 'reconcile', 'pass'].includes(l.kind))
const kr = (writes: { text: string }[]) => ours(writes).map((l) => [l.kind, l.reason ?? null])
const usageOf = (tokens: number | null, window: number | null = W) => ({ value: { startedAt: 1, context: { tokens: tokens ?? undefined, window: window ?? undefined, percent: 1 }, rateLimits: [], cost: { usd: 0 } } })
const u = (input: number) => ({ input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' })
const start = ($: any, turnId = 't1') => $.turn.start({ text: 'go', turnId })
async function step($: any, box: any, tokens: number | null, turnId = 't1', index = 0) {
  box.step = tokens === null ? null : u(tokens)
  const st = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 })
  let it = await st.next()
  while (!it.done) it = await st.next()
  return it.value
}
const complete = ($: any, turnId = 't1') => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
const compact = ($: any, trigger: string, messages: Row[] = rows('U A U A U A'), e: Record<string, unknown> = {}) => $.session.compact({ trigger, messages, ...e })
/** A whole main turn: start, one step at `tokens` (null: a step with no usage), complete. */
async function turn($: any, box: any, clock: any, tokens: number | null, id: string) {
  await start($, id)
  await step($, box, tokens, id)
  await complete($, id)
  await clock.settle()
}
const hub = (s019: string, s018 = 'CLOSED') => ({ [P018]: ledger(s018), [P019]: ledger(s019) })
const team = (state: string | null) => ({ [NOWMD]: `# Now — LWO-019\norder: LWO-019\n${state === null ? '' : `state: ${state}\n`}current step: x\n` })
const isRebuild = (r: any, reason: string) => typeof r?.messages?.[0]?.text === 'string' && r.messages[0].text.startsWith(`LEDGER REBUILD by hooks/ledger-compact.js (${reason})`)

// ── holds, idle and size ───────────────────────────────────────────────────

test('C1 idle auto in an open order (359,000) is rebuilt: note first, tail after, rebuild/idle', async ($, on) => {
  const { clock, writes } = setup(on, { files: hub('IMPLEMENT') })
  const r = await compact($, 'auto', rows('U A U A U A'))
  await clock.settle()
  expect([isRebuild(r, 'idle'), r.messages.slice(-6).map((m: any) => m.handle), kr(writes)]).toEqual([true, ['h0', 'h1', 'h2', 'h3', 'h4', 'h5'], [['rebuild', 'idle']]])
})

test('[hold] C1h idle auto at 359,000 is held: the notice names 35.9%, the guard and LWO-019', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.skip, box.coreIn.length, kr(writes)]).toEqual(['ledger-compact: held at 35.9% (359000) < guard 90% while LWO-019 is open (State: IMPLEMENT); /compact still runs', 0, [['hold', 'idle']]])
})

test('C1t a team session with state: IMPLEMENT: an idle auto is rebuilt with the now.md section', async ($, on) => {
  const { clock } = setup(on, { env: TEAM_ENV, files: team('IMPLEMENT') })
  const r = await compact($, 'auto')
  await clock.settle()
  expect(r.messages?.[0].text.includes('== Now: .sisyphus/now.md ==\n# Now — LWO-019')).toBe(true)
})

test('C2 in a turn: 899,999 is held, 900,000 is rebuilt (guard)', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await start($)
  box.usage = usageOf(899999).value
  const a = await compact($, 'auto')
  await step($, box, 1)
  box.usage = usageOf(900000).value
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.startsWith(HELD), isRebuild(b, 'guard'), kr(writes)]).toEqual([true, true, [['hold', 'below-guard'], ['rebuild', 'guard']]])
})

test('[net-off] C2off at 900,000 in a turn the rebuild is [note, …tail] and core is not called', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  await start($)
  box.usage = usageOf(900000).value
  const r = await compact($, 'auto', rows('U A U A'))
  await clock.settle()
  expect([box.coreIn.length, r.messages.length, r.messages[0].text.includes('4 rows of the conversation follow unchanged.')]).toEqual([0, 5, true])
})

test("C2u lastStep 850,000 with usage 970,000 in a turn: rebuilt, not held (the engine's figure wins)", async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await start($)
  await step($, box, 850000)
  box.usage = usageOf(970000).value
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.skip, kr(writes)]).toEqual([undefined, [['rebuild', 'guard']]])
})

test('C2l the window primed by one turn, lastStep 850,000, then usage never answers in a turn: rebuilt (no-engine-size), never held', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(100).value
  await turn($, box, clock, 100, 't0') // primes lastWindow = 1,000,000
  await start($)
  await step($, box, 850000)
  box.usageHook = NEVER
  const p = compact($, 'auto')
  await clock.advance(151)
  const r = await p
  await clock.settle()
  expect([r.skip, kr(writes)]).toEqual([undefined, [['rebuild', 'no-engine-size']]])
})

test('C2r in a turn at 600,000: a hold, then a second ask at the same step is rebuilt (repeat), an ask after a new step is held', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(600000).value
  await start($)
  const a = await compact($, 'auto')
  const b = await compact($, 'auto')
  await step($, box, 1)
  const c = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.startsWith(HELD), isRebuild(b, 'repeat'), c.skip?.startsWith(HELD), kr(writes)]).toEqual([true, true, true, [['hold', 'below-guard'], ['rebuild', 'repeat']]])
})

test('C2w a 200,000 window from usage at the event, tokens 190,000 in a turn: rebuilt (guard)', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await start($)
  box.usage = usageOf(190000, 200000).value
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.skip, kr(writes)]).toEqual([undefined, [['rebuild', 'guard']]])
})

test('C2c after a rebuild at 900,000 lastStepTokens is cleared: a turn.complete with no step and no usage figure starts nothing', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  await start($)
  await step($, box, 900000)
  box.usage = usageOf(900000).value
  await compact($, 'auto')
  box.usage = usageOf(null).value
  await complete($)
  await clock.settle()
  expect(box.pluginCalls).toBe(0)
})

test('C2t RACE_MS: usage answering at 149 ms is used (guard at 970,000); at 151 ms it is lost (no-engine-size)', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await start($)
  await step($, box, 100000)
  box.usageHook = () => clock.sleep(149).then(() => usageOf(970000))
  const p = compact($, 'auto')
  await clock.advance(149)
  await p
  await step($, box, 100000, 't1', 1)
  box.usageHook = () => clock.sleep(151).then(() => usageOf(970000))
  const q = compact($, 'auto')
  await clock.advance(151)
  await q
  await clock.settle()
  expect(kr(writes)).toEqual([['rebuild', 'guard'], ['rebuild', 'no-engine-size']])
})

test('C2z a window of 0 or of 1,000,000.5 from usage is unknown: no hold (no-engine-size)', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await start($)
  box.usage = usageOf(500000, 0).value
  const a = await compact($, 'auto')
  box.usage = usageOf(500000, 1000000.5).value
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip, b.skip, kr(writes)]).toEqual([undefined, undefined, [['rebuild', 'no-engine-size'], ['rebuild', 'no-engine-size']]])
})

// ── pass-through ───────────────────────────────────────────────────────────

test('C3 manual at 50% and 95%, idle and in a turn, order open: next gets e unchanged, the result is unchanged, one pass/manual each', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(500000).value
  const a = await compact($, 'manual', rows('U A'))
  box.usage = usageOf(950000).value
  await start($)
  const b = await compact($, 'manual', rows('U A'), { instructions: 'mine' })
  await clock.settle()
  expect([a.messages[0].text, b.messages[0].text, box.coreIn, kr(writes)]).toEqual([
    CORE,
    CORE,
    [
      { trigger: 'manual', instructions: null, n: 2 },
      { trigger: 'manual', instructions: 'mine', n: 2 },
    ],
    [['pass', 'manual'], ['pass', 'manual']],
  ])
})

test('C4 a sub-agent auto at a primed 500,000 with the order open: next(e) unchanged, no line', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 500000, 't1')
  await start($)
  const r = await compact($, 'auto', rows('U A'), { agentId: 'a1' })
  await clock.settle()
  expect([r.messages[0].text, box.coreIn, kr(writes)]).toEqual([CORE, [{ trigger: 'auto', instructions: null, n: 2 }], []])
})

// ── staleness ──────────────────────────────────────────────────────────────

test('C5 the change is seen at turn T; 29 more turn.completes are fresh (held), 30 are stale (reconcile, RECONCILE first)', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(100).value
  for (let i = 0; i <= 29; i++) await turn($, box, clock, 100, 'c' + i)
  box.usage = usageOf(600000).value
  await start($, 'x')
  const a = await compact($, 'auto')
  box.usage = usageOf(100).value
  await complete($, 'x')
  await clock.settle()
  box.usage = usageOf(600000).value
  await start($, 'y')
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.startsWith(HELD), b.messages?.[0].text, box.coreIn.map((c) => c.instructions)]).toEqual([
    true,
    'RECONCILE: re-read the ledger log; the Now section may be out of date',
    ["Summarise the conversation. The ledger's Now section may be out of date; do not trust it over the conversation."],
  ])
})

test('C5L a Log line appended with the Now block unchanged does not reset the staleness count', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(100).value
  for (let i = 0; i <= 30; i++) {
    if (i === 15) box.files[P019] = box.files[P019] + '- 05:00Z a later log line. State: IMPLEMENT.\n'
    await turn($, box, clock, 100, 'c' + i)
  }
  box.usage = usageOf(600000).value
  await start($, 'y')
  const b = await compact($, 'auto')
  await clock.settle()
  expect(b.messages?.[0].text).toBe('RECONCILE: re-read the ledger log; the Now section may be out of date')
})

test('C5s a reconcile whose core skips returns the skip unchanged', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(100).value
  for (let i = 0; i <= 30; i++) await turn($, box, clock, 100, 'c' + i)
  box.coreOut = { skip: 'another hook' }
  box.usage = usageOf(600000).value
  await start($, 'y')
  const b = await compact($, 'auto')
  await clock.settle()
  expect(b).toEqual({ skip: 'another hook' })
})

// ── closing ────────────────────────────────────────────────────────────────

test('C6 LWO-019 seen open at T1 and CLOSED at T2: exactly one compact() before turn.complete returned; our call → rebuild/closed; T3 starts nothing', async ($, on) => {
  const { clock, box, writes, hold } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(100000).value
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  hold()
  await start($, 't2')
  await complete($, 't2')
  const atReturn = box.pluginCalls
  const r = await compact($, 'plugin')
  box.release!({ messages: r.messages })
  await clock.settle()
  box.pluginGate = null
  await turn($, box, clock, 100, 't3')
  expect([atReturn, isRebuild(r, 'closed'), r.messages[0].text.includes('== Now: LWO-019 (hub ledger) =='), box.pluginCalls, kr(writes)]).toEqual([1, true, true, 1, [['rebuild', 'closed'], ['pass', 'rebuild-size']]])
})

test('C6e after the reset, the Now text edited while still CLOSED starts nothing', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  await turn($, box, clock, 100, 't2')
  box.files[P019] = ledger('CLOSED', '\nOutcome: merged.')
  await turn($, box, clock, 100, 't3')
  expect(box.pluginCalls).toBe(1)
})

test('C6r every call rejected: calls at T2/T3/T4, the T3 note carries the edited Now, abandoned (tries 3) at T5, none at T5–T7', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  box.pluginReject = new Error('a turn runs')
  const calls: number[] = []
  for (const t of ['t2', 't3', 't4', 't5', 't6', 't7']) {
    if (t === 't3') box.files[P019] = ledger('CLOSED', '\nOutcome: edited.')
    await turn($, box, clock, 100, t)
    calls.push(box.pluginCalls)
  }
  expect([calls, ours(writes).filter((l) => l.reason === 'abandoned').map((l) => l.tries)]).toEqual([[1, 2, 3, 3, 3, 3], [3]])
})

test('C6g the guard twin: 920,000 at every turn.complete, every call rejected → calls at T1/T2/T3, abandoned at T4, no new cycle while nothing changes', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(920000).value
  box.pluginReject = new Error('a turn runs')
  const calls: number[] = []
  for (const t of ['t1', 't2', 't3', 't4', 't5', 't6']) {
    await turn($, box, clock, 100, t)
    calls.push(box.pluginCalls)
  }
  expect([calls, ours(writes).filter((l) => l.reason === 'abandoned').length]).toEqual([[1, 2, 3, 3, 3, 3], 1])
})

test('C6f a call still in flight at the next turn.complete: no second call', async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't2')
  await turn($, box, clock, 100, 't3')
  expect(box.pluginCalls).toBe(1)
})

test("C6h PENDING_MS: in flight at 119,999 ms → no second call; at 120,000 ms → a second call; the first call's late settle changes nothing", async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't2')
  const rel1 = box.release!
  await clock.advance(119999)
  await turn($, box, clock, 100, 't3')
  const a = box.pluginCalls
  await clock.advance(1)
  hold()
  await turn($, box, clock, 100, 't4')
  const b = box.pluginCalls
  rel1({ messages: [{ role: 'user', text: 'x', toolUses: [] }] })
  await clock.settle()
  const r = await compact($, 'plugin')
  expect([a, b, isRebuild(r, 'closed')]).toEqual([1, 2, true])
})

test('C6m CLOSED written mid-turn, then an in-turn auto: rebuild/closed there, and the turn.complete after it starts nothing', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.usage = usageOf(600000).value
  await start($, 't2')
  box.files[P019] = ledger('CLOSED')
  const r = await compact($, 'auto')
  box.usage = usageOf(100).value
  await complete($, 't2')
  await clock.settle()
  expect([isRebuild(r, 'closed'), box.pluginCalls, kr(writes)]).toEqual([true, 0, [['rebuild', 'closed'], ['pass', 'rebuild-size']]])
})

test('C6f2 ledger 040 closes at T2 (call in flight); ledger 012 (rank 9, open since the load scan) closes at T3; T4 acts on 012', async ($, on) => {
  const files: Record<string, string> = {}
  for (let i = 12; i <= 40; i++) files[`${TASKS}/LWO-0${String(i).padStart(2, '0')}-x.md`] = ledger(i === 12 || i === 40 ? 'IMPLEMENT' : 'CLOSED')
  const { clock, box, hold } = setup(on, { files })
  await turn($, box, clock, 100, 't1')
  box.files[`${TASKS}/LWO-040-x.md`] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't2')
  box.files[`${TASKS}/LWO-012-x.md`] = ledger('CLOSED')
  await turn($, box, clock, 100, 't3')
  const atT3 = box.pluginCalls
  box.release!({ messages: [{ role: 'user', text: 'x', toolUses: [] }] })
  await clock.settle()
  box.pluginGate = null
  await turn($, box, clock, 100, 't4')
  expect([atT3, box.pluginCalls]).toEqual([1, 2])
})

test('C6k a {skip} from another hook beneath is a rejection: retried at T3 and T4, abandoned at T5, no call at T6; our own skip is logged and terminal', async ($, on) => {
  const { clock, box, writes, hold } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  const calls: number[] = []
  for (const t of ['t2', 't3', 't4', 't5', 't6']) {
    hold()
    await turn($, box, clock, 100, t)
    calls.push(box.pluginCalls)
    box.release!({ skip: 'another hook' })
    await clock.settle()
  }
  const abandonedTries = ours(writes).filter((l) => l.reason === 'abandoned').map((l) => l.tries)
  // our own skip: terminal, with a line
  box.files[P018] = ledger('IMPLEMENT')
  box.files[`${TASKS}/LWO-020-z.md`] = ledger('IMPLEMENT')
  await turn($, box, clock, 100, 't7')
  box.files[`${TASKS}/LWO-020-z.md`] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't8')
  box.release!({ skip: 'ledger-compact: rebuild abandoned (read-error)' })
  await clock.settle()
  box.pluginGate = null
  await turn($, box, clock, 100, 't9')
  expect([calls, abandonedTries, ours(writes).filter((l) => l.reason === 'own-skip').length, box.pluginCalls]).toEqual([[1, 2, 3, 3, 3], [3], 1, 4])
})

test('C6p a rejected step pending at T2, then CLOSED written at T3: T3 acts closed, not the old step', async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('REVIEW') })
  box.usage = usageOf(400000).value
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('IMPLEMENT')
  box.pluginReject = new Error('busy')
  await turn($, box, clock, 100, 't2')
  box.pluginReject = null
  box.files[P019] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't3')
  const r = await compact($, 'plugin')
  expect([box.pluginCalls, isRebuild(r, 'closed')]).toEqual([2, true])
})

test("C6a 018 → CLOSED while 019 is open: rebuild/closed for 018, the note's Now is LWO-019", async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('IMPLEMENT', 'IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P018] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't2')
  const r = await compact($, 'plugin')
  expect([box.pluginCalls, isRebuild(r, 'closed'), r.messages[0].text.includes('== Now: LWO-019 (hub ledger) ==')]).toEqual([1, true, true])
})

test("C6b 019 → CLOSED while 018 is open: rebuild/closed for 019, the note's Now is LWO-018", async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('IMPLEMENT', 'IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't2')
  const r = await compact($, 'plugin')
  expect([box.pluginCalls, isRebuild(r, 'closed'), r.messages[0].text.includes('== Now: LWO-018 (hub ledger) ==')]).toEqual([1, true, true])
})

test('C6o a ledger first seen CLOSED starts nothing', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('CLOSED') })
  await turn($, box, clock, 100, 't1')
  await turn($, box, clock, 100, 't2')
  expect(box.pluginCalls).toBe(0)
})

test('C6x at rank 9: closed, reset, seen open again, CLOSED again → a second reset', async ($, on) => {
  const files: Record<string, string> = {}
  for (let i = 12; i <= 20; i++) files[`${TASKS}/LWO-0${i}-x.md`] = ledger(i === 12 ? 'IMPLEMENT' : 'CLOSED')
  const { clock, box } = setup(on, { files })
  box.usage = usageOf(100).value // below the soft mark: the reopen is not a step rebuild
  const P = `${TASKS}/LWO-012-x.md`
  await turn($, box, clock, 100, 't1')
  box.files[P] = ledger('CLOSED')
  box.mtimes[P] = 2
  await turn($, box, clock, 100, 't2')
  box.files[P] = ledger('REOPENED')
  box.mtimes[P] = 3
  await turn($, box, clock, 100, 't3')
  box.files[P] = ledger('CLOSED', '\nagain.')
  box.mtimes[P] = 4
  await turn($, box, clock, 100, 't4')
  expect(box.pluginCalls).toBe(2)
})

// ── determinism ────────────────────────────────────────────────────────────

test('C7 the note is byte-equal to the hand-built golden note, again with the clock +61 min and the mtime +1 h; SENTINEL never in it', async ($, on) => {
  const { clock, box, hold } = setup(on, { files: { [P019]: FIX.ledger019, [P018]: FIX.ledger018 } })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = FIX.ledger019.replace('State: AUDIT r1 (running).', 'State: CLOSED.')
  hold()
  await turn($, box, clock, 100, 't2')
  box.coreOut = { messages: [{ role: 'user', text: CORE, toolUses: [], handle: 'new-1' }] }
  const a = await compact($, 'plugin', rows('U A U A U A U A U A U A U A'))
  await clock.advance(61 * 60 * 1000)
  box.mtimes[P019] = 3600000
  const b = await compact($, 'plugin', rows('U A U A U A U A U A U A U A'))
  expect([a.messages?.[0].text === FIX.golden, b.skip ?? b.messages?.[0].text === FIX.golden, String(a.messages?.[0].text).includes('SENTINEL')]).toEqual([true, 'ledger-compact: own call aged', false])
})

test('C7d the same files build the same note after the clock moved 61 min and the mtime 1 h', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  const a = await compact($, 'auto')
  await clock.advance(61 * 60 * 1000)
  box.mtimes[P019] = 3600000
  const b = await compact($, 'auto')
  box.files[`${V}/lab/standing.md`] = FIX.standing + 'x'
  const c = await compact($, 'auto')
  expect([a.messages[0].text === b.messages[0].text, a.messages[0].text === c.messages[0].text]).toEqual([true, false])
})

test('C7c SECTION_CAP: 32,768 bytes → no marker; 32,769 with a 3-byte → across 32,767–32,769 → cut at 32,766 bytes with the marker', async ($, on) => {
  const { box } = setup(on, { files: hub('IMPLEMENT') })
  box.files[`${V}/lab/standing.md`] = 'x'.repeat(32768)
  const a = await compact($, 'auto')
  box.files[`${V}/lab/standing.md`] = 'x'.repeat(32766) + '→'
  const b = await compact($, 'auto')
  const sect = (t: string) => t.split('== Standing rulings ==\n')[1].split('== Spec contents')[0]
  expect([sect(a.messages[0].text).includes('[cut at'), sect(b.messages[0].text) === 'x'.repeat(32766) + '\n[cut at 32768 bytes]\n']).toEqual([false, true])
})

// ── tail ───────────────────────────────────────────────────────────────────

const T = (shape: string, k = 12) => {
  const t = tailOf(rows(shape), k)
  return [t.length, unmatched(t), t.length <= 2 * k]
}
test('C8 K: 11/12/13 rows and 40 rows (row −13 = A or Ur) keep 11/12/12/12/12 rows, same handles, in order', () => {
  const r40 = rows(Array(20).fill('A U').join(' '))
  expect([T('U A U A U A U A U A U'), T('U A U A U A U A U A U A'), T('A U A U A U A U A U A U A'), T(Array(20).fill('A U').join(' ')), T('U A '.repeat(13).trim() + ' At Ur ' + 'A U '.repeat(6).trim()), tailOf(r40).map((x) => x.handle)]).toEqual([
    [11, 0, true],
    [12, 0, true],
    [12, 0, true],
    [12, 0, true],
    [12, 0, true],
    r40.slice(-12).map((x) => x.handle),
  ])
})
test('C8k K = 25 on 40 plain rows keeps 25 (K_MAX = 2K)', () => {
  expect(tailOf(rows(Array(20).fill('U A').join(' ')), 25).length).toBe(25)
})
test('C9 a group start at −14 → 14 rows; a widening to exactly 24 → kept; to 25 → the group dropped (1 row)', () => {
  expect([T('U A U A U A At At Ur Ur A U A U A U A U A U'), T('U A U At×12 Ur×12'), T('U A U At×12 Ur×12 A')]).toEqual([
    [14, 0, true],
    [24, 0, true],
    [1, 0, true],
  ])
})
test('C9g a group longer than K_MAX (U At×13 Ur×13 A U) is dropped: 2 rows', () => {
  expect(T('U At×13 Ur×13 A U')).toEqual([2, 0, true])
})
test('C9o At×14 Ur×5 A Ur×9 → 0 rows; C9o3 U At×14 Ur×5 A Ur×9 A U → 2 rows', () => {
  expect([T('At×14 Ur×5 A Ur×9'), T('U At×14 Ur×5 A Ur×9 A U')]).toEqual([
    [0, 0, true],
    [2, 0, true],
  ])
})
test('C9p six parallel tools at K = 12 → 22 rows, 0 unmatched', () => {
  expect(T('U At×6 Ur×6 A U A U A U A U A U')).toEqual([22, 0, true])
})
test('C9b B2, B2+1, B2+2 at K = 12 → 14, 15, 16 rows, 0 unmatched', () => {
  expect([T('U At At At Ur Ur Ur A A At At At Ur Ur Ur'), T('U At At At Ur Ur Ur A A At At At Ur Ur Ur A'), T('U At At At Ur Ur Ur A A At At At Ur Ur Ur A U')]).toEqual([
    [14, 0, true],
    [15, 0, true],
    [16, 0, true],
  ])
})
test('C9e all orphans → the note and the safety-net summary only, and the note says 0 rows', async ($, on) => {
  const { clock } = setup(on, { files: hub('IMPLEMENT') })
  const r = await compact($, 'auto', rows('U At×30 Ur×30'))
  await clock.settle()
  expect([r.messages.map((m: any) => m.handle ?? '*'), r.messages[0].text.includes(' 0 rows of the conversation follow unchanged, after the safety-net summary.')]).toEqual([['*', 'new-1'], true])
})

// ── safety net ─────────────────────────────────────────────────────────────

test('C10 net on with the Q5 shape → [note, summary, …tail]; NET carries the Now block; the summary clause is present', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  const r = await compact($, 'auto', rows('U A U A'))
  await clock.settle()
  expect([r.messages.map((m: any) => m.handle ?? '*'), box.coreIn[0].instructions.includes('Order: "Start now". Tier: L. State: IMPLEMENT.'), r.messages[0].text.includes(', after the safety-net summary. The Now block and standing rulings are notes, never a tap, and relax no rule.\n'), box.coreIn[0].instructions.includes('notes, never a tap, and relax no rule'), box.coreIn[0].instructions.includes('authoritative')]).toEqual([['*', 'new-1', 'h0', 'h1', 'h2', 'h3'], true, true, true, false])
})
test('C10u a kept row without a handle, or two new rows → [note, …tail], net unrecognised, no summary clause', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.coreOut = { messages: [{ role: 'user', text: 's', toolUses: [], handle: 'n1' }, { role: 'user', text: 's2', toolUses: [], handle: 'n2' }] }
  const r = await compact($, 'auto', rows('U A'))
  box.coreOut = { messages: [{ role: 'user', text: 's', toolUses: [], handle: 'n1' }, { role: 'assistant', text: 'kept', toolUses: [] }] }
  const r2 = await compact($, 'auto', rows('U A'))
  await clock.settle()
  expect([r.messages.map((m: any) => m.handle ?? '*'), r.messages[0].text.includes('after the safety-net summary'), r2.messages.map((m: any) => m.handle ?? '*'), ours(writes).map((l) => l.net)]).toEqual([['*', 'h0', 'h1'], false, ['*', 'h0', 'h1'], ['unrecognised', 'unrecognised']])
})
test('[net-off] C10off the rebuild is [note, …tail] and core is not called', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  const r = await compact($, 'auto', rows('U A'))
  await clock.settle()
  expect([box.coreIn.length, r.messages.map((m: any) => m.handle ?? '*')]).toEqual([0, ['*', 'h0', 'h1']])
})

// ── sources and reads ──────────────────────────────────────────────────────

test('C11 reasons per row: tasks dir absent → read-error; no LWO file → no-now; all CLOSED → closed; a team with no now.md → no-now; one notice per load', async ($, on) => {
  const { clock, box, writes, logs } = setup(on, { files: {} })
  box.dirs.clear()
  await compact($, 'auto')
  box.dirs.add(TASKS)
  await compact($, 'auto')
  box.files[P019] = ledger('CLOSED')
  await compact($, 'auto')
  box.env = { ...TEAM_ENV }
  await compact($, 'auto')
  await clock.settle()
  expect([kr(writes), logs.filter((l) => l.startsWith('ledger-compact: no Now block found')).length]).toEqual([
    [['pass', 'read-error'], ['pass', 'no-now'], ['pass', 'closed']],
    1,
  ])
})
test('C11d a second auto with the same (reason, source) writes no second pass line; another reason does', async ($, on) => {
  const { clock, box, writes } = setup(on, { env: TEAM_ENV, files: {} })
  await compact($, 'auto')
  await compact($, 'auto')
  box.files[NOWMD] = team(null)[NOWMD]
  await compact($, 'auto')
  await clock.settle()
  expect(kr(writes)).toEqual([['pass', 'no-now'], ['pass', 'no-state']])
})
test('C11s a team now.md without a state: line is no-state, never closed', async ($, on) => {
  const { clock, writes } = setup(on, { env: TEAM_ENV, files: team(null) })
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.messages[0].text, kr(writes)]).toEqual([CORE, [['pass', 'no-state']]])
})
test('C12 fs.read throws → read-error, core summary', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.readHook = () => {
    throw new Error('EIO')
  }
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.messages[0].text, kr(writes)]).toEqual([CORE, [['pass', 'read-error']]])
})
test('C12t READ_MS: a read settling at 999 ms is used; at exactly 1000 ms it is lost (the hook’s race timer is registered before the read’s own sleep, so the tie is deterministic); at 1001 ms lost', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  const at = async (ms: number) => {
    box.readHook = (p: string) => (p === P019 ? clock.sleep(ms).then(() => undefined) : undefined)
    const x = compact($, 'auto')
    await clock.advance(ms)
    return x
  }
  const ra = await at(999)
  const rb = await at(1000)
  const rc = await at(1001)
  await clock.settle()
  expect([isRebuild(ra, 'idle'), rb.messages?.[0].text, rc.messages?.[0].text, kr(writes)]).toEqual([true, CORE, CORE, [['rebuild', 'idle'], ['pass', 'read-error']]])
})

test('C12n a read that never settles → read-error', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.readHook = (p: string) => (p === P019 ? NEVER() : undefined)
  const a = compact($, 'auto')
  await clock.advance(1000)
  await a
  await clock.settle()
  expect(kr(writes)).toEqual([['pass', 'read-error']])
})
test('C12s a spec without the Contents heading → read-error, core summary', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.files.SPEC = '# no contents here\n'
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.messages[0].text, kr(writes)]).toEqual([CORE, [['pass', 'read-error']]])
})
test('C12p our pending call arriving with the ledger unreadable → our skip "rebuild abandoned (read-error)", core not called', async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't2')
  box.readHook = () => {
    throw new Error('EIO')
  }
  const r = await compact($, 'plugin')
  expect([r.skip, box.coreIn.length]).toEqual(['ledger-compact: rebuild abandoned (read-error)', 0])
})
test('C13 ledger choice: 018 CLOSED/019 open → 019; both open → 019, with others [018] on the hold line', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT', 'CLOSED') })
  box.usage = usageOf(600000).value
  await start($)
  const a = await compact($, 'auto')
  box.files = { ...box.files, ...hub('IMPLEMENT', 'REVIEW') }
  await start($, 't3')
  const c = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.includes('LWO-019'), c.skip?.includes('LWO-019'), ours(writes).filter((l) => l.kind === 'hold').map((l) => l.others ?? null)]).toEqual([true, true, [null, [P018]]])
})

test('C13b 018 open and 019 first seen CLOSED: the in-turn hold names LWO-018', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('CLOSED', 'REVIEW') })
  box.usage = usageOf(600000).value
  await start($)
  const b = await compact($, 'auto')
  await clock.settle()
  expect(b.skip?.includes('while LWO-018 is open (State: REVIEW)')).toBe(true)
})
test('C13x discovery: a no-Now file, a directory and an iCloud " 2.md" copy are skipped; two files numbered 019 → the newer, with dupes on the line', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: ledger('IMPLEMENT'), [`${TASKS}/LWO-020-new.md`]: '# LWO-020\n(no Now yet)\n', [`${TASKS}/LWO-021-dir.md`]: '<dir>', [`${TASKS}/LWO-022-x 2.md`]: ledger('IMPLEMENT'), [`${TASKS}/LWO-019-other.md`]: ledger('REVIEW') } })
  box.mtimes[P019] = 5
  box.mtimes[`${TASKS}/LWO-019-other.md`] = 9
  box.usage = usageOf(600000).value
  await start($)
  const a = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.includes('LWO-019 is open (State: REVIEW)'), ours(writes).filter((l) => l.kind === 'hold').map((l) => l.dupes ?? null)]).toEqual([true, [[P019]]])
})
test('C13x1 R26: an evicted .icloud placeholder of an old number outside the read set is not a read error', async ($, on) => {
  const files: Record<string, string> = { [`${TASKS}/.LWO-003-old.md.icloud`]: 'placeholder' }
  for (let i = 10; i <= 14; i++) files[`${TASKS}/LWO-0${i}-x.md`] = ledger(i === 14 ? 'IMPLEMENT' : 'CLOSED')
  const { clock, box } = setup(on, { files })
  box.usage = usageOf(600000).value
  await start($)
  const r = await compact($, 'auto')
  await clock.settle()
  expect(r.skip?.includes('LWO-014')).toBe(true)
})
test('C13x2 R26: a placeholder for a number in the read set (the top 3) is a read error', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: ledger('IMPLEMENT'), [`${TASKS}/.LWO-023-x.md.icloud`]: 'placeholder' } })
  box.usage = usageOf(600000).value
  await start($)
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.messages?.[0].text, kr(writes).slice(-1)]).toEqual([CORE, [['pass', 'read-error']]])
})

test('C13r read set: the load scan reads all 16; a later turn reads open + top 3, capped at the 8 newest, and a read-set line carries capped:3', async ($, on) => {
  const files: Record<string, string> = {}
  for (let i = 10; i <= 25; i++) files[`${TASKS}/LWO-0${i}-x.md`] = ledger(i >= 16 ? 'IMPLEMENT' : i === 12 ? 'REVIEW' : 'CLOSED')
  const { clock, box, writes } = setup(on, { files })
  await turn($, box, clock, 100, 't1')
  const firstReads = new Set(box.reads.filter((p) => p.includes('/lab/tasks/'))).size
  box.reads.length = 0
  await turn($, box, clock, 100, 't2')
  const second = new Set(box.reads.filter((p) => p.includes('/lab/tasks/')))
  for (let i = 26; i <= 27; i++) box.files[`${TASKS}/LWO-0${i}-x.md`] = ledger('IMPLEMENT')
  await turn($, box, clock, 100, 't3')
  await turn($, box, clock, 100, 't4')
  expect([firstReads, second.size, second.has(`${TASKS}/LWO-025-x.md`), second.has(`${TASKS}/LWO-012-x.md`), ours(writes).filter((l) => l.reason === 'read-set').map((l) => l.capped)]).toEqual([16, 8, true, false, [3, 5]])
})

test('C13p State parsing (R21 and the named rows)', () => {
  const L = (t: string) => stateOf(t, true)
  const N = (t: string) => stateOf(t, false)
  expect([
    L('Order: "x". Tier: L. State: IMPLEMENT.\n- State: CLOSED (draft)'),
    L('Order: see e.g. State: CLOSED rule. Tier: L. State: IMPLEMENT.'),
    L('State: REVIEW\nWaiting for: x.'),
    N('state: closed'),
    N('- state: CLOSED'),
    L('**State:** CLOSED'),
    L('State: .'),
    L('State: Closedown.'),
    L('State: CLOSED? no — REOPENED for v3.'),
    L('Order: "fix it. State: CLOSED when done". Tier: L. State: IMPLEMENT.'),
    L('Order: fix the 3" screen. Tier: L. State: CLOSED.'),
    L('Order: fix the state: key in now.md (#66). Tier: L. State: IMPLEMENT.'),
    N('remember to set state: CLOSED on close'),
    L('Order: “wrap up. State: CLOSED”. Tier: L. State: AUDIT.'),
    L('State: IMPLEMENT. Order: "then. State: CLOSED"'),
    L('Order: "wrap up. State: CLOSED"\nTier: L. State: IMPLEMENT.'),
    L(FIX.ledger018.split('## Now\n')[1].split('## Log')[0]),
    L(FIX.ledger019.split('## Now\n')[1].split('## Log')[0]),
    N(FIX.nowOpen),
    N(FIX.nowClosed),
  ]).toEqual([
    { value: 'IMPLEMENT', closed: false },
    { value: 'IMPLEMENT', closed: false },
    { value: 'REVIEW', closed: false },
    { value: 'closed', closed: true },
    { value: 'CLOSED', closed: true },
    { value: 'CLOSED', closed: true },
    null,
    { value: 'Closedown', closed: false },
    { value: 'CLOSED? no — REOPENED for v3', closed: false },
    { value: 'IMPLEMENT', closed: false },
    { value: 'CLOSED', closed: true },
    { value: 'IMPLEMENT', closed: false },
    null,
    { value: 'AUDIT', closed: false },
    { value: 'IMPLEMENT', closed: false },
    { value: 'IMPLEMENT', closed: false },
    { value: 'CLOSED', closed: true },
    { value: 'AUDIT r1 (running)', closed: false },
    { value: 'IMPLEMENT', closed: false },
    { value: 'CLOSED (PR merged)', closed: true },
  ])
})
test('C13n Now block: the first ## Now counts and ends at the next ## heading; a State under ## Log does not make a Now block a ledger', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: '# L\n## Now\nOrder: "x". Tier: L. State: IMPLEMENT.\n## Now\nState: CLOSED.\n## Other\nState: CLOSED.\n' } })
  box.usage = usageOf(600000).value
  await start($)
  const r = await compact($, 'auto')
  box.files[P019] = '# L\n## Now\nOrder: "x". Waiting.\n## Log\n- State: CLOSED.\n'
  const r2 = await compact($, 'auto')
  await clock.settle()
  expect([ledgerNow('# L\n## Now\na\n## Log\nb'), r.skip?.includes('(State: IMPLEMENT)'), r2.messages?.[0].text, kr(writes).slice(-1)]).toEqual(['a', true, CORE, [['pass', 'closed']]])
})

test('C14 a step boundary: 299,999 starts nothing; 300,000 starts a call, then rebuild/step', async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('REVIEW') })
  box.usage = usageOf(299999).value
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('IMPLEMENT')
  await turn($, box, clock, 100, 't2')
  const a = box.pluginCalls
  box.files[P019] = ledger('VERIFY')
  box.usage = usageOf(300000).value
  hold()
  await turn($, box, clock, 100, 't3')
  const r = await compact($, 'plugin')
  expect([a, box.pluginCalls, isRebuild(r, 'step')]).toEqual([0, 1, true])
})
test('C14f the first observation after a load, open at 400,000, starts nothing', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(400000).value
  await turn($, box, clock, 100, 't1')
  expect(box.pluginCalls).toBe(0)
})
test('C15 no State change: 899,999 starts nothing; 900,000 → our call rebuilds (guard)', async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(899999).value
  await turn($, box, clock, 100, 't1')
  const a = box.pluginCalls
  box.usage = usageOf(900000).value
  hold()
  await turn($, box, clock, 100, 't2')
  const r = await compact($, 'plugin')
  expect([a, box.pluginCalls, isRebuild(r, 'guard')]).toEqual([0, 1, true])
})
test('C15u turn.complete measures with usage: lastStep 880,000 and usage 905,000 → a call', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(905000).value
  await turn($, box, clock, 880000, 't1')
  expect(box.pluginCalls).toBe(1)
})
test('C15s stale at 900,000 at turn.complete → our call reconciles', async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(100).value
  for (let i = 0; i <= 30; i++) await turn($, box, clock, 100, 'c' + i)
  box.usage = usageOf(900000).value
  hold()
  await turn($, box, clock, 100, 'x')
  const r = await compact($, 'plugin')
  expect(r.messages?.[0].text).toBe('RECONCILE: re-read the ledger log; the Now section may be out of date')
})
test('C15r a guard rebuild that left the size at 915,000 suppresses the next guard call (guard-no-gain) until it falls below and rises again', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(920000).value
  await turn($, box, clock, 100, 't1')
  await clock.settle()
  box.usage = usageOf(915000).value
  await turn($, box, clock, null, 't2')
  const a = box.pluginCalls
  box.usage = usageOf(880000).value
  await turn($, box, clock, null, 't3')
  box.usage = usageOf(905000).value
  await turn($, box, clock, null, 't4')
  expect([a, box.pluginCalls, kr(writes).filter((x) => x[1] === 'guard-no-gain').length, ours(writes).filter((l) => l.reason === 'rebuild-size').map((l) => [l.for, l.tokens])]).toEqual([1, 2, 1, []])
})

// ── idle variants ──────────────────────────────────────────────────────────

test('[hold] C16 idle at 25% → hold/idle', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(250000).value
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.skip?.startsWith(HELD), kr(writes)]).toEqual([true, [['hold', 'idle']]])
})
test('[hold] C16v idle at 900,000 → rebuild/guard; idle with usage lost → rebuild/no-engine-size; idle at 600,000 → hold with 60.0%', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(900000).value
  await compact($, 'auto')
  box.usageHook = NEVER
  const p = compact($, 'auto')
  await clock.advance(150)
  await p
  box.usageHook = null
  box.usage = usageOf(600000).value
  const c = await compact($, 'auto')
  await clock.settle()
  expect([kr(writes), c.skip?.includes('60.0%')]).toEqual([[['rebuild', 'guard'], ['rebuild', 'no-engine-size'], ['hold', 'idle']], true])
})
test('[above-soft] C17 idle at 299,999 → hold; at 300,000 → rebuild/idle', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(299999).value
  const a = await compact($, 'auto')
  box.usage = usageOf(300000).value
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.startsWith(HELD), isRebuild(b, 'idle')]).toEqual([true, true])
})
test('[above-soft] C17v idle with usage lost → rebuild/no-engine-size', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usageHook = NEVER
  const p = compact($, 'auto')
  await clock.advance(150)
  await p
  await clock.settle()
  expect(kr(writes)).toEqual([['rebuild', 'no-engine-size']])
})

// ── other triggers, ownership and switches ─────────────────────────────────

test('C18 precompute: order open → our skip; closed → next(e); no Now → next(e)', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  const a = await compact($, 'precompute')
  box.files[P019] = ledger('CLOSED')
  const b = await compact($, 'precompute')
  box.env = { ...TEAM_ENV }
  const c = await compact($, 'precompute')
  await clock.settle()
  expect([a.skip, b.messages?.[0].text, c.messages?.[0].text]).toEqual(['ledger-compact: precompute off during an open order', CORE, CORE])
})
test('C19 ownerOf (R22): named us → ours; named another plugin → foreign, with or without our call pending; nameless → ours only while our call is in flight', () => {
  const me = 'ledger-compact-kit'
  const inFlight = { phase: 'inFlight' }
  const rejected = { phase: 'rejected' }
  expect([
    ownerOf({ plugin: me, tier: 'user' }, me, null),
    ownerOf({ plugin: 'other-plugin', tier: 'user' }, me, inFlight),
    ownerOf({ plugin: 'other-plugin', tier: 'user' }, me, null),
    ownerOf({ kind: 'engine' }, me, inFlight),
    ownerOf({ kind: 'engine' }, me, rejected),
    ownerOf(undefined, me, null),
  ]).toEqual(['ours', 'foreign', 'foreign', 'ours', 'foreign', 'foreign'])
})
test('C19f a nameless plugin compaction with no call of ours out passes through (pass/plugin), core called', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  const r = await compact($, 'plugin')
  await clock.settle()
  expect([r.messages?.[0].text, box.coreIn.length, kr(writes)]).toEqual([CORE, 1, [['pass', 'plugin']]])
})
test('C19a PENDING_MS: ours with pending 119,999 ms old → built; 120,000 ms old → aged skip, the reset not marked done', async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't2')
  await clock.advance(119999)
  const a = await compact($, 'plugin')
  await clock.advance(1)
  const b = await compact($, 'plugin')
  expect([isRebuild(a, 'closed'), b.skip]).toEqual([true, 'ledger-compact: own call aged'])
})
test('C20 env OMT_LEDGER_COMPACT=off: everything passes, no line', async ($, on) => {
  const { clock, box, writes } = setup(on, { env: { ...HUB_ENV, OMT_LEDGER_COMPACT: 'off' }, files: hub('IMPLEMENT') })
  const r = await compact($, 'auto')
  await turn($, box, clock, 950000, 't1')
  expect([r.messages[0].text, box.pluginCalls, kr(writes)]).toEqual([CORE, 0, []])
})
test('C20f the off file: everything passes, no line', async ($, on) => {
  const { clock, writes } = setup(on, { files: { ...hub('IMPLEMENT'), [`${LOGDIR}ledger-compact.off`]: '' } })
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.messages[0].text, kr(writes)]).toEqual([CORE, []])
})
test('C20t CLAUDE_CODE_TEAMMATE set: everything passes', async ($, on) => {
  const { clock, writes } = setup(on, { env: { ...HUB_ENV, CLAUDE_CODE_TEAMMATE: '1' }, files: hub('IMPLEMENT') })
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.messages[0].text, kr(writes)]).toEqual([CORE, []])
})
test('C20s no SESSION_NAME: everything passes, one notice per load', async ($, on) => {
  const { clock, logs } = setup(on, { env: { HOME, OMT_VAULT_ROOT: V }, files: hub('IMPLEMENT') })
  const r = await compact($, 'auto')
  await compact($, 'auto')
  await clock.settle()
  expect([r.messages[0].text, logs.filter((l) => l.includes('no SESSION_NAME')).length]).toEqual([CORE, 1])
})
test('C20p our call in flight, then the off file appears: our event gets {skip: off}, core not called', async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't2')
  box.files[`${LOGDIR}ledger-compact.off`] = ''
  const r = await compact($, 'plugin')
  expect([r.skip, box.coreIn.length]).toEqual(['ledger-compact: off', 0])
})
test('C20w ctx-log off after a thrown write: the next event (an in-turn 600,000, a hold candidate) passes, one off notice', async ($, on) => {
  const { clock, box, logs } = setup(on, { files: hub('IMPLEMENT') })
  box.env.__WRITE_THROWS = '1'
  await turn($, box, clock, 100, 't1')
  await clock.settle()
  box.usage = usageOf(600000).value
  await start($, 't2')
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.messages?.[0].text, logs.filter((l) => l.startsWith('ledger-compact: off for this session (context logging stopped)')).length]).toEqual([CORE, 1])
})
test('C20v every fs.write path is under <HOME>/.omt-scratch/lab-ctx/', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  await compact($, 'auto')
  await compact($, 'manual')
  await clock.settle()
  expect([writes.length > 0, writes.every((w) => w.path.startsWith(LOGDIR))]).toEqual([true, true])
})
test('C20e a throw outside the bounded reads (env.get): an auto passes on (pass/hook-error), our own call is refused (core not called)', async ($, on) => {
  const { clock, box, writes, hold } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't2')
  box.envThrow = true
  const before = box.coreIn.length
  const a = await compact($, 'auto')
  const b = await compact($, 'plugin')
  await clock.settle()
  expect([a.messages?.[0].text, box.coreIn.length - before, b.skip, kr(writes).slice(-2)]).toEqual([CORE, 1, 'ledger-compact: rebuild abandoned (hook-error)', [['pass', 'hook-error'], ['rebuild', 'abandoned']]])
})

// ── wrap order, hold lines, the transcript fallback ────────────────────────

test("C21 wrap order ctx-mod ⊃ ctx-log ⊃ ledger-compact: a rebuild gives ctx-log's compact line (before 359,000, after null); a hold gives none", async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await compact($, 'auto')
  await clock.settle()
  const first = lines(writes).filter((l) => l.kind === 'compact')
  box.usage = usageOf(600000).value
  await start($)
  await compact($, 'auto')
  await clock.settle()
  expect([first.map((l) => [l.trigger, l.before, l.after]), lines(writes).filter((l) => l.kind === 'compact').length]).toEqual([[['auto', 359000, null]], 1])
})
test('C22 ask, step, ask, step, ask (in a turn, 600,000) → 3 skips, 1 hold line, then a holds line with count 3 at turn.complete', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(600000).value
  await start($)
  const r = [await compact($, 'auto')]
  await step($, box, 1)
  r.push(await compact($, 'auto'))
  await step($, box, 1, 't1', 1)
  r.push(await compact($, 'auto'))
  box.usage = usageOf(100).value
  await complete($)
  await clock.settle()
  expect([r.map((x) => x.skip?.startsWith(HELD)), ours(writes).map((l) => [l.kind, l.count ?? null])]).toEqual([
    [true, true, true],
    [['hold', null], ['holds', 3]],
  ])
})
test('[hold] C22h an in-turn hold in T1, then an idle hold → two hold lines', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(600000).value
  await start($)
  await compact($, 'auto')
  box.usage = usageOf(100).value
  await complete($)
  await clock.settle()
  box.usage = usageOf(600000).value
  await compact($, 'auto')
  await clock.settle()
  expect(ours(writes).filter((l) => l.kind === 'hold').map((l) => l.reason)).toEqual(['below-guard', 'idle'])
})
test('C23 usage never answers and no step yet, in a turn → rebuild/no-engine-size', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usageHook = NEVER
  await start($)
  const p = compact($, 'auto')
  await clock.advance(150)
  await p
  await clock.settle()
  expect(kr(writes)).toEqual([['rebuild', 'no-engine-size']])
})
test('C23i usage never answers, idle → rebuild/idle', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usageHook = NEVER
  const p = compact($, 'auto')
  await clock.advance(150)
  await p
  await clock.settle()
  expect(kr(writes)).toEqual([['rebuild', 'idle']])
})
test('C23b idle at 250,000 under the shipped rule → rebuild/idle', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(250000).value
  await compact($, 'auto')
  await clock.settle()
  expect(kr(writes)).toEqual([['rebuild', 'idle']])
})
test('C24 an event with no messages (as the kit raises our own call) reads the transcript from $.session.messages()', async ($, on) => {
  const { clock, box, hold } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('CLOSED')
  hold()
  await turn($, box, clock, 100, 't2')
  box.transcript = rows('U A U')
  const r = await $.session.compact({ trigger: 'plugin' } as any)
  expect([isRebuild(r, 'closed'), r.messages.slice(-3).map((m: any) => m.handle)]).toEqual([true, ['h0', 'h1', 'h2']])
})
test('C13s SCAN_TOP: three new ledgers created at once are all read at the next turn.complete', async ($, on) => {
  const files: Record<string, string> = {}
  for (let i = 10; i <= 12; i++) files[`${TASKS}/LWO-0${i}-x.md`] = ledger('CLOSED')
  const { clock, box } = setup(on, { files })
  await turn($, box, clock, 100, 't1')
  for (let i = 13; i <= 15; i++) box.files[`${TASKS}/LWO-0${i}-x.md`] = ledger('IMPLEMENT')
  box.reads.length = 0
  await turn($, box, clock, 100, 't2')
  const r = new Set(box.reads)
  expect([13, 14, 15].map((i) => r.has(`${TASKS}/LWO-0${i}-x.md`))).toEqual([true, true, true])
})

// ── v4.3 (§14.6) ───────────────────────────────────────────────────────────

test('C12o R23 the spec is read from $OMT_PLUGIN_DIR/docs/ when it is set, else from the plugin root', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('IMPLEMENT') })
  box.env.OMT_PLUGIN_DIR = '/checkout'
  await compact($, 'auto')
  const a = box.reads.filter((p) => p.endsWith('/docs/corp-mode-spec.md'))
  delete box.env.OMT_PLUGIN_DIR
  box.reads.length = 0
  await compact($, 'auto')
  const b = box.reads.filter((p) => p.endsWith('/docs/corp-mode-spec.md'))
  await clock.settle()
  expect([a, b.length === 1 && !b[0].startsWith('/checkout/')]).toEqual([['/checkout/docs/corp-mode-spec.md'], true])
})
test('C6gs a stale guard (Now unchanged 30 turns, 920,000), every call rejected: calls at three turns, then abandoned once, no new cycle', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(100).value
  for (let i = 0; i <= 30; i++) await turn($, box, clock, 100, 'c' + i)
  box.usage = usageOf(920000).value
  box.pluginReject = new Error('a turn runs')
  const calls: number[] = []
  for (const t of ['t1', 't2', 't3', 't4', 't5', 't6']) {
    await turn($, box, clock, 100, t)
    calls.push(box.pluginCalls)
  }
  expect([calls, ours(writes).filter((l) => l.reason === 'abandoned').map((l) => l.for)]).toEqual([[1, 2, 3, 3, 3, 3], ['stale']])
})
test('C20m the off file and a manual /compact: next(e), no line', async ($, on) => {
  const { clock, writes } = setup(on, { files: { ...hub('IMPLEMENT'), [`${LOGDIR}ledger-compact.off`]: '' } })
  const r = await compact($, 'manual')
  await clock.settle()
  expect([r.messages[0].text, kr(writes)]).toEqual([CORE, []])
})
test('C15z the turn.complete after an installed rebuild writes one rebuild-size line with the new size', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await compact($, 'auto')
  box.usage = usageOf(42000).value
  await turn($, box, clock, 100, 't1')
  await turn($, box, clock, 100, 't2')
  expect(ours(writes).filter((l) => l.reason === 'rebuild-size').map((l) => [l.for, l.tokens])).toEqual([['idle', 42000]])
})
test('C10c the safety-net instructions carry the Now text cut at 32,768 bytes', async ($, on) => {
  const { clock, box } = setup(on, { files: { [P019]: ledger('IMPLEMENT', '\n' + 'y'.repeat(40000)) } })
  await compact($, 'auto')
  await clock.settle()
  expect([box.coreIn[0].instructions.includes('[cut at 32768 bytes]'), box.coreIn[0].instructions.length < 34000]).toEqual([true, true])
})
test('C20e2 env.get throws at turn.complete: the turn keeps the bottom’s answer and one hook-error line is written', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  await turn($, box, clock, 100, 't0')
  box.envThrow = true
  await start($, 't1')
  const r = await complete($, 't1')
  await clock.settle()
  expect([r, kr(writes).filter((x) => x[1] === 'hook-error').length]).toEqual([{ text: '' }, 1])
})
test('C2c2 after an auto that passes through to the core summary, lastStepTokens is cleared: the next turn.complete with no step starts nothing', async ($, on) => {
  const { clock, box } = setup(on, { files: hub('CLOSED') })
  await start($)
  await step($, box, 950000)
  box.usage = usageOf(null).value
  await compact($, 'auto')
  box.files[P019] = ledger('IMPLEMENT')
  await complete($)
  await clock.settle()
  expect(box.pluginCalls).toBe(0)
})
test('C6q a rejected guard call, then a manual /compact: at the next turn (10%) there is no retry', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(920000).value
  box.pluginReject = new Error('busy')
  await turn($, box, clock, 100, 't1')
  box.pluginReject = null
  await compact($, 'manual')
  box.usage = usageOf(100000).value
  await turn($, box, clock, 100, 't2')
  expect([box.pluginCalls, kr(writes).filter((x) => x[1] === 'retry-dropped').length]).toEqual([1, 0])
})
test('C6qr a rejected guard call whose size then falls below the guard is dropped (retry-dropped), not retried', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: hub('IMPLEMENT') })
  box.usage = usageOf(920000).value
  box.pluginReject = new Error('busy')
  await turn($, box, clock, 100, 't1')
  box.pluginReject = null
  box.usage = usageOf(500000).value
  await turn($, box, clock, 100, 't2')
  expect([box.pluginCalls, kr(writes).filter((x) => x[1] === 'retry-dropped').length]).toEqual([1, 1])
})
test('C6c R27 two open hub ledgers: the note carries both Now blocks, LWO-020 before LWO-019', async ($, on) => {
  const { clock } = setup(on, { files: { ...hub('IMPLEMENT'), [`${TASKS}/LWO-020-z.md`]: ledger('REVIEW') } })
  const r = await compact($, 'auto')
  await clock.settle()
  const t: string = r.messages[0].text
  expect([t.indexOf('== Now: LWO-020 (hub ledger) ==') > 0, t.indexOf('== Now: LWO-019 (hub ledger) ==') > t.indexOf('== Now: LWO-020 (hub ledger) ==')]).toEqual([true, true])
})
test('C9u a tool_result whose tool_use is not in the conversation at all is dropped with the leading rows: [Ur(gone), A, U, A] → 3 rows', () => {
  const m = rows('U A U A').slice(1)
  const orphan = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'gone', text: 'r', isError: false }], handle: 'hx' } as any
  expect(tailOf([orphan, ...m]).map((x: any) => x.handle)).toEqual(['h1', 'h2', 'h3'])
})
test('C9n an earlier rebuild note never comes back in a tail', () => {
  const note = { role: 'user', text: 'LEDGER REBUILD by hooks/ledger-compact.js (idle): old', toolUses: [], handle: 'n0' } as any
  const t = tailOf([note, ...rows('U A U A')])
  expect(t.map((x: any) => x.handle)).toEqual(['h0', 'h1', 'h2', 'h3'])
})
test('C20r our post-next code is guarded: a throw after next returns our skip for our own call and null (the core result stands) otherwise', async ($, on) => {
  const { clock, writes } = setup(on, { files: hub('IMPLEMENT') })
  const boom = () => {
    throw new TypeError('malformed')
  }
  const a = afterNext($, {}, true, boom)
  const b = afterNext($, {}, false, boom)
  const c = afterNext($, {}, true, () => 'fine')
  await clock.settle()
  void writes
  expect([a, b, c]).toEqual([{ skip: 'ledger-compact: rebuild abandoned (hook-error)' }, null, 'fine'])
})

// ── v4.4 (§14.7) ───────────────────────────────────────────────────────────

test('C13o B1 a read superseded by a newer one (a precompute during turn.complete) decides nothing: no call at that turn, the close acted on at the next', async ($, on) => {
  const files: Record<string, string> = {}
  for (let i = 10; i <= 25; i++) files[`${TASKS}/LWO-0${i}-x.md`] = ledger('IMPLEMENT')
  const { clock, box } = setup(on, { files })
  box.usage = usageOf(100).value
  await turn($, box, clock, 100, 't1')
  box.files[`${TASKS}/LWO-025-x.md`] = ledger('CLOSED')
  box.mtimes[`${TASKS}/LWO-025-x.md`] = 2
  let held = false
  box.readHook = (p: string) => {
    if (!held && p === `${TASKS}/LWO-024-x.md`) {
      held = true
      return clock.sleep(500).then(() => undefined)
    }
    return undefined
  }
  await start($, 't2')
  const done = complete($, 't2')
  await clock.settle()
  await compact($, 'precompute')
  await clock.advance(500)
  await done
  await clock.settle()
  const atT2 = box.pluginCalls
  await turn($, box, clock, 100, 't3')
  expect([held, atT2, box.pluginCalls]).toEqual([true, 0, 1])
})
test('C6c2 B4 three open Now blocks of 20 KiB each: the joined Now sections are cut once, at 32,768 bytes', async ($, on) => {
  const big = '\n' + 'z'.repeat(20000)
  const { clock } = setup(on, { files: { [P019]: ledger('IMPLEMENT', big), [`${TASKS}/LWO-020-z.md`]: ledger('REVIEW', big), [`${TASKS}/LWO-021-z.md`]: ledger('VERIFY', big) } })
  const r = await compact($, 'auto')
  await clock.settle()
  const t: string = r.messages[0].text
  const nowPart = t.slice(t.indexOf('== Now:'), t.indexOf('== Standing rulings =='))
  expect([nowPart.split('[cut at 32768 bytes]').length - 1, nowPart.length < 32900]).toEqual([1, true])
})

// ── the operator wait (#69 B) ──────────────────────────────────────────────

const nowOf = (t: string) => t.split('## Now\n')[1].split('## Log')[0]
const W019 = (extra = ' Open asks: a1.') => ledger('IMPLEMENT', extra)
const holdLines = (writes: { text: string }[]) => ours(writes).filter((l) => l.kind === 'hold')
const pick = (l: any) => ({ reason: l.reason, source: l.source, state: l.state, others: l.others ?? null, wait: l.wait ?? null, waitSource: l.waitSource ?? null })
const noHookError = (writes: { text: string }[]) => !ours(writes).some((l) => l.reason === 'hook-error')

test('C30 waitOf finds a wait: open asks, pending taps, each waiting-for word, bullet, bold, case, mid-line, the recorded LWO-019 block', () => {
  expect([
    waitOf('Open asks: 848970f4'),
    waitOf('Pending taps: push tap'),
    waitOf('Waiting for: operator pick on ask a1'),
    waitOf("Waiting for: the operator's tap"),
    waitOf('Waiting for: the push tap'),
    waitOf('Waiting for: escalation e1'),
    waitOf('Waiting for: escalations e1 and e2'),
    waitOf('Waiting for: the operators'),
    waitOf('- Open asks: a1'),
    waitOf('- **Open asks:** a1'),
    waitOf('OPEN ASKS: a1'),
    waitOf('State: X. Open asks: a1.'),
    waitOf(nowOf(FIX.ledger019)),
  ]).toEqual([
    { key: 'open-asks', value: '848970f4' },
    { key: 'pending-taps', value: 'push tap' },
    { key: 'waiting-for', value: 'operator pick on ask a1' },
    { key: 'waiting-for', value: "the operator's tap" },
    { key: 'waiting-for', value: 'the push tap' },
    { key: 'waiting-for', value: 'escalation e1' },
    { key: 'waiting-for', value: 'escalations e1 and e2' },
    { key: 'waiting-for', value: 'the operators' },
    { key: 'open-asks', value: 'a1' },
    { key: 'open-asks', value: 'a1' },
    { key: 'open-asks', value: 'a1' },
    { key: 'open-asks', value: 'a1' },
    { key: 'open-asks', value: '848970f4' },
  ])
})

test('C30n waitOf finds none: none and nothing with their notes, a waiting-for with no word, an empty value, no key, the recorded LWO-018 block', () => {
  expect([
    waitOf('Open asks: none'),
    waitOf('Open asks: none (779f2d08 answered by the 12:31Z tap)'),
    waitOf('Pending taps: none (operator restart is their choice)'),
    waitOf('Waiting for: nothing (operator restart)'),
    waitOf('Waiting for: audit r1 reports'),
    waitOf('Waiting for: tapped out'),
    waitOf('Open asks:'),
    waitOf('Tier: M. State: X.'),
    waitOf(nowOf(FIX.ledger018)),
  ]).toEqual([null, null, null, null, null, null, null, null, null])
})

test('C30r waitOf key rules: first line wins, an empty first value is none, last instance on a line, a quoted key is ignored, a key after words is not a key', () => {
  expect([
    waitOf('Open asks: none.\nOpen asks: a1.'),
    waitOf('Open asks: a1.\nOpen asks: none.'),
    waitOf('Open asks: a2\nOpen asks: a1.'),
    waitOf('Open asks:\nOpen asks: a1.'),
    waitOf('Open asks: a1. Open asks: none.'),
    waitOf('Open asks: none. Open asks: a1.'),
    waitOf('Order: "do it. Open asks: a1". Tier: M.'),
    waitOf('Order: do it. Open asks: a1. Tier: M.'),
    waitOf('Order: Open asks: a1. Tier: M.'),
    waitOf('Open asks: a1 "is it v2. or v3". Tier: M.'),
  ]).toEqual([
    null,
    { key: 'open-asks', value: 'a1' },
    { key: 'open-asks', value: 'a2' },
    null,
    null,
    { key: 'open-asks', value: 'a1' },
    null,
    { key: 'open-asks', value: 'a1' },
    null,
    { key: 'open-asks', value: 'a1' },
  ])
})

test('C30a waitOf accepted shapes: (none) and n/a and a no-operator note read as a wait; a key after ";" reads none', () => {
  expect([
    waitOf('Open asks: (none)'),
    waitOf('Open asks: n/a'),
    waitOf('Waiting for: audit r1, since 04:00Z; Open asks: a1.'),
    waitOf('Waiting for: hub re-run (no operator input needed)'),
  ]).toEqual([
    { key: 'open-asks', value: '(none)' },
    { key: 'open-asks', value: 'n/a' },
    null,
    { key: 'waiting-for', value: 'hub re-run (no operator input needed)' },
  ])
})

test('C31 an idle auto at 359,000 with LWO-019 asking the operator is held: the notice, core not called, one hold/idle-wait line with wait and waitSource', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: ledger('IMPLEMENT', ' Open asks: 848970f4.') } })
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.skip, box.coreIn.length, kr(writes), holdLines(writes).map(pick)]).toEqual([
    'ledger-compact: held at 35.9% (359000) < guard 90% while LWO-019 waits on the operator (open-asks); /compact still runs',
    0,
    [['hold', 'idle-wait']],
    [{ reason: 'idle-wait', source: P019, state: 'IMPLEMENT', others: null, wait: 'open-asks', waitSource: P019 }],
  ])
})

test('C31r the recorded blocks: LWO-019 (an open ask) is held; LWO-018 reopened (none, nothing) is rebuilt (idle)', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: FIX.ledger019 } })
  const a = await compact($, 'auto')
  const coreA = box.coreIn.length
  await turn($, box, clock, 100, 't1')
  delete box.files[P019]
  box.files[P018] = FIX.ledger018.replace('State: CLOSED.', 'State: REVIEW.')
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.startsWith(HELD), coreA, isRebuild(b, 'idle'), kr(writes).filter(([k]) => k !== 'pass'), noHookError(writes)]).toEqual([true, 0, true, [['hold', 'idle-wait'], ['rebuild', 'idle']], true])
})

test('C31p each key alone, with one-value twins: pending taps "push tap" held, "none (operator …)" rebuilt; waiting for "operator pick" held, "audit r1" rebuilt', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: W019(' Pending taps: push tap.') } })
  const out: unknown[] = []
  const go = async (extra: string, id: string) => {
    box.files[P019] = W019(extra)
    const n = box.coreIn.length
    const r = await compact($, 'auto')
    out.push(r.skip?.startsWith(HELD) ? ['held', box.coreIn.length - n] : isRebuild(r, 'idle') ? 'rebuild/idle' : r)
    await turn($, box, clock, 100, id)
  }
  await go(' Pending taps: push tap.', 't1')
  await go(' Pending taps: none (operator restart is their choice).', 't2')
  const goW = async (waiting: string, id: string) => {
    box.files[P019] = ledger('IMPLEMENT').replace('Waiting for: x.', `Waiting for: ${waiting}.`)
    const n = box.coreIn.length
    const r = await compact($, 'auto')
    out.push(r.skip?.startsWith(HELD) ? ['held', box.coreIn.length - n] : isRebuild(r, 'idle') ? 'rebuild/idle' : r)
    await turn($, box, clock, 100, id)
  }
  await goW('operator pick on ask a1', 't3')
  await goW('audit r1', 't4')
  await clock.settle()
  expect([out, noHookError(writes)]).toEqual([[['held', 0], 'rebuild/idle', ['held', 0], 'rebuild/idle'], true])
})

test('C32 the guard edge while waiting: 899,999 is held (idle-wait, 89.9%), 900,000 is rebuilt (guard)', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: W019() } })
  box.usage = usageOf(899999).value
  const a = await compact($, 'auto')
  box.usage = usageOf(900000).value
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.includes('89.9%'), box.coreIn.length > 0, isRebuild(b, 'guard'), kr(writes)]).toEqual([true, true, true, [['hold', 'idle-wait'], ['rebuild', 'guard']]])
})

test('C32u size unknown while waiting: usage never answers, a window of 0 with the engine known, the engine silent after a primed turn → rebuilt (no-engine-size); each twin with the size known is held', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: W019() } })
  const got: unknown[] = []
  const say = (r: any) => (r?.skip?.startsWith(HELD) ? 'held' : isRebuild(r, 'no-engine-size') ? 'no-engine-size' : isRebuild(r, 'guard') ? 'guard' : 'other')
  // (b) fresh module, window 0, engine 359,000: the window is unknown
  box.usage = usageOf(359000, 0).value
  got.push(say(await compact($, 'auto')))
  // twin: the window known
  box.usage = usageOf(359000).value
  got.push(say(await compact($, 'auto')))
  await turn($, box, clock, 359000, 't1') // primes lastStepTokens 359,000 and the window
  // (c) the engine gives no tokens: the engine's figure is unknown, the size is known from the step
  box.usage = usageOf(null).value
  got.push(say(await compact($, 'auto')))
  await turn($, box, clock, 359000, 't2')
  box.usage = usageOf(359000).value
  got.push(say(await compact($, 'auto')))
  await turn($, box, clock, 359000, 't3')
  // (a) usage never answers
  box.usageHook = NEVER
  const p = compact($, 'auto')
  await clock.advance(150)
  got.push(say(await p))
  box.usageHook = null
  await clock.settle()
  expect([got, ours(writes).filter((l) => l.kind === 'hold' || l.kind === 'rebuild').map((l) => [l.kind, l.reason])]).toEqual([
    ['no-engine-size', 'held', 'no-engine-size', 'held', 'no-engine-size'],
    [['rebuild', 'no-engine-size'], ['hold', 'idle-wait'], ['rebuild', 'no-engine-size'], ['hold', 'idle-wait'], ['rebuild', 'no-engine-size']],
  ])
})

test('C33 pass-throughs with a wait open: manual → next(e) and pass/manual; a sub-agent → next(e), no line; a teammate → next(e), no line; precompute → our skip', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: W019() } })
  box.usage = usageOf(500000).value
  const m1 = await compact($, 'manual', rows('U A'))
  box.usage = usageOf(950000).value
  const m2 = await compact($, 'manual', rows('U A'))
  const sa = await compact($, 'auto', rows('U A'), { agentId: 'a1' })
  const pc = await compact($, 'precompute')
  box.env.CLAUDE_CODE_TEAMMATE = '1'
  const tm = await compact($, 'auto', rows('U A'))
  await clock.settle()
  expect([m1.messages[0].text, m2.messages[0].text, sa.messages[0].text, pc.skip, tm.messages[0].text, box.coreIn.map((c) => c.trigger), kr(writes)]).toEqual([
    CORE,
    CORE,
    CORE,
    'ledger-compact: precompute off during an open order',
    CORE,
    ['manual', 'manual', 'auto', 'auto'],
    [['pass', 'manual'], ['pass', 'manual']],
  ])
})

test('C33c closed wins over a wait: with 018 waiting an idle auto is held for 018; then 019 → CLOSED between turns → the next idle auto is rebuild/closed (Now LWO-018), no second hold', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: ledger('IMPLEMENT'), [P018]: W019() } })
  await turn($, box, clock, 100, 't1')
  await turn($, box, clock, 100, 't2')
  const a = await compact($, 'auto')
  box.pluginReject = new Error('rejected below')
  box.files[P019] = ledger('CLOSED')
  await turn($, box, clock, 100, 't3')
  box.pluginReject = null
  const r = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.includes('while LWO-018 waits on the operator'), isRebuild(r, 'closed'), r.messages?.[0].text.includes('== Now: LWO-018 (hub ledger) =='), holdLines(writes).map((l) => [l.reason, l.waitSource])]).toEqual([true, true, true, [['idle-wait', P018]]])
})

test('C33t a team now.md with an "Open asks: a1" line: an idle auto is rebuilt (idle), no hold line', async ($, on) => {
  const { clock, writes } = setup(on, { env: TEAM_ENV, files: { [NOWMD]: '# Now — LWO-019\norder: LWO-019\nstate: IMPLEMENT\nOpen asks: a1\ncurrent step: x\n' } })
  const r = await compact($, 'auto')
  await clock.settle()
  expect([isRebuild(r, 'idle'), kr(writes)]).toEqual([true, [['rebuild', 'idle']]])
})

test('C34 a stale waiting src: seen at T, 29 more turn.completes → held (idle-wait); 30 → reconcile, never held', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: W019() } })
  box.usage = usageOf(100).value
  for (let i = 0; i <= 29; i++) await turn($, box, clock, 100, 'c' + i)
  box.usage = usageOf(600000).value
  const a = await compact($, 'auto')
  box.usage = usageOf(100).value
  await turn($, box, clock, 100, 'x')
  box.usage = usageOf(600000).value
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.startsWith(HELD), b.messages?.[0].text, holdLines(writes).map((l) => l.reason)]).toEqual([true, 'RECONCILE: re-read the ledger log; the Now section may be out of date', ['idle-wait']])
})

test('C34o a stale waiting ledger that is not the newest: 018 waits untouched while 019 changes every turn; 29 more turn.completes → held for 018, 30 → rebuild/idle', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: ledger('IMPLEMENT', ' n.'), [P018]: W019() } })
  box.usage = usageOf(100).value
  for (let i = 0; i <= 29; i++) {
    box.files[P019] = ledger('IMPLEMENT', ` n${i}.`)
    await turn($, box, clock, 100, 'c' + i)
  }
  box.usage = usageOf(600000).value
  const a = await compact($, 'auto')
  box.usage = usageOf(100).value
  box.files[P019] = ledger('IMPLEMENT', ' n30.')
  await turn($, box, clock, 100, 'x')
  box.usage = usageOf(600000).value
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.includes('while LWO-018 waits'), isRebuild(b, 'idle'), holdLines(writes).map((l) => [l.reason, l.waitSource])]).toEqual([true, true, [['idle-wait', P018]]])
})

test('C35 held, then answered: an idle auto is held; the Now rewritten "Open asks: none." and one turn; the next idle auto → rebuild/idle', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: W019() } })
  const a = await compact($, 'auto')
  box.files[P019] = W019(' Open asks: none.')
  await turn($, box, clock, 100, 't1')
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.startsWith(HELD), isRebuild(b, 'idle'), kr(writes).filter(([k]) => k !== 'pass')]).toEqual([true, true, [['hold', 'idle-wait'], ['rebuild', 'idle']]])
})

test('C35r two idle autos in one gap while waiting: two skips, one hold line, then one holds line with count 2 at turn.complete', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: W019() } })
  const a = await compact($, 'auto')
  const b = await compact($, 'auto')
  await turn($, box, clock, 100, 't1')
  expect([a.skip?.startsWith(HELD), b.skip?.startsWith(HELD), box.coreIn.length, ours(writes).filter((l) => l.kind === 'hold' || l.kind === 'holds').map((l) => [l.kind, l.reason ?? null, l.count ?? null])]).toEqual([
    true,
    true,
    0,
    [['hold', 'idle-wait', null], ['holds', null, 2]],
  ])
})

test('C36 D1: 018 waits and 019 does not → held for 018 with the full line; both wait → for 019 (the newest); neither → rebuild/idle', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: ledger('IMPLEMENT'), [P018]: W019() } })
  const a = await compact($, 'auto')
  await turn($, box, clock, 100, 't1')
  box.files[P019] = W019(' Open asks: b2.')
  const b = await compact($, 'auto')
  await turn($, box, clock, 100, 't2')
  box.files[P019] = ledger('IMPLEMENT')
  box.files[P018] = ledger('IMPLEMENT')
  const c = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.includes('while LWO-018 waits'), b.skip?.includes('while LWO-019 waits'), isRebuild(c, 'idle'), noHookError(writes), holdLines(writes).map(pick)]).toEqual([
    true,
    true,
    true,
    true,
    [
      { reason: 'idle-wait', source: P019, state: 'IMPLEMENT', others: [P018], wait: 'open-asks', waitSource: P018 },
      { reason: 'idle-wait', source: P019, state: 'IMPLEMENT', others: [P018], wait: 'open-asks', waitSource: P019 },
    ],
  ])
})

test('C37 in a turn with a wait open at 600,000: hold/below-guard (the in-turn rule), not idle-wait', async ($, on) => {
  const { clock, box, writes } = setup(on, { files: { [P019]: W019() } })
  box.usage = usageOf(600000).value
  await start($)
  const r = await compact($, 'auto')
  await clock.settle()
  expect([r.skip?.includes('is open (State: IMPLEMENT)'), box.coreIn.length, kr(writes)]).toEqual([true, 0, [['hold', 'below-guard']]])
})

test('[hold] C38h in the hold run: a waiting idle at 359,000 → held for the operator wait; no wait → held as open (idle)', async ($, on) => {
  const { clock, box } = setup(on, { files: { [P019]: W019() } })
  const a = await compact($, 'auto')
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('IMPLEMENT')
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.includes('waits on the operator (open-asks)'), b.skip?.includes('is open (State: IMPLEMENT)')]).toEqual([true, true])
})

test('[above-soft] C38s in the above-soft run: a waiting idle at 300,000 → held for the operator wait; no wait at 299,999 → held as open (idle)', async ($, on) => {
  const { clock, box } = setup(on, { files: { [P019]: W019() } })
  box.usage = usageOf(300000).value
  const a = await compact($, 'auto')
  await turn($, box, clock, 100, 't1')
  box.files[P019] = ledger('IMPLEMENT')
  box.usage = usageOf(299999).value
  const b = await compact($, 'auto')
  await clock.settle()
  expect([a.skip?.includes('waits on the operator (open-asks)'), b.skip?.includes('is open (State: IMPLEMENT)')]).toEqual([true, true])
})

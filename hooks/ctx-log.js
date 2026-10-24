// ctx-log: one JSON line per turn and per compaction, so context size can be
// measured over time (LWO-007 / fork #37). Lines go to
// $HOME/.omt-scratch/lab-ctx/<session>-<inst>-<YYYYMMDD>[-<part>].jsonl, one
// file per process (inst), UTC day and part. Only omt sessions log: no
// SESSION_NAME, or a HOME that is not absolute, and nothing is written.
//
// Holds a turn at most one 150 ms race: turn.step only records, turn.complete and session.compact
// enqueue and return (usage() races a 150 ms `$.clock` wait), and one worker
// writes every queued line in one `$.fs.write`. Only session.end waits for the
// queue, at most 150 ms. The first write that throws stops the logger.
//
// Registered through hooks/mods.js (one hooks module per plugin), next to
// ctx-mod: each hook here has a matcher that every event of its kind passes.
// It never changes compaction: next(e) gets e as received, r comes back as is.

const RACE_MS = 150
const ROTATE_BYTES = 4128768 // 4 MiB less 64 KiB: a write over 4 MiB rejects
const MAX_PENDING = 64

const inst = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0')

let gate = null // { name, home } once they were read and pass
let off = false // a write threw: no fs call from here on
const steps = new Map() // loop ('' for main) -> context tokens of its last step, or null
let lastWindow = null // the window usage() last gave a main turn
let queue = [] // lines accepted and not yet taken by the worker
let inflight = 0 // lines in the write under way
let dropped = 0
let draining = null // the worker, while it runs
let file = { day: '', part: 1, text: '' } // what the current file holds, as written

/** Context size of one request: what the next request starts from. Output never counts. */
function contextTokens(u) {
  return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
}

function n(x) {
  return Number.isInteger(x) && x >= 0 ? x : 0
}

async function open($) {
  if (off) return null
  if (gate) return gate
  const name = await $.env.get('SESSION_NAME')
  if (!name) return null
  const home = await $.env.get('HOME')
  if (typeof home !== 'string' || !home.startsWith('/')) return null
  gate = { name: String(name), home }
  return gate
}

function bounded($, next, work) {
  return Promise.race([work, $.clock.sleep(RACE_MS, next.signal ? { signal: next.signal } : undefined).then(() => null, () => null)])
}

async function windowOf($) {
  try {
    const u = await $.session.usage()
    const w = u && u.context && u.context.window
    if (!Number.isInteger(w)) return null
    lastWindow = w
    return w
  } catch {
    return null
  }
}

/** JSON with every non-ASCII character escaped, so its length is its UTF-8 size. */
function ascii(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function utcDay(at) {
  return new Date(at).toISOString().slice(0, 10).replace(/-/g, '')
}

function pathOf(g, day, part) {
  const safe = g.name.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${g.home}/.omt-scratch/lab-ctx/${safe}-${inst}-${day}${part > 1 ? '-' + part : ''}.jsonl`
}

function enqueue($, g, line) {
  if (off) return // a write already failed: logging has stopped
  if (queue.length + inflight >= MAX_PENDING) {
    dropped++
    return
  }
  if (dropped) {
    line.dropped = dropped
    dropped = 0
  }
  queue.push({ day: utcDay(line.at), text: ascii(line) + '\n' })
  if (!draining) draining = drain($, g)
}

/** Takes every queued line each round and writes each file it touches once. */
async function drain($, g) {
  while (queue.length > 0 && !off) {
    const batch = queue
    queue = []
    inflight = batch.length
    const writes = []
    let w = { ...file, dirty: false }
    for (const { day, text } of batch) {
      const d = day > w.day ? day : w.day
      if (d !== w.day) {
        if (w.dirty) writes.push(w)
        w = { day: d, part: 1, text: '', dirty: false }
      }
      if (w.text.length > 0 && w.text.length + text.length > ROTATE_BYTES) {
        if (w.dirty) writes.push(w)
        w = { day: w.day, part: w.part + 1, text: '', dirty: false }
      }
      w = { ...w, text: w.text + text, dirty: true }
    }
    if (w.dirty) writes.push(w)
    for (const { day, part, text } of writes) {
      try {
        await $.fs.write(pathOf(g, day, part), text)
      } catch (err) {
        off = true
        queue = []
        $.ui.log('ctx-log: ' + String(err) + '; context logging stops for this session')
        break
      }
      file = { day, part, text }
    }
    inflight = 0
  }
  draining = null
}

/** True once a write threw: the logger (and ledger-compact, which logs through it) is off. */
export function isOff() {
  return off
}

/**
 * Queues one line for another module of this plugin (ledger-compact, #66) through this writer:
 * the same file, queue, MAX_PENDING and `dropped` as ctx-log's own lines. It sets v, at, session,
 * inst and agentId (null); `fields` never carries those. Resolves true once queued, false when
 * logging is off or the session does not log. Never waits for the write.
 */
export async function record($, fields) {
  const g = await open($)
  if (!g || off) return false
  const at = new Date(await $.clock.now()).toISOString()
  const line = { v: 1, at, session: g.name, inst, agentId: null }
  for (const [k, val] of Object.entries(fields)) if (!(k in line)) line[k] = val
  enqueue($, g, line)
  return !off
}

export function register(on) {
  // Each hook has a matcher every event of its kind passes: one plugin may hook
  // an event once without a matcher, and ctx-mod's hooks have none.
  on('turn.step', { turnId: /^/ }, async function* ($, e, next) {
    const result = yield* next(e)
    steps.set(e.agentId ?? '', result && result.usage ? contextTokens(result.usage) : null)
    return result
  })
  on('turn.complete', { turnId: /^/ }, async ($, e, next) => {
    const loop = e.agentId ?? ''
    const tokens = steps.has(loop) ? steps.get(loop) : null
    steps.delete(loop)
    const g = await open($)
    if (g) {
      const at = new Date(await $.clock.now()).toISOString()
      // usage() reports the main loop: a subagent's line has no window.
      const window = e.agentId ? null : await bounded($, next, windowOf($))
      enqueue($, g, { v: 1, at, session: g.name, inst, agentId: e.agentId ?? null, kind: 'turn', tokens, window })
    }
    return next(e)
  })
  // precompute installs nothing (it is kept for the next compaction), so it is not matched.
  on('session.compact', { trigger: ['manual', 'auto', 'plugin'] }, async ($, e, next) => {
    const r = await next(e)
    // A second guard, unreachable while the matcher above holds (the host dispatches precompute to no matched hook).
    if (r && !r.skip && e.trigger !== 'precompute') {
      const g = await open($)
      if (g) {
        const at = new Date(await $.clock.now()).toISOString()
        enqueue($, g, {
          v: 1,
          at,
          session: g.name,
          inst,
          agentId: e.agentId ?? null,
          kind: 'compact',
          trigger: e.trigger,
          before: r.tokensBefore ?? null,
          after: r.tokensAfter ?? null,
          tokens: null,
          window: e.agentId ? null : lastWindow,
        })
      }
    }
    return r
  })
  on('session.end', { sessionId: /^/ }, async ($, e, next) => {
    if (draining) await bounded($, next, draining)
    return next(e)
  })
}

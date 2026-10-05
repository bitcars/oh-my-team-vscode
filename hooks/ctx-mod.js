// ctx-mod: reports this session's model, context size, rate-limit quota and
// subagent counts to the omt router (POST $ROUTER_URL/ctx, fork #16 / WO-022).
// The wire contract is §1 of the WO-022 plan; the router computes `pct`.
//
// Never slows a turn: every report races a 150 ms `$.clock` wait (a `$` call
// stops the hook's budget clock, a `$.clock` wait doesn't), the POST itself is
// never awaited, and at most MAX_INFLIGHT posts are open at once. A report that
// loses the race goes on in the background; if a newer report has gone out by
// the time it finishes, it is dropped here, as the router would drop it.

const RACE_MS = 150
const MAX_INFLIGHT = 4
const RUNNING = new Set(['pending', 'running', 'waiting'])

let last = null // dedupe key: the last body sent, without `at`
let lastAt = 0 // `at` of that body: an older report finishing late must not replace it
let model = null // result.usage.model of the last main-loop request
let inflight = 0
let warned = false

/** Context size of one request: what the next request starts from. Output never counts. */
export function contextTokens(u) {
  return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
}

function n(x) {
  return Number.isInteger(x) && x >= 0 ? x : 0
}

/** http on localhost or 127.0.0.1, an explicit port, and nothing after it. */
export function isLocalUrl(s) {
  let u
  try {
    u = new URL(s)
  } catch {
    return false
  }
  return (
    u.protocol === 'http:' &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
    u.port !== '' &&
    u.pathname === '/' &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash
  )
}

function quotaOf(limits) {
  if (!Array.isArray(limits)) return null
  const q = { fiveHour: null, sevenDay: null }
  for (const l of limits) {
    const k = l && l.kind === 'five_hour' ? 'fiveHour' : l && l.kind === 'seven_day' ? 'sevenDay' : null
    if (k && typeof l.percentUsed === 'number') {
      q[k] = { pct: l.percentUsed, resetsAt: typeof l.resetsAt === 'string' ? l.resetsAt : null }
    }
  }
  return q
}

async function agentsOf($) {
  try {
    const list = await $.agent.list()
    const running = list.filter((a) => RUNNING.has(a.status)).length
    return { running, alive: running + list.filter((a) => a.status === 'idle').length }
  } catch {
    return null
  }
}

/**
 * tokens: a number or null to send as-is; undefined to read Claude Code's own
 * context figure. measured: a session.measure input, used instead of usage().
 * force: send even when nothing changed.
 */
async function report($, tokens, measured, force) {
  const at = Date.now()
  try {
    if (await $.env.get('CLAUDE_CODE_TEAMMATE')) return
    const session = await $.env.get('SESSION_NAME')
    const router = await $.env.get('ROUTER_URL')
    if (!session || !isLocalUrl(router)) return
    const u = measured ?? (await $.session.usage())
    const c = (u && u.context) || {}
    const key = JSON.stringify({
      session,
      sid: await $.session.id(),
      model,
      ctx: { tokens: tokens === undefined ? (Number.isInteger(c.tokens) ? c.tokens : null) : tokens, window: c.window },
      quota: quotaOf(u && u.rateLimits),
      agents: await agentsOf($),
    })
    if (at < lastAt) return // a newer report already went out
    if (!force && key === last) return
    if (inflight >= MAX_INFLIGHT) return // key not advanced: the next event re-sends
    last = key
    lastAt = at
    inflight++
    let posted
    try {
      posted = $.http.fetch(new URL('/ctx', router).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(key), at }),
      })
    } catch (err) {
      inflight-- // a fetch that throws instead of rejecting must not keep its slot
      throw err
    }
    posted
      .then((res) => {
        // A refused report is never silent. 404 is expected (the startup report races the
        // session's registration) and must not use up the one warning.
        if (res && !res.ok && res.status !== 404) warnOnce('router answered ' + res.status)
      })
      .catch(() => {})
      .finally(() => {
        inflight--
      })
  } catch (err) {
    warnOnce(String(err))
  }

  function warnOnce(text) {
    if (!warned) {
      warned = true
      $.ui.log('ctx-mod: ' + text)
    }
  }
}

function bounded($, next, work) {
  return Promise.race([work, $.clock.sleep(RACE_MS, next.signal ? { signal: next.signal } : undefined).catch(() => {})])
}

export function register(on) {
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result && result.usage) {
      if (typeof result.usage.model === 'string') model = result.usage.model
      await bounded($, next, report($, contextTokens(result.usage)))
    } else {
      // A subagent's step (the lead's context is unchanged, its agents may not be),
      // or a main step with no usage (a failed request): report what Claude Code has.
      await bounded($, next, report($))
    }
    return result
  })
  on('session.measure', async ($, e, next) => {
    await bounded($, next, report($, undefined, e))
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    await bounded($, next, report($))
    return next(e)
  })
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (r && !r.skip && !e.agentId && e.trigger !== 'precompute') await bounded($, next, report($, null))
    return r
  })
  on('session.end', async ($, e, next) => {
    // On /clear, usage() still reports the conversation that just ended.
    if (e.reason === 'clear') await bounded($, next, report($, 0, undefined, true))
    else if (e.reason === 'resume') await bounded($, next, report($, null))
    return next(e)
  })
}

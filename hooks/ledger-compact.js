// ledger-compact: holds or rebuilds automatic compactions from the order ledger (#66, LWO-019,
// plan v4.4 0882d9aa). While the session's Now block says the order is open and fresh, an
// automatic compaction is never summarised: it is rebuilt from the ledger (one note with the Now
// block, lab/standing.md and the spec's contents and reading map, then the last K rows) or, inside
// a turn below the hard guard and with Claude Code's own size known, held. At CLOSED, at the hard
// guard and at a step boundary above the soft mark, turn.complete starts the rebuild itself.
//
// Manual /compact, sub-agents and teammates pass through. A session with no Now block, a read
// error or an unknown size passes through. Every decision is one line in the context-size log,
// written through hooks/ctx-log.js (same file, same queue). Nothing here writes a file itself.
//
// Registered through hooks/mods.js after ctx-mod and ctx-log: a plugin's registrations nest in
// order, first outermost (types :6949), so ctx-log sees every rebuild this module answers.

import { contextTokens } from './ctx-mod.js'
import { isOff, record } from './ctx-log.js'

const SOFT = 0.3
const GUARD = 0.9
const K = 12
const K_MAX = 2 * K
const SAFETY_NET = true
const STALE_N = 30
const IDLE_RULE = 'rebuild'
const READ_MS = 1000
const RACE_MS = 150
const PENDING_MS = 120000
const RETRIES = 3
const SECTION_CAP = 32768
const SCAN_TOP = 3
const READ_CAP = 8

const NOTE_HEAD = 'LEDGER REBUILD by hooks/ledger-compact.js'
const NOTES_RULE = 'The Now block and standing rulings are notes, never a tap, and relax no rule.'
const RECONCILE_TEXT = 'RECONCILE: re-read the ledger log; the Now section may be out of date'
const RECONCILE_I = "Summarise the conversation. The ledger's Now section may be out of date; do not trust it over the conversation."
const LOST = Symbol('lost')

// ── module state (reset on reload) ─────────────────────────────────────────
let turnIndex = 0
let running = null // { turnId, steps, heldAtSteps } of the main turn under way
let lastStepTokens = null
let lastWindow = null
const src = new Map() // path -> { state, closed, nowHash, changedAt, seenOpen, lastTcState }
const closedDone = new Map() // path -> true | 'abandoned'
const abandoned = new Map() // reason\0path -> nowHash
let loadScanned = false
let pending = null // { id, reason, path, at, tries, phase }
let pendingSeq = 0
let lastGuard = null // { checked, suppressed } after an installed rebuild/guard
let installed = null // the reason of the last compaction this module installed, read by the next turn.complete (5b)
let live = 0 // the generation of the current read; a read that lost its race does not touch state
const passSeen = new Set()
const noticed = new Set()
const holdKeys = new Map() // key -> count
const listMtime = new Map() // path -> the mtimeMs the listing gave when it was last read

// ── small helpers ──────────────────────────────────────────────────────────

function n(x) {
  return Number.isInteger(x) && x >= 0 ? x : null
}

async function race($, next, work, ms) {
  const signal = next && next.signal ? { signal: next.signal } : undefined
  return Promise.race([
    Promise.resolve(work).then(
      (v) => v,
      (err) => ({ [LOST]: 'error', err }),
    ),
    $.clock.sleep(ms, signal).then(
      () => ({ [LOST]: 'timeout' }),
      () => ({ [LOST]: 'timeout' }),
    ),
  ])
}

const lost = (v) => v !== null && typeof v === 'object' && LOST in v

function log($, fields) {
  record($, fields).catch(() => {})
}

/** A pass line once per (reason, source) per load; manual and plugin every time. */
function pass($, reason, extra = {}) {
  const key = reason + '\0' + (extra.source ?? '') + '\0' + (extra.capped ?? '') // read-set: once per capped value (v4.4 B5)
  if (reason !== 'manual' && reason !== 'plugin') {
    if (passSeen.has(key)) return
    passSeen.add(key)
  }
  log($, { kind: 'pass', reason, ...extra })
}

function notice($, key, text) {
  if (noticed.has(key)) return
  noticed.add(key)
  try {
    $.ui.log(text)
  } catch {
    // a notice that cannot be drawn changes nothing
  }
}

function utf8(s) {
  const out = []
  for (const ch of s) {
    let c = ch.codePointAt(0)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

function byteLen(ch) {
  const c = ch.codePointAt(0)
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
}

/** The text cut to at most `cap` UTF-8 bytes, never inside a character, with a marker when cut. */
function capBytes(text, cap) {
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const b = byteLen(ch)
    if (bytes + b > cap) return out + `\n[cut at ${cap} bytes]`
    bytes += b
    out += ch
  }
  return out
}

function sha1(text) {
  const bytes = utf8(text)
  const ml = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (ml >>> (i * 8)) & 255)
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
  const w = new Array(80)
  const rol = (x, k) => (x << k) | (x >>> (32 - k))
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3]
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4]
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6]
      const t = (rol(a, 5) + f + e + k + w[i]) | 0
      e = d
      d = c
      c = rol(b, 30)
      b = a
      a = t
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('')
}

// ── the Now block and its State (§3.6, R21) ────────────────────────────────

/** The ledger's Now block: after the first "## Now" line, up to the next "## " line; null without one. */
export function ledgerNow(text) {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.trimEnd() === '## Now')
  if (i < 0) return null
  const out = []
  for (let j = i + 1; j < lines.length && !lines[j].startsWith('## '); j++) out.push(lines[j])
  return out.join('\n')
}

function stripQuotes(line) {
  return line.replace(/"[^"]*"/g, '').replace(/“[^”]*”/g, '')
}

/** State of a Now block: { value } (open or closed), or null for no-state. R21: the first line holding a key wins; on it, the last key. */
export function stateOf(nowText, ledger) {
  const keyRe = ledger ? /(?:^|\.\s+)\s*(?:-\s+)?(?:\*\*)?state(?:\*\*)?:(?:\*\*)?/gi : /^\s*(?:-\s+)?(?:\*\*)?state(?:\*\*)?:(?:\*\*)?/gi
  for (const raw of nowText.split('\n')) {
    const line = stripQuotes(raw)
    let lastEnd = -1
    for (const m of line.matchAll(keyRe)) lastEnd = m.index + m[0].length
    if (lastEnd < 0) continue
    const rest = line.slice(lastEnd)
    const stop = rest.search(/\.\s/)
    let v = (stop >= 0 ? rest.slice(0, stop) : rest).replace(/\*/g, '').trim()
    if (v.endsWith('.')) v = v.slice(0, -1)
    if (v === '') return null
    return { value: v, closed: /^closed(?=$|[\s(.,;:—-])/i.test(v) }
  }
  return null
}

// ── reading the sources (§3.6) ─────────────────────────────────────────────

async function vaultRoot($, home) {
  const v = await $.env.get('OMT_VAULT_ROOT')
  return typeof v === 'string' && v.startsWith('/') ? v.replace(/\/+$/, '') : `${home}/Library/Mobile Documents/iCloud~md~obsidian/Documents/Bin4.me/omt`
}

function note(path, nowText, ledger) {
  const st = stateOf(nowText, ledger)
  const hash = sha1(nowText)
  let s = src.get(path)
  if (!s) {
    s = { state: null, closed: false, nowHash: hash, changedAt: turnIndex, seenOpen: false, lastTcState: undefined, first: true }
    src.set(path, s)
  } else if (s.nowHash !== hash) {
    s.nowHash = hash
    s.changedAt = turnIndex
  }
  s.state = st ? st.value : null
  s.closed = st ? st.closed : false
  if (st && !st.closed) {
    if (closedDone.has(path)) closedDone.delete(path)
    s.seenOpen = true
  }
  return { path, nowText, state: st, entry: s }
}

/** Reads what a decision needs, in one READ_MS race. */
async function readAll($, next, g) {
  const gen = ++live
  const isLive = () => gen === live
  const work = (async () => {
    const offFile = await $.fs.exists(`${g.home}/.omt-scratch/lab-ctx/ledger-compact.off`)
    const out = { offFile, kind: g.hub ? 'hub' : 'team', src: null, open: [], reason: null, read: [], others: [], capped: 0, dupes: [] }
    if (g.hub) {
      const V = await vaultRoot($, g.home)
      const dir = `${V}/lab/tasks`
      let entries
      try {
        entries = await $.fs.list(dir)
      } catch {
        out.reason = 'read-error'
        return out
      }
      const byNum = new Map()
      const placeholders = new Set()
      for (const e of entries) {
        const ph = /^\.LWO-(\d{3,})-.*\.md\.icloud$/.exec(e.name)
        if (ph) placeholders.add(Number(ph[1]))
        const m = /^LWO-(\d{3,})-[^/]*\.md$/.exec(e.name)
        if (!m || / \d+\.md$/.test(e.name)) continue
        let isFile = e.kind === 'file'
        let mtime = e.mtimeMs
        if (e.isLink) {
          try {
            const st = await $.fs.stat(`${dir}/${e.name}`)
            isFile = st.kind === 'file'
            mtime = st.mtimeMs
          } catch {
            isFile = false
          }
        }
        if (!isFile) continue
        const num = Number(m[1])
        const prev = byNum.get(num)
        if (prev) {
          if (mtime > prev.mtime) {
            out.dupes.push(prev.path)
            byNum.set(num, { path: `${dir}/${e.name}`, mtime })
          } else out.dupes.push(`${dir}/${e.name}`)
        } else byNum.set(num, { path: `${dir}/${e.name}`, mtime })
      }
      const nums = [...byNum.keys()].sort((a, b) => b - a)
      // R26: an evicted placeholder is a read error only for a number in the read set (open, or the SCAN_TOP highest)
      const openNums = new Set(keepPaths().map(numOf2))
      const topNums = new Set([...new Set([...nums, ...placeholders])].sort((a, b) => b - a).slice(0, SCAN_TOP))
      for (const p of placeholders) if (!byNum.has(p) && (openNums.has(p) || topNums.has(p))) out.reason = 'read-error'
      if (out.reason) return out
      if (nums.length === 0) {
        out.reason = 'no-now'
        return out
      }
      let paths
      if (!loadScanned) paths = nums.map((x) => byNum.get(x).path)
      else {
        // open and not-yet-handled closed paths, the SCAN_TOP newest, and any file whose listing mtime moved since its last read
        const moved = [...byNum.values()].filter((v) => listMtime.has(v.path) && listMtime.get(v.path) !== v.mtime).map((v) => v.path)
        const want = new Set([...keepPaths(), ...nums.slice(0, SCAN_TOP).map((x) => byNum.get(x).path), ...moved])
        const listed = new Set([...byNum.values()].map((v) => v.path))
        paths = [...want].filter((p) => listed.has(p)).sort((a, b) => numOf2(b) - numOf2(a))
        if (paths.length > READ_CAP) {
          out.capped = paths.length - READ_CAP
          paths = paths.slice(0, READ_CAP)
        }
      }
      const mtimeOf = new Map([...byNum.values()].map((v) => [v.path, v.mtime]))
      for (const p of paths) {
        const text = await $.fs.read(p)
        if (!isLive()) return { [LOST]: 'superseded' }
        listMtime.set(p, mtimeOf.get(p))
        const now = ledgerNow(text)
        if (now === null) continue // not a ledger
        const r = note(p, now, true)
        if (!r.state) continue // no State: not a ledger
        out.read.push(r)
      }
      const open = out.read.filter((r) => !r.state.closed).sort((a, b) => numOf2(b.path) - numOf2(a.path))
      out.open = open
      if (open.length > 0) {
        out.src = open[0]
        out.others = open.slice(1).map((r) => r.path)
      } else out.reason = 'closed'
    } else {
      const root = await $.session.root()
      const p = `${root}/.sisyphus/now.md`
      if (!(await $.fs.exists(p))) {
        out.reason = 'no-now'
        return out
      }
      const text = await $.fs.read(p)
      if (!isLive()) return { [LOST]: 'superseded' }
      const r = note(p, text, false)
      out.read.push(r)
      if (!r.state) out.reason = 'no-state'
      else if (r.state.closed) out.reason = 'closed'
      else {
        out.src = r
        out.open = [r]
      }
    }
    return out
  })()
  const r = await race($, next, work, READ_MS)
  // a lost race, or a read superseded by a newer one (v4.4 B1): pass through, retried next time
  if (lost(r)) return { lostRead: true, err: r.err ? String(r.err) : r[LOST] }
  if (g.hub) loadScanned = true
  return r
}

/** The read set's extras for a log line (v4.3 A4): only the ones that are not empty. */
function readExtra(all) {
  const x = {}
  if (all.others && all.others.length > 0) x.others = all.others
  if (all.dupes && all.dupes.length > 0) x.dupes = all.dupes
  if (all.capped) x.capped = all.capped
  return x
}

function numOf2(p) {
  const m = /LWO-(\d{3,})-/.exec(p)
  return m ? Number(m[1]) : -1
}

/** Paths kept in the read set: open ones and closed ones whose close is not handled yet (v4, M3). */
function keepPaths() {
  const out = []
  for (const [p, s] of src) if ((s.state && !s.closed) || (s.closed && s.seenOpen && !closedDone.has(p))) out.push(p)
  return out
}

async function readNoteFiles($, next, g) {
  const work = (async () => {
    const V = await vaultRoot($, g.home)
    const standing = await $.fs.read(`${V}/lab/standing.md`)
    const pd = await $.env.get('OMT_PLUGIN_DIR')
    // the profile sets OMT_PLUGIN_DIR to the checkout; the plugin view (~/.omtv/plugin) has no docs/ (R23)
    const specPath = `${typeof pd === 'string' && pd.startsWith('/') ? pd.replace(/\/+$/, '') : $.plugin.root}/docs/corp-mode-spec.md`
    const specText = await $.fs.read(specPath)
    const lines = specText.split('\n')
    const i = lines.findIndex((l) => l.trimEnd() === '## Contents and reading map')
    if (i < 0) return { missing: 'spec' }
    let j = i + 1
    while (j < lines.length && !lines[j].startsWith('## ')) j++
    return { standing, spec: lines.slice(i, j).join('\n'), standingPath: `${V}/lab/standing.md`, specPath }
  })()
  const r = await race($, next, work, READ_MS)
  if (lost(r) || r.missing) return null
  return r
}

// ── the session gate (§3.2) ────────────────────────────────────────────────

async function gate($) {
  // switches first (silent, R6), then the failures that give one notice per load
  if ((await $.env.get('OMT_LEDGER_COMPACT')) === 'off') return { off: 'switch' }
  if (await $.env.get('CLAUDE_CODE_TEAMMATE')) return { off: 'switch' }
  const name = await $.env.get('SESSION_NAME')
  const home = await $.env.get('HOME')
  if (!name || typeof home !== 'string' || !home.startsWith('/')) return { off: 'nosession' }
  if (isOff()) return { off: 'ctxlog' }
  return { name: String(name), home, hub: String(name) === 'hub' }
}

function offNotice($, g) {
  if (g.off === 'ctxlog') notice($, 'off-ctxlog', 'ledger-compact: off for this session (context logging stopped); compactions are not held or rebuilt')
  if (g.off === 'nosession') notice($, 'off-nosession', 'ledger-compact: off for this session (no SESSION_NAME or no absolute HOME)')
}

// ── size (§3.4) ────────────────────────────────────────────────────────────

async function measure($, next) {
  const u = await race($, next, $.session.usage(), RACE_MS)
  let engine = null
  let window = lastWindow
  if (!lost(u) && u && u.context) {
    engine = n(u.context.tokens)
    if (Number.isInteger(u.context.window) && u.context.window > 0) {
      window = u.context.window
      lastWindow = window
    }
  }
  const tokens = lastStepTokens === null && engine === null ? null : Math.max(lastStepTokens ?? 0, engine ?? 0)
  return { tokens, engine, window, known: tokens !== null && window !== null }
}

const pct = (t, w) => (Math.floor((1000 * t) / w) / 10).toFixed(1)

// ── building the conversation (§3.8) ───────────────────────────────────────

function label(source, g) {
  if (!g.hub) return '.sisyphus/now.md'
  const m = /LWO-(\d{3,})-/.exec(source.path)
  return `LWO-${m ? m[1] : '?'} (hub ledger)`
}

function body(text) {
  return capBytes(text.replace(/\n+$/, ''), SECTION_CAP) + '\n'
}

function buildNote(reason, k, summary, sources, files, g) {
  return (
    `${NOTE_HEAD} (${reason}): this conversation was rebuilt from the files below instead of a summary. Resume from the Now block (spec §4.3), then re-read §0a and the current step's sections. ${k} rows of the conversation follow unchanged${summary ? ', after the safety-net summary' : ''}. ${NOTES_RULE}\n` +
    capBytes(sources.map((s) => `== Now: ${label(s, g)} ==\n` + body(s.nowText)).join(''), SECTION_CAP).replace(/\n?$/, '\n') +
    '== Standing rulings ==\n' +
    body(files.standing) +
    '== Spec contents and reading map ==\n' +
    body(files.spec)
  )
}

/** The last K rows, widened to keep every tool group whole (R9), never past K_MAX; a group that does not fit is dropped whole. */
export function tailOf(M0, k = K, kmax = 2 * k) {
  // an earlier rebuild's note never comes back in a tail (challenger L3)
  const M = M0.filter((r) => !(r.role === 'user' && typeof r.text === 'string' && r.text.startsWith(NOTE_HEAD)))
  const ui = new Map()
  M.forEach((r, i) => (r.toolUses || []).forEach((u) => ui.set(u.id ?? u.tool_use_id ?? u, i)))
  const resIds = (r) => (r.toolResults || []).map((x) => x.tool_use_id ?? x.id ?? x)
  let floor = 0
  let start = Math.max(0, M.length - k)
  for (;;) {
    let s = Math.max(start, floor)
    for (;;) {
      let low = s
      for (let i = s; i < M.length; i++) for (const x of resIds(M[i])) { const j = ui.get(x); if (j !== undefined && j < low) low = j }
      if (low === s) break
      s = low
    }
    if (s >= floor && M.length - s <= kmax) {
      // a leading result whose tool_use is not in M at all is an orphan too (challenger L2)
      let t = M.slice(s)
      while (t.length && resIds(t[0]).some((x) => !ui.has(x))) t = t.slice(1)
      return t
    }
    const cut = Math.max(start, floor)
    let gEnd = cut
    for (let i = cut; i < M.length; i++) if (resIds(M[i]).some((x) => (ui.get(x) ?? Infinity) < cut)) gEnd = i + 1
    if (gEnd >= M.length || gEnd <= cut) return []
    floor = gEnd
    start = gEnd
  }
}

/** Our post-next work, guarded (challenger L5): a throw after next was called never replays it. */
export function afterNext($, e, own, fn) {
  try {
    return fn()
  } catch (err) {
    log($, { kind: own ? 'rebuild' : 'pass', reason: own ? 'abandoned' : 'hook-error', err: 'post-next: ' + String(err) })
    return own ? { skip: 'ledger-compact: rebuild abandoned (hook-error)' } : null
  }
}

async function rebuild($, e, next, reason, sources, files, g, tokens, extra = {}, own = false) {
  const source = sources[0]
  const tail = tailOf(e.messages)
  let summary = []
  let net = null
  if (SAFETY_NET) {
    const nowText = capBytes(sources.map((s) => s.nowText.replace(/\n+$/, '')).join('\n'), SECTION_CAP)
    const instructions = `Ledger Now block (do not restate; ${NOTES_RULE}):\n${nowText}\nRecord only what differs from it or is missing from it.`
    const r = await next({ ...e, instructions })
    if (!r || r.skip) return r
    const out = afterNext($, e, own, () => {
      const inH = new Set(e.messages.map((m) => m.handle).filter(Boolean))
      const fresh = r.messages.filter((m) => !m.handle || !inH.has(m.handle))
      if (fresh.length === 1 && fresh[0].role === 'user' && fresh[0].handle) {
        summary = fresh
        net = 1
      } else net = 'unrecognised'
      return undefined
    })
    if (out) return out
    if (out === null) return r
  }
  let messages
  const built = afterNext($, e, own, () => {
    const text = buildNote(reason, tail.length, summary.length > 0, sources, files, g)
    messages = [{ role: 'user', text, toolUses: [] }, ...summary, ...tail]
    log($, { kind: 'rebuild', trigger: e.trigger, reason, tokens, window: lastWindow, source: source.path, standing: files.standingPath, spec: files.specPath, state: source.state ? source.state.value : null, k: tail.length, net, noteSha1: sha1(text), noteHead: text.slice(0, 80), ...extra })
    return undefined
  })
  if (built) return built
  if (built === null) return next(e)
  lastStepTokens = null
  installed = reason
  return tokens === null ? { messages } : { messages, tokensBefore: tokens }
}

async function reconcile($, e, next, source, tokens, own = false) {
  const r = await next({ ...e, instructions: RECONCILE_I })
  if (!r || r.skip) return r
  const out = afterNext($, e, own, () => ({ ...r, messages: [{ role: 'user', text: RECONCILE_TEXT, toolUses: [] }, ...r.messages] }))
  if (out === null) return r
  if (out.skip) return out
  log($, { kind: 'reconcile', trigger: e.trigger, reason: 'stale', tokens, source: source.path, state: source.state ? source.state.value : null })
  lastStepTokens = null
  installed = 'stale'
  return out
}

function isStale(entry) {
  return turnIndex - entry.changedAt >= STALE_N
}

function holdLine($, e, size, source, extra = {}) {
  const key = running ? running.turnId : 'idle:' + turnIndex
  const c = (holdKeys.get(key) ?? 0) + 1
  holdKeys.set(key, c)
  if (c === 1) log($, { kind: 'hold', trigger: e.trigger, reason: running ? 'below-guard' : 'idle', tokens: size.tokens, window: size.window, source: source.path, state: source.state.value, ...extra })
}

function holdSkip(size, source, g) {
  const who = g.hub ? `LWO-${(/LWO-(\d{3,})-/.exec(source.path) || [])[1]}` : 'now.md'
  return { skip: `ledger-compact: held at ${pct(size.tokens, size.window)}% (${size.tokens}) < guard 90% while ${who} is open (State: ${source.state.value}); /compact still runs` }
}

// ── the hooks ──────────────────────────────────────────────────────────────

/**
 * Whose plugin compaction this is (R22): the origin names this plugin → 'ours'; another plugin →
 * 'foreign'; no plugin → 'ours' only while our own call is out (pending in flight), else
 * 'foreign'. Live the engine names the plugin (spike Q4A); the mod test kit raises plugin
 * compactions with the engine's origin. Exported for the kit's pure-function rows.
 */
export function ownerOf(origin, pluginName, pendingNow) {
  // the engine's own calls name "engine" in tier "core" (types Origin): no plugin
  const named = origin && typeof origin.plugin === 'string' && !(origin.plugin === 'engine' && origin.tier === 'core') ? origin.plugin : null
  if (named !== null) return named === pluginName ? 'ours' : 'foreign'
  return pendingNow && pendingNow.phase === 'inFlight' ? 'ours' : 'foreign'
}

/** The session.compact decision (§3.5), first matching row wins. */
async function decide($, e, next) {
  // The engine always hands the transcript; a call raised without one (the mod test kit's) reads it.
  if (!Array.isArray(e.messages)) {
    const m = await $.session.messages()
    e = { ...e, messages: Array.isArray(m) ? m : [] }
  }
  const ours = e.trigger === 'plugin' && ownerOf(next.origin, $.plugin.name, pending) === 'ours'
  const g = await gate($)
  if (g.off) {
    offNotice($, g)
    if (ours) return { skip: 'ledger-compact: off' }
    return next(e)
  }
  if (e.agentId) return next(e)
  if (e.trigger === 'manual') {
    const off = await race($, next, $.fs.exists(`${g.home}/.omt-scratch/lab-ctx/ledger-compact.off`), READ_MS)
    if (off !== true) pass($, 'manual', { trigger: 'manual' }) // off (R6): no line
    const r = await next(e)
    if (r && !r.skip) {
      lastStepTokens = null
      if (pending && pending.phase !== 'inFlight') pending = null // a manual compaction supersedes a retry (challenger M2)
    }
    return r
  }
  const all = await readAll($, next, g)
  if (all.offFile) return ours ? { skip: 'ledger-compact: off' } : next(e)

  if (e.trigger === 'plugin') {
    const young = pending && (await $.clock.now()) - pending.at < PENDING_MS
    if (ours && pending && young && pending.phase === 'inFlight') {
      if (all.lostRead) {
        log($, { kind: 'rebuild', trigger: 'plugin', reason: 'abandoned', err: all.err })
        return { skip: 'ledger-compact: rebuild abandoned (read-error)' }
      }
      const p = pending
      const sources = all.open.length > 0 ? all.open : p.reason === 'closed' ? all.read.filter((r) => r.path === p.path) : []
      const files = sources.length > 0 ? await readNoteFiles($, next, g) : null
      if (sources.length === 0 || !files) {
        log($, { kind: 'rebuild', trigger: 'plugin', reason: 'abandoned', source: p.path })
        return { skip: 'ledger-compact: rebuild abandoned (read-error)' }
      }
      const size = await measure($, next)
      if (p.reason === 'stale') return reconcile($, e, next, sources[0], size.tokens, true)
      return rebuild($, e, next, p.reason, sources, files, g, size.tokens, readExtra(all), true)
    }
    if (ours && pending && young && pending.phase === 'rejected') {
      pass($, 'plugin', { trigger: 'plugin', superseded: true })
      return { skip: 'ledger-compact: own call superseded' }
    }
    if (ours) {
      pass($, 'plugin', { trigger: 'plugin', aged: true })
      return { skip: 'ledger-compact: own call aged' }
    }
    pass($, 'plugin', { trigger: 'plugin' })
    return next(e)
  }

  // auto or precompute
  if (all.lostRead) {
    pass($, 'read-error', { trigger: e.trigger, err: all.err })
    notice($, 'no-now', 'ledger-compact: no Now block found (read-error); compactions pass through to the normal summary')
    return next(e)
  }
  if (e.trigger === 'auto') {
    const closing = all.read.find((r) => r.state && r.state.closed && r.entry.seenOpen && !closedDone.has(r.path))
    if (closing) {
      const files = await readNoteFiles($, next, g)
      if (files) {
        const size = await measure($, next)
        const r = await rebuild($, e, next, 'closed', all.open.length > 0 ? all.open : [closing], files, g, size.tokens, readExtra(all))
        if (r && !r.skip) closedDone.set(closing.path, true)
        return r
      }
    }
  }
  if (!all.src) {
    const reason = all.reason ?? 'no-now'
    pass($, reason, { trigger: e.trigger, ...readExtra(all) })
    if (reason === 'no-now' || reason === 'read-error') notice($, 'no-now', `ledger-compact: no Now block found (${reason}); compactions pass through to the normal summary`)
    return next(e)
  }
  const source = all.src
  if (e.trigger === 'precompute') return { skip: 'ledger-compact: precompute off during an open order' }
  const size = await measure($, next)
  if (isStale(source.entry)) return reconcile($, e, next, source, size.tokens)
  const files = await readNoteFiles($, next, g)
  const doRebuild = (reason) => {
    if (!files) {
      pass($, 'read-error', { trigger: e.trigger, source: source.path })
      return next(e)
    }
    return rebuild($, e, next, reason, all.open, files, g, size.tokens, readExtra(all))
  }
  if (!running) {
    if (IDLE_RULE === 'rebuild') return doRebuild('idle')
    if (size.engine === null || !size.known) return doRebuild('no-engine-size')
    if (size.tokens >= GUARD * size.window) return doRebuild('guard')
    if (IDLE_RULE === 'rebuild-above-soft' && size.tokens >= SOFT * size.window) return doRebuild('idle')
    holdLine($, e, size, source, readExtra(all))
    return holdSkip(size, source, g)
  }
  if (!size.known || size.engine === null) return doRebuild('no-engine-size')
  if (size.tokens >= GUARD * size.window) return doRebuild('guard')
  if (running.heldAtSteps === running.steps) return doRebuild('repeat')
  running.heldAtSteps = running.steps
  holdLine($, e, size, source, readExtra(all))
  return holdSkip(size, source, g)
}

export function register(on) {
  on('turn.start', { turnId: /./ }, async ($, e, next) => {
    if (!e.agentId) running = { turnId: e.turnId, steps: 0, heldAtSteps: -1 }
    return next(e)
  })

  on('turn.step', { turnId: /./ }, async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId) {
      if (running) running.steps++
      if (result && result.usage) lastStepTokens = contextTokens(result.usage)
    }
    return result
  })

  on('session.compact', { trigger: ['manual', 'auto', 'plugin', 'precompute'] }, async ($, e, next) => {
    const r = await decide($, e, next)
    if (r && !r.skip && !e.agentId) {
      lastStepTokens = null
      if (e.trigger !== 'plugin' && pending && pending.phase !== 'inFlight') pending = null
    }
    return r
  }).catch(($, e, next) => {
    // fail open (v4.2): a throw passes the compaction on unchanged; our own call is refused instead
    // a throw from beneath (next was called) is the engine's or another hook's: replayed, not ours to log
    if (next.called) return next(e)
    const own = e.trigger === 'plugin' && ownerOf(next.origin, $.plugin.name, pending) === 'ours'
    log($, own ? { kind: 'rebuild', reason: 'abandoned', err: 'hook-error' } : { kind: 'pass', reason: 'hook-error', trigger: e.trigger })
    return own ? { skip: 'ledger-compact: rebuild abandoned (hook-error)' } : next(e)
  })

  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    running = null
    turnIndex++
    const g = await gate($)
    if (g.off) {
      offNotice($, g)
      return r
    }
    // measure and read together: the worst case is max(RACE_MS, READ_MS), about 1 s (v4.3 A7)
    const [size, all] = await Promise.all([measure($, next), readAll($, next, g)])
    for (const [key, c] of holdKeys) {
      if (c > 1) log($, { kind: 'holds', count: c, key })
      holdKeys.delete(key)
    }
    if (all.lostRead || all.offFile) return r
    if (!all.src && all.reason && all.reason !== 'closed') {
      pass($, all.reason, {})
      if (all.reason === 'no-now' || all.reason === 'read-error') notice($, 'no-now', `ledger-compact: no Now block found (${all.reason}); compactions pass through to the normal summary`)
    }
    if (all.capped) pass($, 'read-set', { capped: all.capped })
    // 5b: the size after the last compaction this module installed, once (v4.3 A4)
    if (installed !== null) {
      log($, { kind: 'pass', reason: 'rebuild-size', tokens: size.tokens, window: size.window, for: installed })
      installed = null
    }
    // guard-no-gain (v4, E3-15)
    if (lastGuard && size.known) {
      if (!lastGuard.checked) {
        lastGuard.checked = true
        if (size.tokens >= GUARD * size.window) {
          lastGuard.suppressed = true
          log($, { kind: 'pass', reason: 'guard-no-gain', tokens: size.tokens, window: size.window })
        } else lastGuard = null
      } else if (lastGuard.suppressed && size.tokens < GUARD * size.window) lastGuard = null
    }
    let act = null
    const nowMs = await $.clock.now()
    const young = pending && nowMs - pending.at < PENDING_MS
    if (!(pending && pending.phase === 'inFlight' && young)) {
      if (pending && pending.phase === 'inFlight') pending.phase = 'rejected' // aged: treated as rejected
      // 5a: the cap, before b/c/d, keyed on the rule that fired (R13, v4.3 A2)
      let skipKey = null
      if (pending && pending.phase === 'rejected' && pending.tries >= RETRIES) {
        log($, { kind: 'rebuild', reason: 'abandoned', source: pending.path, tries: pending.tries, for: pending.reason })
        if (pending.rule === 'closed') closedDone.set(pending.path, 'abandoned')
        else abandoned.set(pending.rule + '\0' + pending.path, src.get(pending.path)?.nowHash)
        skipKey = pending.rule + '\0' + pending.path
        pending = null
      }
      const isAbandoned = (rule, p) => {
        const h = abandoned.get(rule + '\0' + p)
        if (h === undefined) return false
        if (src.get(p)?.nowHash !== h || (rule === 'guard' && size.known && size.tokens < GUARD * size.window)) {
          abandoned.delete(rule + '\0' + p)
          return false
        }
        return true
      }
      const retrying = (rule, p) => pending && pending.phase === 'rejected' && pending.rule === rule && pending.path === p
      const closing = all.read.find((x) => x.state && x.state.closed && x.entry.seenOpen && !closedDone.has(x.path))
      const s0 = all.src
      if (closing && skipKey !== 'closed\0' + closing.path) act = { rule: 'closed', reason: 'closed', path: closing.path }
      else if (s0 && size.known && size.tokens >= GUARD * size.window && !(lastGuard && lastGuard.suppressed) && !isAbandoned('guard', s0.path) && skipKey !== 'guard\0' + s0.path) {
        act = { rule: 'guard', reason: isStale(s0.entry) ? 'stale' : 'guard', path: s0.path }
      } else if (
        s0 &&
        size.known &&
        size.tokens >= SOFT * size.window &&
        !isAbandoned('step', s0.path) &&
        skipKey !== 'step\0' + s0.path &&
        ((!s0.entry.first && s0.entry.lastTcState !== undefined && s0.entry.lastTcState !== s0.entry.state) || (retrying('step', s0.path) && pending.state === s0.entry.state))
      ) {
        act = { rule: 'step', reason: isStale(s0.entry) ? 'stale' : 'step', path: s0.path, state: s0.entry.state }
      }
      // a rejected call whose own rule no longer holds this turn is dropped, not retried (challenger M2)
      if (pending && pending.phase === 'rejected' && !(act && act.rule === pending.rule && act.path === pending.path)) {
        log($, { kind: 'pass', reason: 'retry-dropped', for: pending.reason, source: pending.path, tries: pending.tries })
        pending = null
      }
    }
    for (const x of all.read) {
      x.entry.lastTcState = x.entry.state
      x.entry.first = false
    }
    if (act) {
      const tries = pending && pending.rule === act.rule && pending.path === act.path ? pending.tries + 1 : 1
      const id = ++pendingSeq
      const next_ = { id, rule: act.rule, reason: act.reason, path: act.path, state: act.state, at: nowMs, tries, phase: 'inFlight' }
      let call
      try {
        call = $.session.compact()
      } catch (err) {
        // a synchronous throw (v4.4 B2): nothing is in flight
        log($, { kind: 'pass', reason: 'compact-rejected', err: String(err), id })
        pending = null
        return r
      }
      pending = next_
      call.then(
        (res) => {
          if (!pending || pending.id !== id) return log($, { kind: 'pass', reason: 'stale-settle', id })
          if (res && res.skip) {
            if (String(res.skip).startsWith('ledger-compact:')) {
              log($, { kind: 'pass', reason: 'own-skip', for: pending.reason, source: pending.path, skip: String(res.skip) })
              if (pending.rule === 'closed') closedDone.set(pending.path, 'abandoned')
              pending = null
            } else pending.phase = 'rejected'
            return
          }
          if (pending.rule === 'closed') closedDone.set(pending.path, true)
          if (pending.rule === 'guard') lastGuard = { checked: false, suppressed: false }
          pending = null
        },
        (err) => {
          if (pending && pending.id === id) pending.phase = 'rejected'
          log($, { kind: 'pass', reason: 'compact-rejected', err: String(err), id })
        },
      )
    }
    return r
  }).catch(($, e, next) => {
    // fail open (v4.3 A6): the turn keeps the bottom's answer
    log($, { kind: 'pass', reason: 'hook-error', trigger: 'turn.complete' })
    return next(e)
  })
}

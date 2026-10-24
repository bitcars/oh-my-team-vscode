// The plugin's one hooks module (Claude Code 2.1.296 loads one per plugin): it registers
// ctx-mod (router reports), ctx-log (context-size log, #37) and ledger-compact (#66) on the
// same `on`. A plugin's registrations nest in order, first outermost: ctx-log wraps ledger-compact.
import { register as registerCtxMod } from './ctx-mod.js'
import { register as registerCtxLog } from './ctx-log.js'
import { register as registerLedgerCompact } from './ledger-compact.js'

export function register(on) {
  registerCtxMod(on)
  registerCtxLog(on)
  registerLedgerCompact(on)
}

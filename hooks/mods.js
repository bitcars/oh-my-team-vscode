// The plugin's one hooks module (Claude Code 2.1.296 loads one per plugin): it registers
// ctx-mod (router reports) and ctx-log (context-size log, #37) on the same `on`.
import { register as registerCtxMod } from './ctx-mod.js'
import { register as registerCtxLog } from './ctx-log.js'

export function register(on) {
  registerCtxMod(on)
  registerCtxLog(on)
}

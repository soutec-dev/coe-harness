import * as ui from '../ui.js'
import { loadManifest } from '../core/manifest.js'
import { resolveDetected } from '../core/detect.js'
import { readLockfile } from '../core/lockfile.js'
import { computePlan, writeActions, NOOP, LOCAL_EDIT } from '../core/plan.js'
import { resolveVars } from './_shared.js'

export async function status(flags, cwd) {
  const manifest = loadManifest()
  const lock = readLockfile(cwd)
  const detected = resolveDetected(cwd, lock)

  ui.intro('coe-harness status')

  if (!lock) {
    ui.log.warn('Este repo no tiene harness (.claude/harness.json no existe).')
    ui.log.info('Corre `coe-harness init` para instalarlo, o `coe-harness adopt` si ya tienes una estructura hecha a mano.')
  } else {
    ui.log.info(`Harness instalado: v${lock.harnessVersion} · disponible: v${manifest.harnessVersion}`)
  }

  const vars = await resolveVars({ flags: { ...flags, yes: true }, lock, detected, cwd, manifest })
  const plan = computePlan({ manifest, cwd, lock, vars, detected })

  ui.renderPlan(plan, { verbose: Boolean(flags.verbose) })

  const pending = writeActions(plan.actions)
  const drift = plan.actions.filter((a) => a.verdict === LOCAL_EDIT)
  const clean = plan.actions.filter((a) => a.verdict === NOOP)

  if (!pending.length) {
    ui.outro(`Al dia. ${clean.length} archivo(s) intactos, ${drift.length} con ediciones locales.`)
    return drift.length ? 2 : 0
  }

  ui.log.warn(`${pending.length} cambio(s) pendiente(s). Corre: coe-harness upgrade`)
  ui.outro('Hay un upgrade disponible.')
  return 1
}

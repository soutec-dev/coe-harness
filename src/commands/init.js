import * as ui from '../ui.js'
import { loadManifest } from '../core/manifest.js'
import { resolveDetected } from '../core/detect.js'
import { readLockfile } from '../core/lockfile.js'
import { resolveVars, planAndApply, githubProtectionStep } from './_shared.js'

export async function init(flags, cwd) {
  const manifest = loadManifest()
  const lock = readLockfile(cwd)
  const detected = resolveDetected(cwd, lock)

  ui.intro(`coe-harness init — harness v${manifest.harnessVersion}`)

  ui.log.info(
    detected.isEmpty
      ? 'Repo vacio: se emite el harness completo + src/, tests/, scripts/.'
      : `Repo existente (${detected.stackLabel}): se emite solo la superficie Claude. No se toca tu codigo.`
  )

  const vars = await resolveVars({ flags, lock, detected, cwd, manifest })
  const code = await planAndApply({ manifest, cwd, lock, vars, detected, flags, title: 'init' })
  return githubProtectionStep({ code, cwd, flags })
}

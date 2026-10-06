import * as ui from '../ui.js'
import { loadManifest } from '../core/manifest.js'
import { resolveDetected } from '../core/detect.js'
import { readLockfile } from '../core/lockfile.js'
import { migrationsFor, migrations } from '../migrations/index.js'
import { resolveVars, planAndApply, githubProtectionStep } from './_shared.js'

export async function upgrade(flags, cwd) {
  const manifest = loadManifest()
  const lock = readLockfile(cwd)
  const detected = resolveDetected(cwd, lock)

  ui.intro(`coe-harness upgrade — harness v${manifest.harnessVersion}`)

  const from = lock?.harnessVersion ?? '0.0.0'
  if (!lock) {
    ui.log.warn('No hay .claude/harness.json. Se asume una estructura previa hecha a mano (v0).')
  } else {
    ui.log.info(`Harness actual: v${from} -> v${manifest.harnessVersion}`)
  }

  const pending = migrations.filter((m) => migrationsFor(m.dest, from).includes(m))
  if (pending.length) {
    ui.log.step(`Migraciones a aplicar:\n${pending.map((m) => `  · ${m.describe}`).join('\n')}`)
  }

  const vars = await resolveVars({ flags, lock, detected, cwd, manifest })
  const code = await planAndApply({ manifest, cwd, lock, vars, detected, flags, title: 'upgrade' })
  return githubProtectionStep({ code, cwd, flags })
}

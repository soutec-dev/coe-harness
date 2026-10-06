import * as ui from '../ui.js'
import { loadManifest } from '../core/manifest.js'
import { verifyManifest } from '../core/verify.js'

// A diferencia de status/upgrade/adopt, verify no mira ningun proyecto
// consumidor: audita que el propio harness (manifest + templates/base/) sea
// internamente consistente, asi que `cwd` no se usa. Se mantiene en la firma
// solo por uniformidad con el resto de COMMANDS en cli.js.
export async function verify(flags, _cwd) {
  const manifest = loadManifest()
  ui.intro('coe-harness verify')

  const { errors, warnings } = verifyManifest(manifest)

  for (const w of warnings) ui.log.warn(w.message)
  for (const e of errors) ui.log.error(e.message)

  if (!errors.length && !warnings.length) {
    ui.outro('Manifest consistente: sin huerfanos, sin rutas rotas, sin duplicados, sin criticos faltantes.')
    return 0
  }
  if (errors.length) {
    ui.outro(`${errors.length} error(es), ${warnings.length} warning(s).`)
    return 1
  }
  ui.outro(`${warnings.length} warning(s), sin errores.`)
  return flags.strict ? 1 : 0
}

import { execFileSync } from 'node:child_process'
import * as ui from '../ui.js'
import { computePlan, writeActions, OBSOLETE, NOOP, LOCAL_EDIT } from '../core/plan.js'
import { apply } from '../core/apply.js'
import { protegeBranchMain } from '../core/github-protect.js'

// execFile con args en array: nunca pasa por el shell, asi que las rutas con
// espacios (OneDrive, "Mis documentos") dejan de ser un problema.
export function gitUserName(cwd) {
  try {
    return execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

const TYPES = ['backend', 'frontend', 'data', 'ml', 'automation', 'infra', 'integration']

export async function resolveVars({ flags, lock, detected, cwd, manifest }) {
  const prev = lock?.vars ?? {}
  const yes = Boolean(flags.yes) || ui.isCI()

  const projectName =
    flags.name ?? prev.PROJECT_NAME ?? (await ui.text({
      message: 'Nombre del proyecto',
      initialValue: detected.projectName,
      yes,
    }))

  const projectType =
    flags.type ?? prev.PROJECT_TYPE ?? (await ui.select({
      message: 'Tipo de proyecto',
      options: TYPES.map((t) => ({ value: t, label: t })),
      initialValue: 'backend',
      yes,
    }))

  const stack = flags.stack ?? prev.STACK ?? detected.stackLabel

  const langFlag = flags.lang ?? (prev.LANGUAGE ? (/ingl/i.test(prev.LANGUAGE) ? 'en' : 'es') : null)
  const lang =
    langFlag ?? (await ui.select({
      message: 'Idioma en el que Claude responde',
      options: [
        { value: 'es', label: 'español' },
        { value: 'en', label: 'inglés' },
      ],
      initialValue: 'es',
      yes,
    }))

  return {
    PROJECT_NAME: projectName,
    PROJECT_TYPE: projectType,
    STACK: stack,
    LANGUAGE: lang === 'en' ? 'inglés' : 'español',
    // Sticky: se siembra una vez. Si se recalculara en cada corrida, un cambio de
    // identidad de git haria que el motor viera "el template cambio" y generara
    // un .new espurio sin que nada real haya cambiado.
    OWNER: prev.OWNER ?? gitUserName(cwd) ?? 'por definir',
    HARNESS_VERSION: manifest.harnessVersion,
  }
}

// Que skills se instalan. Prioridad: --skills explicito > seleccion guardada en
// el lockfile (sticky, como las vars) > checkbox interactivo con todas marcadas.
// Las required del catalogo entran siempre, elija lo que elija.
export async function resolveSkills({ flags, lock, manifest, yes }) {
  const catalog = manifest.skills ?? []
  if (!catalog.length) return undefined

  if (flags.skills != null) {
    const chosen = String(flags.skills).split(',').map((s) => s.trim()).filter(Boolean)
    const known = new Set(catalog.map((s) => s.id))
    const unknown = chosen.filter((id) => !known.has(id))
    if (unknown.length) {
      throw new Error(`--skills: skill(s) desconocida(s): ${unknown.join(', ')}. Disponibles: ${[...known].join(', ')}`)
    }
    return chosen
  }

  if (lock?.skills) return lock.skills

  const optional = catalog.filter((s) => !s.required)
  const requiredLabels = catalog.filter((s) => s.required).map((s) => s.id).join(', ')
  return ui.multiselect({
    message: `Skills opcionales a instalar (${requiredLabels} son obligatorias y se instalan siempre)`,
    options: optional.map((s) => ({ value: s.id, label: s.label ?? s.id })),
    initialValues: optional.map((s) => s.id),
    yes,
  })
}

// El nucleo compartido por init y upgrade: son el mismo code path. Lo unico que
// cambia entre "repo vacio", "repo con codigo" y "migrar de version" es que
// encuentra computePlan en disco y en el lockfile.
export async function planAndApply({ manifest, cwd, lock, vars, detected, flags, title }) {
  const force = Boolean(flags.force)
  const yes = Boolean(flags.yes) || ui.isCI()
  const skills = await resolveSkills({ flags, lock, manifest, yes })
  const plan = computePlan({ manifest, cwd, lock, vars, detected, force, skills })

  ui.renderPlan(plan, { verbose: Boolean(flags.verbose) })

  const pending = writeActions(plan.actions)
  const obsolete = plan.actions.filter((a) => a.verdict === OBSOLETE)

  if (!pending.length && !obsolete.length) {
    ui.outro(`Ya estas en harness v${manifest.harnessVersion}. Nada que hacer.`)
    return 0
  }

  if (flags['dry-run']) {
    ui.outro('--dry-run: no se escribio ni un byte.')
    return 0
  }

  const ok = await ui.confirm({ message: `${title}: aplicar ${pending.length} cambio(s)?`, initialValue: true, yes })
  if (!ok) {
    ui.cancelled()
    return 1
  }

  // --prune borra archivos. Los obsoletos intactos desde que el harness los
  // escribio (autoPrune) se borran sin preguntar -- es contenido del harness, no
  // del usuario. Los que el usuario edito exigen la segunda confirmacion escrita,
  // y --yes NUNCA la implica.
  const prune = Boolean(flags.prune && obsolete.length)
  const editedObsolete = obsolete.filter((a) => !a.autoPrune)
  let pruneEdited = false
  if (prune && editedObsolete.length) {
    pruneEdited = await ui.confirmDestructive({
      message: `Se van a BORRAR ${editedObsolete.length} archivo(s) obsoleto(s) que editaste:\n${editedObsolete.map((a) => `    ${a.dest}`).join('\n')}`,
      word: 'BORRAR',
    })
    if (!pruneEdited) ui.log.warn('Prune de los editados cancelado. Esos archivos quedan donde estan.')
  }

  const result = apply({
    plan,
    cwd,
    manifest,
    vars,
    detected,
    lock,
    prune,
    pruneEdited,
    backup: flags.backup !== false,
  })

  report(result, plan, manifest)
  reportSkippedByStack(plan)
  return 0
}

// Entries con "when": "stack:<id>" (ej. tag-release, atado a Node) no se
// instalan si el repo no trae esa senal. No es un error -- es la senal de que
// el agente tiene que generar el equivalente para el stack real del proyecto,
// siguiendo la instruccion de la skill harness-upgrade.
function reportSkippedByStack(plan) {
  if (!plan.skippedByStack?.length) return
  ui.log.warn(
    [
      'No se instalaron por stack (requieren un lenguaje/runtime que este repo no tiene):',
      ...plan.skippedByStack.map((s) => `    ${s.dest} (requiere stack: ${s.stack})`),
      '',
      'Ver skill harness-upgrade -- seccion "Tag-release fuera de Node" -- para generar',
      'el equivalente segun el stack real del proyecto.',
    ].join('\n')
  )
}

// Siempre activa, sin pedir confirmacion: "main solo recibe merges desde dev" es
// una regla dura de CLAUDE.md/coe-github, no una preferencia opcional. Corre solo
// si el plan se aplico y nunca en --dry-run (no toca nada fuera del repo local).
// Si gh no esta disponible o falla, se reporta y el resto de init/upgrade sigue:
// nunca bloquea la instalacion. `protege` es inyectable para testear.
export function githubProtectionStep({ code, cwd, flags, protege = protegeBranchMain }) {
  if (code !== 0) return code
  if (flags['dry-run']) return code
  protege({ cwd })
  return code
}

function report(result, plan, manifest) {
  const news = result.written.filter((w) => w.dest.endsWith('.new'))
  const touched = plan.actions.filter((a) => a.verdict === LOCAL_EDIT)
  const kept = plan.actions.filter((a) => a.verdict === NOOP).length

  ui.log.success(`${result.written.length} archivo(s) escrito(s). ${kept} sin cambios.`)

  if (result.backupRoot) {
    ui.log.info(`Backup de lo sobrescrito en ${result.backupRoot.split(/[\\/]/).slice(-2).join('/')}`)
  }
  if (result.removed.length) {
    ui.log.warn(`Borrados: ${result.removed.join(', ')}`)
  }
  if (touched.length) {
    ui.log.info(`Respetados (los editaste tú, el template no cambio): ${touched.map((a) => a.dest).join(', ')}`)
  }

  if (news.length) {
    ui.log.warn(
      [
        `${news.length} archivo(s) NO fueron sobrescritos. La propuesta del harness quedo al lado, en .new:`,
        ...news.map((w) => `    ${w.dest}`),
        '',
        'Compara y mergea a mano. Por ejemplo:',
        `    git diff --no-index ${news[0].dest.replace(/\.new$/, '')} ${news[0].dest}`,
      ].join('\n')
    )
  }

  ui.outro(`Harness v${manifest.harnessVersion} listo.`)
}

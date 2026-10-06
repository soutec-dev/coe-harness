import { execFileSync } from 'node:child_process'
import * as ui from '../ui.js'

// CLAUDE.md, regla dura: "main solo recibe merges desde dev", ningun push ni
// merge directo. Esto la hace cumplir a nivel de GitHub (no solo en el hook de
// la sesion): sin esto, alguien con permiso de push igual podia pushear directo
// a main desde cualquier maquina, saltandose todos los checks.
const RAMA_PROTEGIDA = 'main'
// dev solo se protege de lo irreversible (force-push y borrado): el flujo
// commitea el bump de version directo en dev, asi que no se le exige PR.
const RAMA_INTEGRACION = 'dev'
// Nombre del check tal como lo reporta GitHub Actions: el job de
// reglas-pr.yml se llama "reglas-pr" y no declara "name:", asi que el check-run
// queda con el id del job. Si el job se renombra, esto se desincroniza y hay que
// actualizarlo a mano.
const CHECKS_REQUERIDOS = ['reglas-pr']

function sh(args, cwd, input) {
  return execFileSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
  }).trim()
}

function ghDisponible(cwd) {
  try {
    sh(['gh', 'auth', 'status'], cwd, '')
    return true
  } catch {
    return false
  }
}

function repoRemoto(cwd) {
  try {
    return sh(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd, '')
  } catch {
    return null
  }
}

function ramaExiste(cwd, repo, rama) {
  try {
    sh(['gh', 'api', `repos/${repo}/branches/${rama}`], cwd, '')
    return true
  } catch {
    return false
  }
}

// La proteccion vigente de una rama, o null si no tiene (404) o no se pudo leer.
function proteccionActual(cwd, repo, rama) {
  try {
    return JSON.parse(sh(['gh', 'api', `repos/${repo}/branches/${rama}/protection`], cwd, ''))
  } catch {
    return null
  }
}

// Lo minimo que el harness exige para main: PR obligatorio con el check de
// reglas-pr en verde, sin force-push ni borrado, tambien para administradores.
// Sin aprobaciones obligatorias por defecto: en un equipo de dos, exigir 1
// approval dejaria trabado el PR de release cuando lo abre el propio
// coordinador. Equipos con dos o mas revisores deben subirlo a 1 y activar
// "require review from code owners" en Settings > Branches: el harness nunca
// vuelve a bajar lo que se endurecio a mano (ver fusionarProteccion).
export function proteccionBase() {
  return {
    required_status_checks: { strict: true, checks: CHECKS_REQUERIDOS.map((context) => ({ context })) },
    enforce_admins: true,
    required_pull_request_reviews: { required_approving_review_count: 0 },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  }
}

export function cuerpoProteccion() {
  return JSON.stringify(proteccionBase())
}

// PUT reemplaza la proteccion completa, asi que antes se lee la vigente y solo
// se endurece: aprobaciones = las que haya (nunca menos), code owners, dismiss
// stale, last-push approval, conversation resolution, linear history y las
// restricciones de quien pushea se conservan si estaban, y los checks
// requeridos se unen con el del harness.
export function fusionarProteccion(existente) {
  const base = proteccionBase()
  if (!existente) return base

  const rsc = existente.required_status_checks ?? {}
  const checksExistentes = rsc.checks ?? (rsc.contexts ?? []).map((context) => ({ context }))
  const contextos = new Set([...checksExistentes.map((c) => c.context), ...CHECKS_REQUERIDOS])
  base.required_status_checks = { strict: true, checks: [...contextos].map((context) => ({ context })) }

  const rev = existente.required_pull_request_reviews ?? {}
  base.required_pull_request_reviews = {
    required_approving_review_count: Math.max(rev.required_approving_review_count ?? 0, 0),
    require_code_owner_reviews: Boolean(rev.require_code_owner_reviews),
    dismiss_stale_reviews: Boolean(rev.dismiss_stale_reviews),
    require_last_push_approval: Boolean(rev.require_last_push_approval),
  }
  const dr = rev.dismissal_restrictions
  if (dr && ((dr.users ?? []).length || (dr.teams ?? []).length)) {
    base.required_pull_request_reviews.dismissal_restrictions = {
      users: (dr.users ?? []).map((u) => u.login),
      teams: (dr.teams ?? []).map((t) => t.slug),
    }
  }

  if (existente.required_conversation_resolution?.enabled) base.required_conversation_resolution = true
  if (existente.required_linear_history?.enabled) base.required_linear_history = true
  if (existente.restrictions) {
    base.restrictions = {
      users: (existente.restrictions.users ?? []).map((u) => u.login),
      teams: (existente.restrictions.teams ?? []).map((t) => t.slug),
      apps: (existente.restrictions.apps ?? []).map((a) => a.slug),
    }
  }
  return base
}

export function proteccionDev() {
  return {
    required_status_checks: null,
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  }
}

// gh escribe el mensaje de la API en stderr ("gh: Upgrade to GitHub Pro or make
// this repository public to enable this feature. (HTTP 403)"). Un repo privado
// en un plan Free no es un error del harness ni un permiso que falte: GitHub no
// ofrece branch protection en ese plan, y el mensaje tiene que decirlo tal cual
// para que nadie salga a buscar un permiso que no existe.
export function motivoDelFallo(err) {
  const texto = `${err?.stderr ?? ''}\n${err?.message ?? ''}`
  if (/upgrade to github (pro|team)|make this repository public/i.test(texto)) return 'plan'
  if (/HTTP 403|HTTP 404|must have admin rights|resource not accessible/i.test(texto)) return 'permiso'
  return 'otro'
}

function primeraLinea(err) {
  const stderr = String(err?.stderr ?? '').trim()
  return (stderr || String(err?.message ?? err)).split('\n')[0]
}

function aplicar(cwd, repo, rama, cuerpo) {
  sh(['gh', 'api', '-X', 'PUT', `repos/${repo}/branches/${rama}/protection`, '--input', '-'], cwd, JSON.stringify(cuerpo))
}

function protegeDev(cwd, repo) {
  if (!ramaExiste(cwd, repo, RAMA_INTEGRACION)) return
  // Si dev ya tiene alguna proteccion, es del equipo: no se toca.
  if (proteccionActual(cwd, repo, RAMA_INTEGRACION)) return
  try {
    aplicar(cwd, repo, RAMA_INTEGRACION, proteccionDev())
    ui.log.info(`"${RAMA_INTEGRACION}" en ${repo}: sin force-push ni borrado.`)
  } catch (err) {
    ui.log.warn(`No se pudo proteger "${RAMA_INTEGRACION}" en ${repo}: ${primeraLinea(err)}`)
  }
}

// Siempre activa, sin preguntar: la regla "main solo desde dev" es no-negociable,
// asi que hacerla cumplir en GitHub tampoco lo es. No rompe init/upgrade si
// falla: se reporta y se sigue.
export function protegeBranchMain({ cwd }) {
  if (!ghDisponible(cwd)) {
    ui.log.warn(
      'gh no esta instalado o no esta autenticado: no se pudo configurar la proteccion de main. ' +
        'Instala GitHub CLI, corre `gh auth login` y reintenta con `coe-harness upgrade`.'
    )
    return { aplicado: false }
  }

  const repo = repoRemoto(cwd)
  if (!repo) {
    ui.log.warn('No se pudo resolver el repo de GitHub (sin remoto o sin permisos): proteccion de main no configurada.')
    return { aplicado: false }
  }

  if (!ramaExiste(cwd, repo, RAMA_PROTEGIDA)) {
    ui.log.info(`"${RAMA_PROTEGIDA}" todavia no existe en ${repo}: proteccion de main queda pendiente para cuando exista.`)
    return { aplicado: false }
  }

  try {
    const existente = proteccionActual(cwd, repo, RAMA_PROTEGIDA)
    const cuerpo = fusionarProteccion(existente)
    aplicar(cwd, repo, RAMA_PROTEGIDA, cuerpo)
    const aprobaciones = cuerpo.required_pull_request_reviews.required_approving_review_count
    const checks = cuerpo.required_status_checks.checks.map((c) => `"${c.context}"`).join(' y ')
    ui.log.success(
      `Branch protection de "${RAMA_PROTEGIDA}" en ${repo}: PR obligatorio${aprobaciones ? ` con ${aprobaciones} aprobacion(es)` : ''} + check ${checks} en verde, sin force-push ni borrado${existente ? ' (lo que ya estaba configurado se conservo)' : ''}.`
    )
    protegeDev(cwd, repo)
    return { aplicado: true }
  } catch (err) {
    const motivo = motivoDelFallo(err)
    if (motivo === 'plan') {
      ui.log.info(
        `${repo} es un repo privado en un plan Free de GitHub, y GitHub no ofrece proteccion de ramas ahi: ` +
          `"${RAMA_PROTEGIDA}" queda sin proteger del lado de GitHub. No hay nada que arreglar: el hook reglas-pr ` +
          'sigue denegando los push a main desde la sesion. Para tener la proteccion tambien en GitHub, haz publico ' +
          'el repo o pasa a GitHub Pro/Team y corre `coe-harness upgrade`.'
      )
    } else if (motivo === 'permiso') {
      ui.log.warn(
        `No se pudo configurar la proteccion de "${RAMA_PROTEGIDA}" en ${repo}: hace falta permiso de admin en el repo. ` +
          'Pidele al coordinador que corra `coe-harness upgrade` o que la configure en Settings > Branches.'
      )
    } else {
      ui.log.warn(`No se pudo configurar la proteccion de "${RAMA_PROTEGIDA}" en ${repo}: ${primeraLinea(err)}`)
    }
    return { aplicado: false }
  }
}

import { execFileSync } from 'node:child_process'
import * as ui from '../ui.js'

// CLAUDE.md, regla dura: "main solo recibe merges desde dev", ningun push ni
// merge directo. Esto la hace cumplir a nivel de GitHub (no solo en el hook de
// la sesion): sin esto, alguien con permiso de push igual podia pushear directo
// a main desde cualquier maquina, saltandose todos los checks.
const RAMA_PROTEGIDA = 'main'
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

function ramaExiste(cwd, repo) {
  try {
    sh(['gh', 'api', `repos/${repo}/branches/${RAMA_PROTEGIDA}`], cwd, '')
    return true
  } catch {
    return false
  }
}

// Exige PR para tocar main (bloquea push directo) con el check "reglas-pr" en
// verde, sin force-push ni borrado de la rama. enforce_admins: true para que la
// regla alcance tambien a administradores. Sin aprobaciones obligatorias por
// defecto: en un equipo de dos, exigir 1 approval dejaria trabado el PR de
// release cuando lo abre el propio coordinador. Equipos con dos o mas revisores
// deben subirlo a 1 en Settings > Branches (CODEOWNERS ya lo deja listo).
export function cuerpoProteccion() {
  // La API exige null (no un objeto con checks vacios) para "sin checks".
  const required_status_checks = CHECKS_REQUERIDOS.length
    ? { strict: true, checks: CHECKS_REQUERIDOS.map((context) => ({ context })) }
    : null
  return JSON.stringify({
    required_status_checks,
    enforce_admins: true,
    required_pull_request_reviews: { required_approving_review_count: 0 },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  })
}

// Siempre activa, sin preguntar: la regla "main solo desde dev" es no-negociable,
// asi que hacerla cumplir en GitHub tampoco lo es. No rompe init/upgrade si
// falla: se reporta y se sigue.
export function protegeBranchMain({ cwd }) {
  if (!ghDisponible(cwd)) {
    ui.log.warn(
      'gh no esta instalado o no esta autenticado: no se pudo configurar la proteccion de main. ' +
        'Corre `gh auth login` y reintenta con `coe-harness upgrade`.'
    )
    return { aplicado: false }
  }

  const repo = repoRemoto(cwd)
  if (!repo) {
    ui.log.warn('No se pudo resolver el repo de GitHub (sin remoto o sin permisos): proteccion de main no configurada.')
    return { aplicado: false }
  }

  if (!ramaExiste(cwd, repo)) {
    ui.log.info(`"${RAMA_PROTEGIDA}" todavia no existe en ${repo}: proteccion de main queda pendiente para cuando exista.`)
    return { aplicado: false }
  }

  try {
    sh(
      ['gh', 'api', '-X', 'PUT', `repos/${repo}/branches/${RAMA_PROTEGIDA}/protection`, '--input', '-'],
      cwd,
      cuerpoProteccion()
    )
    ui.log.success(
      `Branch protection de "${RAMA_PROTEGIDA}" en ${repo}: PR obligatorio + check ${CHECKS_REQUERIDOS.map((c) => `"${c}"`).join(' y ')} en verde, sin force-push ni borrado.`
    )
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

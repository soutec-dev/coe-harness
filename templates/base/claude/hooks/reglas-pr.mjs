// Hook de Claude Code del harness (managed): reglas de PR en la sesion.
//
// Los checks de scripts/check-pr-rules.mjs corren tambien en CI
// (.github/workflows/reglas-pr.yml), pero este hook los corre dentro de la
// sesion del agente, en el momento en que importan y antes de que nada salga
// del repo:
//
//   PreToolUse  · git push              -> deniega el push si va a main/master
//                                          (tambien si lo borra), si es
//                                          --force/-f/+refspec, --all/--mirror o
//                                          el refspec ":" (matching), si el
//                                          remoto no es origin (por nombre o por
//                                          la URL real a la que iria), o si el
//                                          grupo secretos (credenciales y datos
//                                          sensibles) falla sobre los commits
//                                          que subiria. Despues le pide a git
//                                          que ENSAYE el push (--dry-run) y
//                                          deniega si el destino real es main.
//                                          Todo lo que no puede analizar con
//                                          certeza PIDE CONFIRMACION, nunca pasa
//                                          en silencio: metacaracteres del
//                                          shell, `git -c`, variables de
//                                          entorno, opciones desconocidas o
//                                          abreviadas, un comando previo que
//                                          cambia la rama, la configuracion, el
//                                          entorno o los commits (`source`,
//                                          funciones, alias incluidos), una
//                                          carpeta que no puede resolver, un
//                                          `git` envuelto en otro programa o
//                                          con subcomando no literal, un alias
//                                          de git, `git push` dentro de una
//                                          cadena o un script, un ensayo que
//                                          falla, o quedarse sin tiempo.
//                                          Revisa todos los push del comando.
//   PostToolUse · gh pr create / edit   -> los tres grupos contra el PR (solo si
//                                          el PR es de este repo), un comentario
//                                          con el resultado en el PR (la
//                                          evidencia para el revisor) y el
//                                          resultado de vuelta al agente: block
//                                          si falla secretos o pr-metadata.
//   Manual      · node .claude/hooks/reglas-pr.mjs --pr <url>
//                                       -> lo mismo que el PostToolUse, para
//                                          despues de un push correctivo (que no
//                                          vuelve a disparar el hook) o si el
//                                          hook no corrio.
//
// Es un hook de Claude Code, no un git hook. No hace nada en repos sin
// scripts/check-pr-rules.mjs, ni con comandos que no tocan git.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Sin prompts de credenciales: ni de git, ni de gh, ni del Git Credential
// Manager. Un ensayo de push que se cuelga esperando un usuario es peor que
// uno que falla (y un fallo aqui termina en "ask", no en silencio).
const ENTORNO = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GCM_INTERACTIVE: 'never' }
const MARCA = '<!-- coe-harness:reglas-pr -->'
const LIMITE_SALIDA = 60_000
const MAX_AVISOS = 20
const RAMAS_PROTEGIDAS = ['main', 'master']
const RAMA_INTEGRACION = 'dev'
const REMOTO_PERMITIDO = 'origin'
// Presupuesto de reloj del PreToolUse, por debajo del timeout del hook en
// settings.json (120 s): un hook que la plataforma cancela por timeout NO
// bloquea el comando, asi que el hook tiene que responder antes. Agotado el
// presupuesto, pide confirmacion.
const PRESUPUESTO_MS = 100_000

// rama-commits es informativo: un nombre de rama o un commit con otro formato
// no traba nada. secretos y pr-metadata si bloquean.
const GRUPOS = [
  { grupo: 'rama-commits', bloqueante: false },
  { grupo: 'secretos', bloqueante: true },
  { grupo: 'pr-metadata', bloqueante: true },
]

// --- Lectura del comando ---------------------------------------------------

// Parte un comando de shell por sus operadores de control (&&, ||, |, ;, &,
// saltos de linea) sin cortar dentro de comillas: `git commit -m "x; git push"`
// es un solo segmento. Las redirecciones (2>&1, &>) no son operadores.
export function segmentos(comando, shell = 'bash') {
  const escape = shell === 'powershell' ? '`' : '\\'
  const salida = []
  let actual = ''
  let comilla = null
  for (let i = 0; i < comando.length; i++) {
    const c = comando[i]
    if (comilla) {
      actual += c
      if (c === escape && comilla === '"' && i + 1 < comando.length) actual += comando[++i]
      else if (c === comilla) comilla = null
      continue
    }
    if (c === "'" || c === '"') {
      comilla = c
      actual += c
    } else if (c === escape && i + 1 < comando.length) {
      actual += c + comando[++i]
    } else if (c === '&' && (/[<>]$/.test(actual) || comando[i + 1] === '>')) {
      actual += c
    } else if (c === ';' || c === '\n' || c === '\r' || c === '&' || c === '|') {
      if ((c === '&' || c === '|') && comando[i + 1] === c) i++
      salida.push(actual)
      actual = ''
    } else {
      actual += c
    }
  }
  salida.push(actual)
  return salida.map((s) => s.trim()).filter(Boolean)
}

// Palabras de un segmento, sin comillas. Descarta las redirecciones (2>&1,
// > archivo) y las asignaciones iniciales (VAR=valor git push).
export function palabras(segmento, shell = 'bash') {
  const escape = shell === 'powershell' ? '`' : '\\'
  const crudas = []
  let actual = ''
  let hay = false
  let comilla = null
  for (let i = 0; i < segmento.length; i++) {
    const c = segmento[i]
    if (comilla) {
      // En bash, dentro de comillas dobles la barra solo escapa " \ $ ` y el
      // salto de linea: "C:\Users\x" queda tal cual. En PowerShell, el
      // backtick escapa cualquier caracter.
      const escapado = segmento[i + 1] ?? ''
      if (c === comilla) comilla = null
      else if (c === escape && comilla === '"' && (shell === 'powershell' ? escapado !== '' : /["\\$`\n]/.test(escapado))) actual += segmento[++i]
      else actual += c
      continue
    }
    if (c === "'" || c === '"') {
      comilla = c
      hay = true
    } else if (c === escape && i + 1 < segmento.length) {
      actual += segmento[++i]
      hay = true
    } else if (/\s/.test(c)) {
      if (hay) crudas.push(actual)
      actual = ''
      hay = false
    } else {
      actual += c
      hay = true
    }
  }
  if (hay) crudas.push(actual)

  const sinRedireccion = []
  for (let i = 0; i < crudas.length; i++) {
    const m = crudas[i].match(/^(\d*|&)?(>>?|<)(&\d+|&-)?(.*)$/)
    if (m) {
      if (!m[3] && m[4] === '') i++ // operador solo: la palabra siguiente es el archivo
      continue
    }
    sinRedireccion.push(crudas[i])
  }
  let desde = 0
  while (desde < sinRedireccion.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(sinRedireccion[desde])) desde++
  return sinRedireccion.slice(desde)
}

const ES_GIT = /(^|[\\/])git(\.exe)?$/i
const ES_GH = /(^|[\\/])gh(\.exe)?$/i
const ES_CD = /^(cd|chdir|set-location|sl)$/i
const ES_PUSHD = /^(pushd|push-location|pushl)$/i
const ES_POPD = /^(popd|pop-location|popl)$/i
// Programas que ejecutan lo que les sigue: `env git push`, `timeout 60 git
// push`, `cmd /c git push`, `sudo git push`...
const ENVOLTORIOS =
  /^(env|command|exec|builtin|nice|time|timeout|sudo|doas|nohup|stdbuf|xargs|winpty|unbuffer|caffeinate|watch|flock|ionice|chrt|taskset|strace|ltrace|hyperfine|retry|cmd|cmd\.exe|start|start-process|saps|start-job|sajb|invoke-command|icm|powershell|pwsh|bash|sh|zsh|dash|ksh)$/i
// Opciones globales de git que llevan valor aparte (`git -C dir push`).
const GLOBALES_CON_VALOR = ['-C', '-c', '--git-dir', '--work-tree', '--namespace']
// Opciones de `git push` que el hook conoce, escritas completas. git acepta
// cualquier prefijo no ambiguo (--recei= es --receive-pack): lo que no este
// aqui pide confirmacion y nunca llega al ensayo.
const LARGAS_CONOCIDAS = new Set([
  '--all', '--branches', '--mirror', '--tags', '--follow-tags', '--no-follow-tags', '--delete',
  '--force', '--no-force', '--force-with-lease', '--no-force-with-lease', '--force-if-includes', '--no-force-if-includes',
  '--dry-run', '--porcelain', '--verbose', '--quiet', '--set-upstream', '--no-set-upstream', '--atomic', '--no-atomic',
  '--prune', '--no-prune', '--signed', '--no-signed', '--thin', '--no-thin', '--progress', '--no-progress',
  '--recurse-submodules', '--no-recurse-submodules', '--ipv4', '--ipv6',
  '--push-option', '--receive-pack', '--exec', '--repo', '--no-verify', '--verify',
])
const CORTAS_CONOCIDAS = new Set(['u', 'f', 'd', 'q', 'v', 'n', '4', '6', 'o'])
const OPCIONES_PUSH_CON_VALOR = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
// Opciones que cambian a donde o como se sube sin que el refspec lo diga. El
// hook no las resuelve: pide confirmacion al usuario.
const OPCIONES_RIESGOSAS = /^(--push-option(=.*)?|-o|--receive-pack(=.*)?|--exec(=.*)?|--no-verify|--repo(=.*)?)$/
// Reescriben la historia remota de la rama (con una verificacion, pero la
// reescriben): solo sobre la rama propia y con el usuario de acuerdo.
const OPCIONES_DE_REESCRITURA = /^(--force-with-lease(=.*)?|--force-if-includes)$/
// Metacaracteres que el shell expande antes de que git vea el comando: el hook
// ve el texto crudo y no puede saber en que ref terminan.
const METACARACTERES = /[$`{}*?[\]]/
// Una palabra que el shell resuelve en tiempo de ejecucion (variable,
// sustitucion, comodin, splatting): no es un subcomando ni una ruta literal.
const NO_LITERAL = /[$`{}()*?[\]%@]/
// Lo que, ejecutado antes del push en el mismo comando, cambia la rama actual,
// el remoto o la configuracion con la que git va a resolver el destino: el hook
// ensaya con el estado de AHORA, no con el de despues.
const CAMBIA_DESTINO = /^(checkout|switch|config|remote|branch|symbolic-ref|update-ref|worktree)$/
// Lo que cambia los commits que el push subiria: el escaneo de secretos solo
// ve los commits que ya existen cuando corre el hook.
const CAMBIA_CONTENIDO = /^(commit|merge|rebase|cherry-pick|am|apply|revert|stash|reset|pull|tag)$/
// Lo que carga o define cosas que el hook no ve: archivos de entorno, alias,
// funciones de shell (una funcion `git` reemplaza al git real).
const CARGA_ENTORNO =
  /^(source|\.|eval|exec|alias|unalias|set-alias|sal|new-alias|nal|remove-alias|invoke-expression|iex|function|filter|set-variable|sv|new-variable|nv|set-item|si|import-module|ipmo)$/i
const ASIGNA_ENTORNO = /^(export|set|setx|declare|typeset|env)$/i
const ASIGNACION = /^\s*[A-Za-z_][A-Za-z0-9_]*=/
const VARIABLE_POWERSHELL = /^\s*\$[\w:]+\s*=/
const ENTORNO_POWERSHELL = /^\s*\$env:|SetEnvironmentVariable/i
const DEFINE_FUNCION = /^\s*(function\s+[\w.:-]+|[\w.-]+\s*\(\s*\))/i
// `git push` en cualquier parte del texto: dentro de una cadena (`sh -c 'git
// push'`), de un script, de una asignacion (`cmd="git push"`), de un
// `Invoke-Expression`... El hook no puede analizarlo, asi que lo marca.
const MENCIONA_GIT_PUSH = /(?:^|[^\w.-])git(?:\.exe)?["')\]]*\s+(?:-{1,2}[\w=./:\\-]*\s+)*["'(]*push(?![\w-])/i

const recorte = (s) => (s.length > 60 ? `${s.slice(0, 57)}...` : s)

// --- Carpetas: cd, pushd/popd, rutas POSIX en Windows -----------------------

function rutaAbsolutaDePosix(ruta) {
  if (process.platform !== 'win32') return ruta
  const m = ruta.match(/^\/(?:cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/)
  if (m) return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`
  return null // /tmp, /usr: rutas de MSYS que el hook no sabe traducir
}

// Resuelve `destino` contra `base`. Devuelve { ruta } o { motivo } cuando el
// hook no puede saber a que carpeta apunta (variables, comodines, rutas POSIX
// sin traduccion, base desconocida).
function resuelveRuta(base, destino) {
  if (!destino) return { motivo: 'carpeta vacia' }
  if (NO_LITERAL.test(destino) || destino.startsWith('~-')) return { motivo: `no puedo resolver la carpeta \`${destino}\`` }
  let ruta = destino
  if (ruta === '~' || ruta.startsWith('~/') || ruta.startsWith('~\\')) ruta = path.join(os.homedir(), ruta.slice(1))
  else if (ruta.startsWith('~')) return { motivo: `no puedo resolver la carpeta \`${destino}\`` }
  if (ruta.startsWith('/') && process.platform === 'win32') {
    const traducida = rutaAbsolutaDePosix(ruta)
    if (!traducida) return { motivo: `no puedo traducir la ruta POSIX \`${destino}\`` }
    ruta = traducida
  }
  if (!path.isAbsolute(ruta) && base == null) return { motivo: `no se desde que carpeta se resuelve \`${destino}\`` }
  return { ruta: path.isAbsolute(ruta) ? path.normalize(ruta) : path.resolve(base, ruta) }
}

// Estado de carpetas a lo largo del comando: la actual, la anterior (cd -), la
// pila de pushd/popd, y el motivo por el que dejo de ser resoluble (si paso).
function carpetasDesde(cwd) {
  return { actual: cwd, anterior: null, pila: [], motivo: null }
}

function mueve(carpetas, ruta) {
  carpetas.anterior = carpetas.actual
  carpetas.actual = ruta
  carpetas.motivo = null
}

function pierde(carpetas, motivo) {
  carpetas.anterior = carpetas.actual
  carpetas.actual = null
  carpetas.motivo = motivo
}

function aplicaCd(carpetas, p, segmento) {
  if (ES_POPD.test(p[0])) {
    const previa = carpetas.pila.pop()
    if (previa === undefined) return pierde(carpetas, `\`${recorte(segmento)}\` sin pushd previo en el mismo comando`)
    if (previa === null) return pierde(carpetas, `\`${recorte(segmento)}\` vuelve a una carpeta que no pude resolver`)
    return mueve(carpetas, previa)
  }
  const args = p.slice(1)
  const destino = args.find((x) => x === '-' || !x.startsWith('-'))
  if (ES_PUSHD.test(p[0])) {
    if (destino === undefined) return pierde(carpetas, `\`${recorte(segmento)}\` sin carpeta intercambia la pila`)
    carpetas.pila.push(carpetas.actual)
  }
  if (destino === undefined) return mueve(carpetas, os.homedir())
  if (destino === '-') {
    if (!carpetas.anterior) return pierde(carpetas, '`cd -` sin una carpeta anterior conocida')
    return mueve(carpetas, carpetas.anterior)
  }
  const r = resuelveRuta(carpetas.actual, destino)
  if (r.motivo) return pierde(carpetas, r.motivo)
  mueve(carpetas, r.ruta)
}

// --- Invocaciones de git ----------------------------------------------------

// Indice del token `git` que actua como comando en un segmento, o -1. Un git
// envuelto (`env git push`, `timeout 60 git push`, `cmd /c git push`) cuenta;
// la palabra git como argumento de otra cosa (`grep git docs/`) no.
function indiceDeGit(p) {
  const k = p.findIndex((w) => ES_GIT.test(w))
  if (k <= 0) return k
  const previa = p[k - 1] ?? ''
  const envuelto =
    ENVOLTORIOS.test(p[0]) || ENVOLTORIOS.test(previa) || (/^\d+[smhd]?$/.test(previa) && ENVOLTORIOS.test(p[k - 2] ?? ''))
  return p[k + 1] === 'push' || envuelto ? k : -1
}

// Opciones globales de git (-C, -c, --git-dir...) a partir de `desde`.
function globalesDeGit(p, desde, carpetas) {
  let i = desde
  let dir = carpetas.actual
  let motivo = carpetas.motivo
  let rutaDeGit = false
  const configs = []
  while (i < p.length && p[i].startsWith('-')) {
    const [opcion, valorPegado] = p[i].includes('=') ? [p[i].slice(0, p[i].indexOf('=')), p[i].slice(p[i].indexOf('=') + 1)] : [p[i], null]
    const valor = valorPegado ?? p[i + 1] ?? ''
    const consume = valorPegado == null && GLOBALES_CON_VALOR.includes(opcion) ? 2 : 1
    if (opcion === '-C') {
      const r = resuelveRuta(dir, valor)
      if (r.motivo) {
        dir = null
        motivo = r.motivo
      } else {
        dir = r.ruta
      }
    } else if (opcion === '-c') {
      configs.push(valor)
    } else if (opcion === '--git-dir') {
      // El repo es el del .git indicado, no el del cwd.
      rutaDeGit = true
      const r = resuelveRuta(dir, valor)
      if (r.motivo) {
        dir = null
        motivo = r.motivo
      } else {
        dir = path.basename(r.ruta).toLowerCase() === '.git' ? path.dirname(r.ruta) : r.ruta
      }
    } else if (opcion === '--work-tree' || opcion === '--namespace') {
      rutaDeGit = true
    }
    i += consume
  }
  return { i, dir, motivo, rutaDeGit, configs }
}

// Que cambia un segmento previo al push: 'destino' (rama actual, remoto,
// configuracion, entorno, funciones o alias), 'contenido' (los commits) o null.
export function queCambia(segmento, shell = 'bash') {
  const s = segmento.trim()
  if (ASIGNACION.test(s) || VARIABLE_POWERSHELL.test(s) || ENTORNO_POWERSHELL.test(s) || DEFINE_FUNCION.test(s)) return 'destino'
  const q = palabras(segmento, shell)
  if (!q.length) return null
  const k = indiceDeGit(q)
  if (k !== -1) {
    // Una invocacion de git (envuelta o no) se juzga por su subcomando.
    const g = globalesDeGit(q, k + 1, carpetasDesde(null))
    if (g.configs.some((c) => /^alias\./i.test(c))) return 'destino'
    const sub = q[g.i]
    if (sub == null || NO_LITERAL.test(sub)) return 'destino'
    if (CAMBIA_DESTINO.test(sub)) return 'destino'
    if (CAMBIA_CONTENIDO.test(sub)) return 'contenido'
    return null
  }
  if (CARGA_ENTORNO.test(q[0])) return 'destino'
  if (ASIGNA_ENTORNO.test(q[0])) {
    // `set -e`, `set -o pipefail`: opciones del shell. Solo `set X=1` (cmd) asigna.
    if (q[0].toLowerCase() === 'set' && !q.slice(1).some((a) => a.includes('='))) return null
    return 'destino'
  }
  return MENCIONA_GIT_PUSH.test(s) ? 'destino' : null
}

// Todas las invocaciones de git del comando (push o no), en orden, con su
// contexto, y las `sospechas`: segmentos que el hook no puede analizar y que
// podrian ser un push (subcomando no literal, `git push` dentro de una cadena
// o un script, comando no literal).
export function invocacionesDeGit(comando, cwd, shell = 'bash') {
  const carpetas = carpetasDesde(cwd)
  const previos = []
  const invocaciones = []
  const sospechas = []
  for (const segmento of segmentos(comando, shell)) {
    const p = palabras(segmento, shell)
    // Una asignacion sola (`cmd="git push origin main"`) tambien cuenta.
    const k = p.length ? indiceDeGit(p) : -1
    if (p.length && (ES_CD.test(p[0]) || ES_PUSHD.test(p[0]) || ES_POPD.test(p[0]))) {
      aplicaCd(carpetas, p, segmento)
      continue
    }
    if (k === -1) {
      if (MENCIONA_GIT_PUSH.test(segmento)) sospechas.push(`\`${recorte(segmento)}\` menciona \`git push\` dentro de una cadena, un script o un envoltorio que no puedo analizar`)
      else if (p.length && /^[$%`]/.test(p[0])) sospechas.push(`\`${recorte(segmento)}\`: el comando no es literal`)
      previos.push(segmento)
      continue
    }
    const g = globalesDeGit(p, k + 1, carpetas)
    const sub = p[g.i] ?? null
    const subLiteral = sub != null && !NO_LITERAL.test(sub)
    const envoltorio = p.slice(0, k)
    if (sub != null && !subLiteral) sospechas.push(`\`${recorte(segmento)}\`: el subcomando de git no es literal`)
    else if (sub == null && envoltorio.length) sospechas.push(`\`${recorte(segmento)}\`: git sin subcomando dentro de un envoltorio`)
    // `Start-Process git -ArgumentList "push","origin","HEAD:main"`: git va
    // envuelto y el subcomando viaja empacado en los argumentos del lanzador.
    else if (sub !== 'push' && envoltorio.length && MENCIONA_GIT_PUSH.test(segmento)) sospechas.push(`\`${recorte(segmento)}\`: git va envuelto con el subcomando empacado en los argumentos del lanzador`)
    if (g.configs.some((c) => /^alias\./i.test(c))) sospechas.push(`\`${recorte(segmento)}\` define un alias de git con -c`)
    invocaciones.push({
      segmento,
      dir: g.dir,
      dirIrresoluble: g.dir == null ? g.motivo ?? 'carpeta desconocida' : null,
      envoltorio,
      sub,
      subLiteral,
      args: p.slice(g.i + 1),
      configs: g.configs,
      rutaDeGit: g.rutaDeGit,
      entorno: ASIGNACION.test(segmento),
      metacaracteres: METACARACTERES.test(segmento),
      previos: [...previos],
      cambiosPrevios: previos.map((s) => ({ segmento: recorte(s), cambia: queCambia(s, shell) })).filter((x) => x.cambia),
    })
    previos.push(segmento)
  }
  return { invocaciones, sospechas }
}

// Lo que un `git push` subiria segun su texto. `cabezas`: revs cuyos commits
// sin pushear hay que revisar. `destinos`: refs remotas a las que apunta cada
// refspec ('HEAD' = la rama actual, se resuelve despues con git). `borrados`:
// refs que el push borraria. `remoto`: el nombre o URL dado, o null.
// `riesgosas`, `reescritura` y `desconocidas`: opciones que el hook no
// resuelve, que reescriben historia o que no reconoce (abreviadas incluidas).
// `args`: todo lo que sigue a `push`, para que git lo ensaye tal cual. Lo demas
// viene de la invocacion: carpeta (`dir`/`dirIrresoluble`), `envoltorio`,
// `alias`, `configs`, `rutaDeGit`, `entorno`, `metacaracteres`, `cambiosPrevios`.
export function analizaPush(inv) {
  const args = inv.args
  const posicionales = []
  const extra = []
  const riesgosas = []
  const reescritura = []
  const desconocidas = []
  let forzado = false
  let masivo = false
  let borrar = false
  for (let j = 0; j < args.length; j++) {
    const arg = args[j]
    if (arg === '--') {
      posicionales.push(...args.slice(j + 1))
      break
    }
    if (arg === '--delete' || arg === '-d') {
      borrar = true
      continue
    }
    if (arg.startsWith('--')) {
      const nombre = arg.split('=')[0]
      if (!LARGAS_CONOCIDAS.has(nombre)) desconocidas.push(arg)
      if (nombre === '--force') forzado = true
      if (nombre === '--tags' || nombre === '--follow-tags') extra.push('--tags')
      if (nombre === '--all' || nombre === '--branches') {
        extra.push('--branches')
        masivo = true
      }
      if (nombre === '--mirror') {
        extra.push('--branches', '--tags')
        masivo = true
      }
      if (OPCIONES_RIESGOSAS.test(arg)) riesgosas.push(arg)
      if (OPCIONES_DE_REESCRITURA.test(arg)) reescritura.push(arg)
      if (OPCIONES_PUSH_CON_VALOR.has(arg)) j++
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      // Grupo de flags cortos: -uf, -4f, -fu... cualquiera con "f" fuerza y
      // cualquiera con "o" lleva una push-option que el hook no resuelve.
      const letras = arg.slice(1).split('')
      if (letras.includes('f')) forzado = true
      if (letras.includes('o')) riesgosas.push(arg)
      if (letras.includes('d')) borrar = true
      if (letras.some((l) => !CORTAS_CONOCIDAS.has(l))) desconocidas.push(arg)
      if (OPCIONES_PUSH_CON_VALOR.has(arg)) j++
      continue
    }
    posicionales.push(arg)
  }
  const remoto = posicionales[0] ?? null
  const refspecs = posicionales.slice(1)
  const cabezas = []
  const destinos = []
  const borrados = []
  for (const refspec of refspecs) {
    const sinMas = refspec.replace(/^\+/, '')
    if (sinMas === ':') {
      // "matching": todas las ramas locales que ya existen en el remoto, main incluida.
      masivo = true
      extra.push('--branches')
      continue
    }
    if (borrar) {
      borrados.push(sinMas.split(':').pop())
      continue
    }
    if (sinMas.startsWith(':')) {
      borrados.push(sinMas.slice(1)) // borrar la rama remota
      continue
    }
    if (refspec.startsWith('+')) forzado = true
    const [origen, destinoExplicito] = sinMas.split(':')
    const src = origen === '' || origen === '@' ? 'HEAD' : origen
    cabezas.push(src)
    destinos.push(destinoExplicito ?? src)
  }
  // Sin refspec, push de la rama actual; --tags solo, en cambio, no la sube.
  if (!borrar && refspecs.length === 0 && !extra.includes('--branches') && !(extra.includes('--tags') && !args.includes('--follow-tags'))) {
    cabezas.push('HEAD')
    destinos.push('HEAD')
  }
  cabezas.push(...extra)
  return {
    segmento: inv.segmento,
    dir: inv.dir ?? null,
    dirIrresoluble: inv.dirIrresoluble ?? null,
    envoltorio: inv.envoltorio ?? [],
    alias: inv.alias ?? null,
    args,
    remoto,
    configs: inv.configs ?? [],
    riesgosas,
    reescritura,
    desconocidas,
    rutaDeGit: Boolean(inv.rutaDeGit),
    cambiosPrevios: inv.cambiosPrevios ?? [],
    entorno: Boolean(inv.entorno),
    metacaracteres: Boolean(inv.metacaracteres),
    cabezas: [...new Set(cabezas)],
    destinos: [...new Set(destinos)],
    borrados: [...new Set(borrados)],
    forzado,
    masivo,
  }
}

// Los `git push` escritos como tales en el comando, en orden (los alias se
// resuelven en `procesar`, que puede preguntarle a git).
export function pushesDelComando(comando, cwd, shell = 'bash') {
  return invocacionesDeGit(comando, cwd, shell)
    .invocaciones.filter((inv) => inv.sub === 'push')
    .map(analizaPush)
}

// El primer `git push` del comando, o null si no hay ninguno.
export function pushDelComando(comando, cwd, shell = 'bash') {
  return pushesDelComando(comando, cwd, shell)[0] ?? null
}

const FLAGS_DE_METADATA = /^(--body|-b|--body-file|-F|--base|-B)(=|$)/

// `gh pr create` o un `gh pr edit` que toca body o base (lo que valida
// pr-metadata). `objetivo` es el numero/URL/rama que se le paso a edit.
export function cambioDePR(comando, cwd, shell = 'bash') {
  const carpetas = carpetasDesde(cwd)
  for (const segmento of segmentos(comando, shell)) {
    const p = palabras(segmento, shell)
    if (!p.length) continue
    if (ES_CD.test(p[0]) || ES_PUSHD.test(p[0]) || ES_POPD.test(p[0])) {
      aplicaCd(carpetas, p, segmento)
      continue
    }
    if (!ES_GH.test(p[0]) || p[1] !== 'pr') continue
    const args = p.slice(3)
    if (p[2] === 'create') {
      if (args.some((a) => a === '--web' || a === '-w' || a === '--dry-run')) continue
      return { accion: 'create', dir: carpetas.actual, objetivo: null }
    }
    if (p[2] === 'edit' && args.some((a) => FLAGS_DE_METADATA.test(a))) {
      const objetivo = args[0] && !args[0].startsWith('-') ? args[0] : null
      return { accion: 'edit', dir: carpetas.actual, objetivo }
    }
  }
  return null
}

// Las URLs de PR en la salida de la tool. La forma de tool_response no esta
// documentada, asi que se busca en todo su JSON; host, owner y repo van
// acotados para que dos URLs seguidas no se lean como una sola.
export function urlsDelPR(texto) {
  return String(texto ?? '').match(/https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? []
}

export function urlDelPR(texto) {
  const todas = urlsDelPR(texto)
  return todas.length ? todas.at(-1) : null
}

// --- Checks ------------------------------------------------------------------

function correrReal(cmd, args, { cwd, timeout = 30_000, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: ENTORNO, encoding: 'utf8', timeout, input, windowsHide: true })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

function primeraLinea(r) {
  if (r.error?.code === 'ENOENT') return `no se encontro "${r.error.path ?? 'el comando'}" en el PATH`
  if (r.error?.code === 'ETIMEDOUT') return 'se agoto el tiempo de espera'
  return (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().split('\n')[0]
}

// El error real de un ensayo fallido: con --verbose git imprime antes
// "Pushing to <url>", que no explica nada.
function motivoDelEnsayo(r) {
  if (r.error) return primeraLinea(r)
  const lineas = `${r.stderr}\n${r.stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(Pushing to |Done$|To |Everything up-to-date)/.test(l))
  return lineas.find((l) => /^(fatal|error):/.test(l)) ?? lineas[0] ?? `exit ${r.status}`
}

function raizDelRepo(dir, correr) {
  const r = correr('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim() : null
}

function rutaDelScript(raiz) {
  return path.join(raiz, 'scripts', 'check-pr-rules.mjs')
}

// El script que se EJECUTA es siempre el del proyecto al que pertenece este
// hook (.claude/hooks/ -> la raiz), nunca el del repo destino del comando: un
// PreToolUse corre antes del prompt de permisos, y `cd <repo ajeno> && git push`
// no puede servir para ejecutar un check-pr-rules.mjs de terceros. El del repo
// destino solo se mira (existencia) para decidir si le corresponde el check.
const SCRIPT_CONFIABLE = rutaDelScript(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))

// El repo donde corre el comando: { raiz } si le corresponde el check (tiene
// el script del harness), { ajeno: true } si es un repo git de otro proyecto,
// o { motivo } si el hook no puede saberlo (carpeta irresoluble, inexistente,
// que no es un repo): eso nunca es "adelante".
function repoConReglas({ dir, dirIrresoluble }, correr) {
  if (dirIrresoluble) return { motivo: dirIrresoluble }
  if (!dir || !fs.existsSync(dir)) return { motivo: `la carpeta ${dir ?? '(desconocida)'} no existe` }
  const raiz = raizDelRepo(dir, correr)
  if (!raiz) return { motivo: `${dir} no es un repositorio git` }
  if (!fs.existsSync(rutaDelScript(raiz))) return { ajeno: true }
  if (!fs.existsSync(SCRIPT_CONFIABLE)) return { motivo: 'no encuentro el script de checks del proyecto de este hook' }
  return { raiz }
}

function denegar(lineas) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: lineas.join('\n'),
    },
  }
}

// "No pude verificarlo" nunca es "adelante": el usuario decide con el motivo a
// la vista. Es la unica salida distinta de deny/null del PreToolUse.
function pedirConfirmacion(lineas) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: lineas.join('\n'),
    },
  }
}

const FORMA_SIMPLE = 'Si es un push, escribelo solo y en su forma simple, en un comando aparte: `git push -u origin <rama>`.'

// Nombre de rama remota al que apunta un destino de refspec, o null si no es
// una rama (un tag, una ref arbitraria, HEAD detached). git resuelve
// `heads/x` como refs/heads/x (DWIM); `tags/x` y `remotes/x` no son ramas.
export function ramaDeDestino(destino, { ramaActual = null } = {}) {
  let nombre = destino === 'HEAD' ? ramaActual : destino
  if (!nombre) return null
  if (nombre.startsWith('refs/')) {
    if (!nombre.startsWith('refs/heads/')) return null
    return nombre.slice('refs/heads/'.length)
  }
  if (nombre.startsWith('heads/')) return nombre.slice('heads/'.length)
  if (nombre.startsWith('tags/') || nombre.startsWith('remotes/')) return null
  return nombre
}

function ramaActualDe(raiz, correr) {
  const r = correr('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: raiz, timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim() || null : null
}

// Lo que git haria de verdad con ese push, segun git y no segun el texto:
// `git push --dry-run --porcelain` imprime una linea por ref con el destino ya
// resuelto (DWIM, push.default, upstream, remote.<r>.push). --no-verify evita
// que un pre-push del usuario corra durante el ensayo.
export function parsePorcelain(salida) {
  let url = null
  const destinos = []
  for (const linea of String(salida ?? '').split('\n')) {
    if (linea.startsWith('To ')) {
      url = linea.slice(3).trim()
      continue
    }
    const m = linea.match(/^[ +\-*!=]\t([^\t]*)\t/)
    if (!m) continue
    const refspec = m[1]
    const destino = refspec.includes(':') ? refspec.split(':')[1] : refspec
    if (destino) destinos.push(destino)
  }
  return { url, destinos }
}

// -q/--quiet dejarian el porcelain vacio y el hook no sabria a donde fue el
// push: se quitan del ensayo (tambien dentro de un grupo corto, -uq -> -u).
export function argsDelEnsayo(args) {
  return args
    .filter((a) => a !== '-q' && a !== '--quiet')
    .map((a) => (/^-[^-]+$/.test(a) ? a.replace(/q/g, '') : a))
    .filter((a) => a !== '-')
}

// --verbose: asi git tambien lista las refs que ya estan al dia (=), y un push
// sin nada que subir deja igual constancia de a donde habria ido.
export function destinosSegunGit({ dir, args, correr }) {
  const r = correr('git', ['push', '--dry-run', '--porcelain', '--no-verify', '--verbose', ...argsDelEnsayo(args)], { cwd: dir, timeout: 25_000 })
  if (r.status !== 0) return { ok: false, motivo: motivoDelEnsayo(r) }
  const { url, destinos } = parsePorcelain(r.stdout)
  if (!url && !destinos.length) return { ok: false, motivo: 'git no informo ningun destino en el ensayo' }
  return { ok: true, url, destinos }
}

// Las dos URLs salen de la misma configuracion de git, asi que alcanza con
// normalizar lo cosmetico (.git final, barras, mayusculas).
export function mismaUrl(a, b) {
  const n = (u) => String(u ?? '').trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
  return n(a) !== '' && n(a) === n(b)
}

// Mismo repositorio aunque cambie el protocolo (https para fetch, ssh para
// push): host/owner/repo iguales.
export function mismoRepo(a, b) {
  if (mismaUrl(a, b)) return true
  const ra = repoDeUrl(a)
  return ra != null && ra === repoDeUrl(b)
}

const PROTEGIDA = (nombre) => nombre && RAMAS_PROTEGIDAS.includes(nombre)

export function prePush({ push, raiz, sinRaiz = null, correr, presupuestoMs = PRESUPUESTO_MS }) {
  const inicio = Date.now()
  const restante = () => presupuestoMs - (Date.now() - inicio)
  // Toda llamada respeta el presupuesto: agotado, devuelve un fallo que termina
  // en "ask", antes de que la plataforma cancele el hook sin bloquear nada.
  const correrP = (cmd, args, o = {}) => {
    const r = restante()
    if (r < 1000) return { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }
    return correr(cmd, args, { ...o, timeout: Math.min(o.timeout ?? 30_000, r) })
  }

  if (push.masivo) {
    return denegar([
      'reglas-pr: `git push --all`, `--branches`, `--mirror` y el refspec `:` (matching) pueden subir `main` y ramas que nadie reviso.',
      'Pushea solo tu rama: `git push -u origin <tu-rama>`. No intentes rodear este hook.',
    ])
  }
  if (push.forzado) {
    return denegar([
      'reglas-pr: `git push --force`, `-f` (tambien agrupado: -uf, -4f) y los refspecs con `+` estan prohibidos: reescriben historia compartida.',
      'Si de verdad necesitas reescribir TU rama (nunca dev ni main), explicaselo al usuario y que el decida',
      'un `git push --force-with-lease` sobre esa rama. No intentes rodear este hook.',
    ])
  }
  if (push.remoto && push.remoto !== REMOTO_PERMITIDO) {
    return denegar([
      `reglas-pr: el push iria al remoto \`${push.remoto}\`; desde la sesion solo se pushea a \`${REMOTO_PERMITIDO}\`.`,
      'Si de verdad hace falta pushear a otro remoto o a una URL, lo hace el usuario a mano. No intentes rodear este hook.',
    ])
  }

  const ramaActual = raiz && push.destinos.includes('HEAD') ? ramaActualDe(raiz, correrP) : null
  const protegidas = [
    ...new Set([...push.destinos.map((d) => ramaDeDestino(d, { ramaActual })), ...push.borrados.map((d) => ramaDeDestino(d))].filter(PROTEGIDA)),
  ]
  if (protegidas.length) {
    return denegar([
      `reglas-pr: el push tocaria ${protegidas.map((n) => `\`${n}\``).join(' y ')}, y ${protegidas.length > 1 ? 'esas ramas' : 'esa rama'} solo recibe merges por Pull Request.`,
      'Ningun push directo a main: las ramas de trabajo van a `dev` por PR y el release es un PR `dev` -> `main`.',
      'Si estas parado en main, vuelve a tu rama (`git switch <tu-rama>`) y pushea esa. No intentes rodear este hook.',
    ])
  }

  // Sin repo resuelto no hay rama actual, ni escaneo, ni ensayo: lo que no es
  // un deny estatico se pregunta.
  if (!raiz) {
    return pedirConfirmacion([
      `reglas-pr: no pude determinar en que repositorio corre este push (${sinRaiz ?? 'carpeta desconocida'}), asi que no lo verifique.`,
      'Confirma solo si sabes que no va a main ni a otro remoto y que no sube credenciales ni datos de la organizacion.',
      'Si es este repo, pushea desde su carpeta con una ruta literal: `cd <ruta del repo> && git push -u origin <rama>`, o mejor en dos comandos.',
    ])
  }

  // Secretos y datos sensibles en lo que subiria. Con metacaracteres el refspec
  // no es confiable: el escaneo queda para despues de la confirmacion del usuario.
  let autorizacionesNuevas = false
  if (push.cabezas.length && !push.metacaracteres) {
    for (const cabeza of push.cabezas) {
      const args = [SCRIPT_CONFIABLE, '--grupo', 'secretos', '--sin-pushear']
      // Con "=": una ref que empiece con "-" no puede leerse como otra opcion.
      if (cabeza !== 'HEAD') args.push(`--cabeza=${cabeza}`)
      const r = correrP(process.execPath, args, { cwd: raiz, timeout: 45_000 })
      const lineas = (r.stdout ?? '').split('\n')
      const fails = lineas.filter((l) => l.startsWith('[FAIL]'))
      if (r.status === 1 && fails.length) {
        return denegar([
          'reglas-pr: el push subiria credenciales o datos sensibles de la organizacion.',
          ...fails,
          'No pushees. Si estan solo en commits que todavia no se pushearon, sacalos de ahi: `git reset --soft <upstream',
          'de la rama, u origin/dev si nunca se pusheo>`, quita el archivo (`git rm --cached <archivo>`) o el contenido,',
          'sumalo a .gitignore si corresponde y vuelve a commitear. Si alguno ya se habia pusheado antes, la credencial',
          'quedo expuesta: avisa al usuario para que la rote; si son datos de personas, para que decida como tratar la',
          'filtracion. Si crees que es un falso positivo (un fixture sintetico, un ejemplo de la documentacion), no lo',
          'decidas tu: avisa al usuario. El registra la ruta en .datos-autorizados (vale cuando ya esta en dev) o marca',
          'la linea con `coe:no-secreto`, y ese push lo hace el. No intentes rodear este hook.',
        ])
      }
      if (r.status !== 0) {
        return pedirConfirmacion([
          `reglas-pr: no se pudo validar secretos antes del push (${primeraLinea(r)}), asi que este push NO esta verificado.`,
          'Confirma solo si sabes que estos commits no llevan credenciales ni datos de la organizacion; si no, para y avisa al usuario.',
        ])
      }
      if (lineas.some((l) => l.startsWith('[skip] excepciones-nuevas:') && l.includes('.datos-autorizados'))) autorizacionesNuevas = true
    }
  }

  // Lo que el texto no resuelve: el shell, `git -c`, el entorno, las opciones
  // desconocidas y lo que corre antes del push en el mismo comando. Mejor una
  // pregunta que un push a ciegas.
  const dudas = []
  if (push.metacaracteres) dudas.push('tiene caracteres que expande el shell ($, `, {}, comodines) y el hook no puede saber a que ref apuntan')
  if (push.envoltorio.length) dudas.push(`git va envuelto en \`${push.envoltorio.join(' ')}\`, y el hook no puede saber que ejecuta de verdad`)
  if (push.alias) dudas.push(`usa un alias de git (${push.alias}) en vez de \`git push\``)
  if (push.configs.length) dudas.push(`lleva \`-c ${push.configs.join(' ')}\`, que puede cambiar el remoto o el destino`)
  if (push.entorno) dudas.push('lleva variables de entorno delante del comando, que pueden cambiar la configuracion de git')
  if (push.rutaDeGit) dudas.push('usa --git-dir, --work-tree o --namespace, y el hook solo ensaya el repo del directorio actual')
  const previosDestino = push.cambiosPrevios.filter((c) => c.cambia === 'destino').map((c) => `\`${c.segmento}\``)
  const previosContenido = push.cambiosPrevios.filter((c) => c.cambia === 'contenido').map((c) => `\`${c.segmento}\``)
  if (previosDestino.length) dudas.push(`antes del push corre algo que cambia la rama, el remoto, la configuracion, el entorno o define funciones o alias (${previosDestino.join('; ')}) y el hook solo puede ensayar el estado actual`)
  if (previosContenido.length) dudas.push(`antes del push corre algo que cambia los commits (${previosContenido.join('; ')}) y el escaneo de secretos solo vio los que ya existen`)
  if (push.riesgosas.length) dudas.push(`lleva ${push.riesgosas.map((o) => `\`${o}\``).join(', ')}, que el hook no resuelve`)
  if (push.reescritura.length) dudas.push(`lleva ${push.reescritura.map((o) => `\`${o}\``).join(', ')}, que reescribe la historia remota: solo sobre TU rama y con el usuario de acuerdo`)
  if (push.desconocidas.length) dudas.push(`lleva opciones que el hook no reconoce o estan abreviadas (${push.desconocidas.map((o) => `\`${o}\``).join(', ')}) y no las ensaya`)
  if (dudas.length) {
    return pedirConfirmacion([
      `reglas-pr: no puedo asegurar a donde va este push ni que lleva: ${dudas.join('; ')}.`,
      'Confirma solo si sabes que NO va a main ni a otro remoto y que no sube credenciales ni datos de la organizacion; si no,',
      'reescribe el comando en su forma simple y en un paso aparte (primero el commit o el cambio de rama, despues `git push -u origin <rama>` solo).',
    ])
  }

  // La palabra final la tiene git: ensayo del push con los mismos argumentos.
  const real = destinosSegunGit({ dir: raiz, args: push.args, correr: correrP })
  if (!real.ok) {
    return pedirConfirmacion([
      `reglas-pr: git no pudo ensayar el push (${real.motivo}), asi que el destino no esta verificado.`,
      'Confirma solo si sabes que no va a main; si el error es del comando (sin upstream, sin red, remoto inexistente), el push real va a fallar igual.',
    ])
  }
  const destinosReales = real.destinos.map((d) => ramaDeDestino(d))
  const reales = [...new Set(destinosReales.filter(PROTEGIDA))]
  if (reales.length) {
    return denegar([
      `reglas-pr: segun git, este push actualizaria ${reales.map((n) => `\`${n}\``).join(' y ')} (por la configuracion de push o el upstream de la rama), y esa rama solo recibe merges por Pull Request.`,
      'Pushea tu rama con nombre explicito: `git push -u origin <tu-rama>`. No intentes rodear este hook.',
    ])
  }
  // A donde iria de verdad: la URL del ensayo tiene que ser la del repo de
  // origin (la de fetch; un pushurl o un url.*.pushInsteadOf la cambiarian).
  const origen = correrP('git', ['remote', 'get-url', REMOTO_PERMITIDO], { cwd: raiz, timeout: 10_000 })
  if (origen.status !== 0 || !mismoRepo(origen.stdout, real.url)) {
    return denegar([
      `reglas-pr: segun git, este push iria a ${real.url ?? 'un remoto que no pude determinar'}, que no es el repositorio de \`${REMOTO_PERMITIDO}\`${origen.status === 0 ? ` (${origen.stdout.trim()})` : ''}: hay un pushurl o un pushInsteadOf configurado, o el remoto no existe.`,
      `Desde la sesion solo se pushea a \`${REMOTO_PERMITIDO}\`. Si la configuracion es legitima, que la revise el usuario (\`git remote -v\`, \`git config --get-regexp 'pushurl|pushinsteadof'\`).`,
    ])
  }
  // Una autorizacion nueva en .datos-autorizados entra a dev por PR (la
  // registra el usuario, la ve el revisor), nunca por push directo: si no, un
  // push a dev con la excepcion y otro con los datos burlan el control.
  const aIntegracion = [...destinosReales, ...push.destinos.map((d) => ramaDeDestino(d, { ramaActual }))].includes(RAMA_INTEGRACION)
  if (autorizacionesNuevas && aIntegracion) {
    return denegar([
      `reglas-pr: este push lleva lineas nuevas en .datos-autorizados directo a \`${RAMA_INTEGRACION}\`.`,
      'Una autorizacion de datos de la organizacion la registra el usuario y entra por Pull Request, donde el revisor la ve (regla excepciones-nuevas);',
      'por push directo no. Pushea la rama de trabajo y abre el PR, o que el usuario lo haga a mano. No intentes rodear este hook.',
    ])
  }
  return null
}

function estadoDe(r) {
  if (r.status === 0) return 'OK'
  if (r.status === 1) return 'FAIL'
  return 'ERROR (no se pudo verificar)'
}

export function comentario({ sha, resultados }) {
  let salida = resultados.map((r) => `== ${r.grupo}\n${r.salida}`).join('\n\n')
  if (salida.length > LIMITE_SALIDA) salida = `${salida.slice(0, LIMITE_SALIDA)}\n... (recortado)`
  return [
    MARCA,
    '### Reglas de PR — corridas en la sesión del agente',
    '',
    `Los checks de \`scripts/check-pr-rules.mjs\` los corrió el hook \`reglas-pr\` de Claude Code sobre \`${sha ? sha.slice(0, 7) : '?'}\` (los mismos corren en CI con \`reglas-pr.yml\`).`,
    '',
    '| Grupo | Resultado |',
    '|---|---|',
    ...resultados.map((r) => `| ${r.grupo}${r.bloqueante ? '' : ' (informativo)'} | ${estadoDe(r)} |`),
    '',
    '<details><summary>Salida de <code>scripts/check-pr-rules.mjs</code></summary>',
    '',
    '````text',
    salida,
    '````',
    '',
    '</details>',
  ].join('\n')
}

// Lo que vuelve al agente: corto, solo lo que no dio OK, y que hacer.
export function textoParaElAgente({ url, sha, resultados, errorComentario }) {
  const lineas = [`reglas-pr · PR ${url}${sha ? ` · cabeza ${sha.slice(0, 7)}` : ''}`]
  for (const r of resultados) lineas.push(`- ${r.grupo}${r.bloqueante ? '' : ' (informativo)'}: ${estadoDe(r)}`)
  const avisos = resultados.flatMap((r) =>
    r.salida
      .split('\n')
      .filter((l) => /^\[(FAIL|skip|ERROR)/.test(l))
      .map((l) => `  ${r.grupo} ${l}`),
  )
  if (avisos.length) {
    lineas.push('Detalle:', ...avisos.slice(0, MAX_AVISOS))
    if (avisos.length > MAX_AVISOS) lineas.push(`  ... y ${avisos.length - MAX_AVISOS} mas en el comentario del PR`)
  }
  lineas.push(
    errorComentario
      ? `No se pudo publicar el comentario en el PR (${errorComentario}): avisale al usuario.`
      : 'Resultado publicado como comentario en el PR.',
  )

  const fallaBloqueante = resultados.some((r) => r.bloqueante && r.status === 1)
  const sinVerificar = resultados.some((r) => r.status !== 0 && r.status !== 1)
  if (fallaBloqueante) {
    lineas.push(
      'Hay FAIL en un grupo bloqueante: corrigelo ahora, el PR no esta listo hasta que no quede ninguno.',
      `- Body (secciones vacias, security review o datos sensibles sin declarar, version): \`gh pr edit ${url} --body-file <archivo>\` (vuelve a disparar este check). Completa la plantilla de verdad: no marques casillas por rellenar.`,
      `- Base: \`gh pr edit ${url} --base dev\`.`,
      `- Conflictos: \`git fetch origin && git merge origin/dev\`, push, y despues \`node .claude/hooks/reglas-pr.mjs --pr ${url}\`.`,
      '- Secreto o dato sensible: sacalo en un commit nuevo (`git rm --cached` o edita el contenido) y avisa al usuario: ya se pusheo, hay que rotar la credencial o tratar la filtracion. Un falso positivo lo resuelve el usuario (.datos-autorizados o `coe:no-secreto`), no tu.',
      'Si el FAIL no se arregla desde el body o la base, o sigue tras dos rondas, para y reportalo al usuario.',
    )
  }
  if (sinVerificar) {
    lineas.push(
      `Algun grupo no se pudo verificar (ERROR): cuando se resuelva, corre \`node .claude/hooks/reglas-pr.mjs --pr ${url}\`; si no se resuelve, avisale al usuario que el PR quedo sin validar.`,
    )
  }
  if (!fallaBloqueante && !sinVerificar) lineas.push('Los grupos bloqueantes pasaron. rama-commits es informativo: no reescribas commits ya pusheados.')
  return { estado: fallaBloqueante ? 'fail' : sinVerificar ? 'error' : 'ok', texto: lineas.join('\n') }
}

export function postPR({ objetivo, raiz, correr }) {
  const vista = correr('gh', ['pr', 'view', ...(objetivo ? [objetivo] : []), '--json', 'url,headRefOid'], { cwd: raiz, timeout: 20_000 })
  let pr = null
  try {
    if (vista.status === 0) pr = JSON.parse(vista.stdout)
  } catch {
    pr = null
  }
  if (!pr?.url) {
    const detalle = vista.status === 0 ? 'respuesta inesperada de gh' : primeraLinea(vista)
    return {
      estado: 'error',
      url: objetivo,
      texto: `reglas-pr: no se pudo leer el PR con gh (${detalle}), asi que no se verifico. Cuando se resuelva, corre \`node .claude/hooks/reglas-pr.mjs --pr <url del PR>\`; si no, avisale al usuario que el PR quedo sin validar.`,
    }
  }

  // Para que la cabeza del PR (headRefOid) exista en local. Si falla (sin red),
  // el script reporta skip en lo que la necesita.
  correr('git', ['fetch', 'origin', '--quiet'], { cwd: raiz, timeout: 30_000 })

  const resultados = GRUPOS.map(({ grupo, bloqueante }) => {
    const r = correr(process.execPath, [SCRIPT_CONFIABLE, '--grupo', grupo, '--pr', pr.url], { cwd: raiz, timeout: 60_000 })
    const salida = (r.stdout ?? '').trim() || `[ERROR] ${primeraLinea(r)}`
    return { grupo, bloqueante, status: r.status === 0 || r.status === 1 ? r.status : 2, salida }
  })

  const publicado = correr('gh', ['pr', 'comment', pr.url, '--body-file', '-'], {
    cwd: raiz,
    timeout: 20_000,
    input: comentario({ sha: pr.headRefOid, resultados }),
  })
  const { estado, texto } = textoParaElAgente({
    url: pr.url,
    sha: pr.headRefOid,
    resultados,
    errorComentario: publicado.status === 0 ? null : primeraLinea(publicado),
  })
  return { estado, url: pr.url, texto }
}

// El hook solo verifica y comenta PRs del repo propio (el de origin), nunca
// cualquier PR donde el token de gh pueda escribir. Se compara host y
// owner/repo: "host/owner/repo" en minusculas, para las formas https, ssh:// y
// git@host:owner/repo de la URL de origin.
export function repoDeUrl(url) {
  const m = String(url ?? '')
    .trim()
    .match(/^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([\w.-]+)(?::\d+)?[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

function repoDelOrigen(raiz, correr) {
  const r = correr('git', ['remote', 'get-url', 'origin'], { cwd: raiz, timeout: 10_000 })
  return r.status === 0 ? repoDeUrl(r.stdout) : null
}

export function prDeEsteRepo(objetivo, repoOrigen) {
  const m = String(objetivo ?? '').match(/^https:\/\/([\w.-]+)\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/)
  if (!m) return !/^https?:/.test(String(objetivo ?? '')) // numero o rama: gh lo resuelve en este repo
  return repoOrigen != null && `${m[1]}/${m[2]}`.toLowerCase() === repoOrigen
}

export function salidaPostToolUse({ estado, texto, url }) {
  const hookSpecificOutput = { hookEventName: 'PostToolUse', additionalContext: texto }
  if (estado !== 'fail') return { hookSpecificOutput }
  // block + reason no esta confirmado en la doc de PostToolUse; el detalle
  // completo va igual en additionalContext, que si lo esta.
  return {
    decision: 'block',
    reason: `reglas-pr: FAIL bloqueante en el PR ${url}. El detalle y como corregirlo van en el contexto adicional.`,
    hookSpecificOutput,
  }
}

// --- Subcomandos nativos y alias de git ------------------------------------

// Si git no dice cuales son sus subcomandos nativos (git viejo, sin git), vale
// esta lista: lo importante es que un alias nunca pueda sombrear un nativo
// (git no lo permite), asi que solo los no nativos pueden ser alias.
const NATIVOS_DE_RESPALDO = [
  'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-ignore', 'checkout',
  'cherry-pick', 'clean', 'clone', 'commit', 'config', 'describe', 'diff', 'difftool', 'fetch', 'for-each-ref',
  'format-patch', 'fsck', 'gc', 'grep', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge',
  'merge-base', 'mergetool', 'mv', 'notes', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote', 'repack',
  'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref', 'sparse-checkout',
  'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'version', 'worktree',
]
let nativos = null

function esNativo(sub, correr) {
  if (!nativos) {
    const r = correr('git', ['--list-cmds=builtins'], { timeout: 10_000 })
    const lista = r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
    nativos = new Set(lista.length ? [...lista, 'help', 'version'] : NATIVOS_DE_RESPALDO)
  }
  return nativos.has(sub)
}

// El valor de un alias de git, o null si no existe.
function aliasDe(sub, dir, correr) {
  if (!/^[\w.-]+$/.test(sub)) return null
  const r = correr('git', ['config', '--get', `alias.${sub}`], { cwd: dir ?? undefined, timeout: 10_000 })
  const valor = r.status === 0 ? r.stdout.trim() : ''
  return valor || null
}

// Un segmento previo al push que invoca git con un alias (`git co main`, con
// `alias.co = checkout`) cambia el estado tanto como el comando al que
// apunta; `queCambia` no puede resolverlo sin git, asi que se resuelve aqui.
function cambiosPorAlias(previos, shell, dir, correr) {
  const salida = []
  for (const segmento of previos) {
    const q = palabras(segmento, shell)
    if (!q.length) continue
    const k = indiceDeGit(q)
    if (k === -1) continue
    const g = globalesDeGit(q, k + 1, carpetasDesde(null))
    const sub = q[g.i]
    if (sub == null || NO_LITERAL.test(sub) || sub === 'push' || CAMBIA_DESTINO.test(sub) || CAMBIA_CONTENIDO.test(sub) || esNativo(sub, correr)) continue
    const alias = aliasDe(sub, dir, correr)
    if (alias == null) continue
    const primera = palabras(alias)[0] ?? ''
    const cambia = alias.startsWith('!') || CAMBIA_DESTINO.test(primera) ? 'destino' : CAMBIA_CONTENIDO.test(primera) ? 'contenido' : null
    if (cambia) salida.push({ segmento: `${recorte(segmento)} (alias \`${sub}\` = \`${recorte(alias)}\`)`, cambia })
  }
  return salida
}

// Los push del comando, incluidos los que llegan por alias (`git p origin`,
// con `alias.p = push`), y los motivos para preguntar que no son un push
// analizable: alias que pueden pushear, subcomandos no literales, `git push`
// dentro de cadenas o scripts, git nativo con configuracion por entorno.
function pushesYSospechas(comando, cwd, shell, correr) {
  const { invocaciones, sospechas } = invocacionesDeGit(comando, cwd, shell)
  const pushes = []
  const motivos = [...sospechas]
  const conAliasPrevios = (inv) => {
    const push = analizaPush(inv)
    push.cambiosPrevios = [...push.cambiosPrevios, ...cambiosPorAlias(inv.previos ?? [], shell, inv.dir, correr)]
    return push
  }
  for (const inv of invocaciones) {
    if (inv.sub === 'push') {
      pushes.push(conAliasPrevios(inv))
      continue
    }
    if (inv.sub == null || !inv.subLiteral || esNativo(inv.sub, correr)) continue
    if (inv.entorno) {
      motivos.push(`\`${recorte(inv.segmento)}\`: variables de entorno delante de un subcomando de git que no es nativo (\`${inv.sub}\`)`)
      continue
    }
    const alias = inv.dirIrresoluble ? null : aliasDe(inv.sub, inv.dir, correr)
    if (alias == null) continue
    const partes = palabras(alias)
    if (partes[0] === 'push') {
      pushes.push(conAliasPrevios({ ...inv, args: [...partes.slice(1), ...inv.args], alias: `\`${inv.sub}\` = \`${recorte(alias)}\`` }))
    } else if (/push/i.test(alias)) {
      motivos.push(`\`git ${inv.sub}\` es un alias de git (\`${recorte(alias)}\`) que puede hacer push`)
    }
  }
  return { pushes, motivos }
}

// Punto de entrada del hook: decide que hacer con la entrada de Claude Code.
export function procesar(entrada, correr = correrReal) {
  const comando = entrada?.tool_input?.command
  if (typeof comando !== 'string') return null
  const cwd = entrada.cwd || process.cwd()
  const shell = /powershell/i.test(entrada.tool_name ?? '') ? 'powershell' : 'bash'

  if (entrada.hook_event_name === 'PreToolUse') {
    const { pushes, motivos } = pushesYSospechas(comando, cwd, shell, correr)
    // Todos los push del comando comparten el presupuesto: un deny gana a un
    // ask, y un ask a dejar pasar.
    const fin = Date.now() + PRESUPUESTO_MS
    let confirmacion = null
    for (const push of pushes) {
      const repo = repoConReglas(push, correr)
      if (repo.ajeno) continue
      const salida = prePush({ push, raiz: repo.raiz ?? null, sinRaiz: repo.motivo ?? null, correr, presupuestoMs: fin - Date.now() })
      if (!salida) continue
      if (salida.hookSpecificOutput.permissionDecision === 'deny') return salida
      confirmacion ??= salida
    }
    if (!confirmacion && motivos.length) {
      confirmacion = pedirConfirmacion([
        `reglas-pr: no puedo analizar este comando con certeza: ${motivos.join('; ')}.`,
        `${FORMA_SIMPLE} Confirma solo si sabes que no va a main ni a otro remoto y que no sube credenciales ni datos de la organizacion.`,
      ])
    }
    return confirmacion
  }
  if (entrada.hook_event_name === 'PostToolUse') {
    const cambio = cambioDePR(comando, cwd, shell)
    const repo = cambio && repoConReglas({ dir: cambio.dir, dirIrresoluble: cambio.dir ? null : 'carpeta desconocida' }, correr)
    const raiz = repo?.raiz
    if (!raiz) return null
    // De las URLs de la salida, la primera que sea de este repo; una URL ajena
    // (aunque venga ultima) no decide nada.
    const repoOrigen = repoDelOrigen(raiz, correr)
    const urls = urlsDelPR(JSON.stringify(entrada.tool_response ?? entrada.tool_result ?? ''))
    const propia = urls.find((u) => prDeEsteRepo(u, repoOrigen))
    const objetivo = propia ?? (urls.length ? null : cambio.objetivo)
    if (!objetivo || !prDeEsteRepo(objetivo, repoOrigen)) {
      return { systemMessage: `reglas-pr: ${urls.join(', ') || cambio.objetivo} no es un PR de este repo (origin); no se verifico ni se comento.` }
    }
    return salidaPostToolUse(postPR({ objetivo, raiz, correr }))
  }
  return null
}

function leerEntrada() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function main() {
  const indicePr = process.argv.indexOf('--pr')
  if (indicePr !== -1) {
    // Modo manual: node .claude/hooks/reglas-pr.mjs --pr <url>
    const repo = repoConReglas({ dir: process.cwd() }, correrReal)
    if (!repo.raiz) {
      console.log('reglas-pr: este repo no tiene scripts/check-pr-rules.mjs del harness.')
      process.exit(2)
    }
    const objetivo = process.argv[indicePr + 1] ?? null
    if (!prDeEsteRepo(objetivo, repoDelOrigen(repo.raiz, correrReal))) {
      console.log(`reglas-pr: ${objetivo} no es un PR de este repo (origin); no se corre ni se comenta.`)
      process.exit(2)
    }
    const { estado, texto } = postPR({ objetivo, raiz: repo.raiz, correr: correrReal })
    console.log(texto)
    process.exit(estado === 'ok' ? 0 : estado === 'fail' ? 1 : 2)
  }
  if (process.stdin.isTTY) {
    console.log('Uso: lo invoca Claude Code (JSON por stdin), o a mano: node .claude/hooks/reglas-pr.mjs --pr <url>')
    process.exit(0)
  }
  let salida = null
  try {
    salida = procesar(leerEntrada())
  } catch (e) {
    // Un error interno tampoco es "adelante": se pide confirmacion con el motivo.
    salida = pedirConfirmacion([
      `reglas-pr: error interno del hook (${String(e?.message ?? e).split('\n')[0]}); no se verifico nada.`,
      'Confirma solo si sabes lo que hace este comando; si no, para y avisa al usuario.',
    ])
  }
  if (salida) process.stdout.write(JSON.stringify(salida))
  process.exit(0)
}

// Solo como ejecutable: al importarse desde los tests no corre nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

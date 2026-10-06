#!/usr/bin/env node
// Verifica las reglas deterministas de PR de la skill coe-github
// (.claude/skills/coe-github/SKILL.md), agrupadas en tres --grupo: un fallo de
// formato de commit no debe verse igual de grave que un secreto filtrado.
//
//   rama-commits  -> rama-formato, commits-formato                  (informativo)
//   secretos      -> sin-secretos (archivos de credenciales),
//                    sin-secretos-en-contenido (llaves, tokens,
//                    contrasenas en el diff),
//                    sin-datos-sensibles (nominas, documentos de
//                    identidad, tarjetas, listados de personas)     (bloqueante)
//   pr-metadata   -> pr-apunta-a-dev, rama-al-dia-sin-conflictos,
//                    version-semver, sin-secciones-vacias,
//                    security-review-declarado,
//                    datos-sensibles-declarados                     (bloqueante)
//
// Los corre el hook de Claude Code reglas-pr (.claude/hooks/reglas-pr.mjs) en la
// sesion del agente -- antes de cada git push y al crear o editar el PR -- y el
// workflow .github/workflows/reglas-pr.yml en CI. "Bloqueante" = el hook deniega
// el push o le devuelve el FAIL al agente, y CI falla el check requerido.
//
// Uso:
//   node scripts/check-pr-rules.mjs --grupo rama-commits [--pr <n|url>]
//   node scripts/check-pr-rules.mjs --grupo secretos [--pr <n|url>]
//   node scripts/check-pr-rules.mjs --grupo secretos --sin-pushear [--cabeza=<ref>]
//     (<ref> es una rama, un tag, o --branches / --tags para push --all/--tags)
//   node scripts/check-pr-rules.mjs --grupo pr-metadata --pr <n|url>
//
// Con --pr, base, rama y cabeza salen del PR (gh pr view): el check mira lo que
// ve GitHub, no el checkout local; corre antes `git fetch origin` para que la
// cabeza del PR exista en local. --sin-pushear revisa cada commit que un push
// subiria (los que no estan en ningun origin/*), no solo el arbol final.
//
// Falsos positivos: una linea con el marcador `coe:no-secreto` queda fuera del
// escaneo de secretos; una ruta listada en .datos-autorizados queda fuera del
// check de datos sensibles. Los dos los decide el usuario, nunca el agente.
//
// Exit 0: sin FAIL. Exit 1: alguna regla dio FAIL. Exit 2: no se pudo verificar
// (gh o git fallaron, o el uso es incorrecto) y se imprime una linea [ERROR].
// Las reglas en skip (no medibles en este contexto) se reportan pero no fallan.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

// --- Ramas y commits ----------------------------------------------------------

// tipo/descripcion-corta, con un ID de tracker opcional en mayusculas como
// prefijo del slug (feature/ABC-123-captura-lead). El slug admite puntos: un
// bump de version como chore/bump-1.2.0 es un slug legitimo.
const RAMA_REGEX = /^(feature|fix|hotfix|docs|chore|refactor|experiment)\/(?:[A-Z][A-Z0-9]{1,9}-\d+-)?[a-z0-9.-]+$/
const RAMA_LISTA_NEGRA = ['cambios', 'prueba', 'final', 'final-final', 'arreglo']
const COMMIT_TIPOS = ['feat', 'fix', 'docs', 'chore', 'refactor', 'test', 'style', 'build', 'ci', 'perf', 'revert']
// La descripcion puede arrancar en mayuscula (una sigla: PR, API, CI) y admite
// tildes y enie en el primer caracter. "revert" admite mayuscula inicial
// (Revert: ...), imitando el "Revert" que genera git.
const TIPOS_REGEX = COMMIT_TIPOS.map((t) => (t === 'revert' ? '[Rr]evert' : t)).join('|')
const COMMIT_REGEX = new RegExp(`^(${TIPOS_REGEX}): [a-zA-ZÁÉÍÓÚÜÑáéíóúüñ].*[^.]$`)
const COMMIT_MENSAJES_PROHIBIDOS = ['update', 'fix', 'cosas', 'ya', 'ahora si', 'ahora sí']

// --- Secretos: archivos ---------------------------------------------------------

// .env.example (y sus variantes sample/template/dist) es la plantilla sin
// valores que la skill pide commitear y que el harness siembra: no es un
// secreto. Cualquier otro .env.* si lo es (.env.local, .env.staging...).
const SECRETO_ARCHIVOS = [
  /(^|\/)\.env(?!\.(?:example|sample|template|dist)$)(\..+)?$/,
  /\.(pem|key|pfx|p12|jks|keystore|ppk|ovpn)$/i,
  /(^|\/)(credentials|secrets?|client_secret[^/]*|service[-_]?account[^/]*)\.json$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.(pypirc|netrc|htpasswd|pgpass|git-credentials)$/,
  /(^|\/)\.my\.cnf$/,
  /(^|\/)kubeconfig$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.docker\/config\.json$/,
  /\.tfstate(\.backup)?$/,
  /(^|\/)local\.settings\.json$/,
]

// --- Secretos: contenido ----------------------------------------------------------

// Formatos inequivocos (se reportan siempre) y asignaciones genericas (se
// reportan solo si el valor parece un secreto real y no un placeholder).
// `valor`: indice del grupo de captura que hay que validar con pareceSecreto;
// sin `valor`, el patron alcanza por si solo. `contexto`: regex que ademas
// tiene que aparecer en la misma linea.
const PATRONES_SECRETO = [
  { id: 'llave-privada', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'aws-secret-access-key', re: /aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i, valor: 1 },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{80,})\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-key', re: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{20,}\b/ },
  { id: 'openai-anthropic-key', re: /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,})\b/, valor: 1 },
  { id: 'azure-storage-key', re: /AccountKey=([A-Za-z0-9+/=]{80,})/, valor: 1, requiere: 'AccountKey=' },
  { id: 'sas-token', re: /[?&]sig=[A-Za-z0-9%+/=]{40,}/, requiere: 'sig=' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, requiere: 'eyJ' },
  // `requiere`: un substring barato que tiene que estar en la linea antes de
  // correr la regex. Las que empiezan con una clase repetida ([a-z]+ hasta un
  // literal) son cuadraticas en lineas largas sin ese literal.
  { id: 'url-con-credenciales', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'<>]+:([^\s/@"'<>]{4,})@[^\s"'<>]+/i, valor: 1, requiere: '://' },
  { id: 'connection-string', re: /\b(?:Password|Pwd)\s*=\s*([^;\s"'<>]{4,})/i, valor: 1, contexto: /\b(?:Server|Data Source|Host|Initial Catalog|Database|User(?: ?Id)?|Uid)\s*=/i },
  { id: 'npm-token', re: /_authToken\s*=\s*["']?([A-Za-z0-9._-]{16,})/, valor: 1, requiere: '_authToken' },
  { id: 'bearer-token', re: /\bBearer\s+([A-Za-z0-9._\-+/=]{20,})/, valor: 1, requiere: 'Bearer' },
  // La clave puede llevar prefijo: DB_PASSWORD=, db_password:, MYSQL_ROOT_PASSWORD
  // (limite "no alfanumerico" en vez de \b, que trataba "_" como letra) y
  // camelCase: smtpPassword, dbPassword (variante sensible a mayusculas aparte,
  // porque con /i la transicion minuscula->mayuscula se diluye).
  {
    id: 'asignacion-de-secreto',
    re: /(?<![A-Za-z0-9])(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|secret[_-]?key)\b["']?\s*(?:[:=]|=>)\s*["']?([^\s"',;]{8,})["']?/i,
    valor: 1,
  },
  {
    id: 'asignacion-de-secreto',
    re: /(?<=[a-z])(?:Pass(?:word|wd|phrase)?|Pwd|Secret|Token|Api[_-]?Key|ApiKey|Access[_-]?Key|Private[_-]?Key|Client[_-]?Secret|Auth[_-]?Token|Secret[_-]?Key)\b["']?\s*(?:[:=]|=>)\s*["']?([^\s"',;]{8,})["']?/,
    valor: 1,
  },
]

const PLACEHOLDER = /^(?:<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_]+%|x{3,}|\*{3,}|\.{3,}|_{3,}|-{3,}|#{3,}|changeme|change[-_]?me|your[-_].*|example.*|sample.*|dummy.*|fake.*|placeholder.*|secret[-_]?here|password[-_]?here|redacted|null|none|nil|undefined|true|false|string|number|todo|tbd|n\/a)$/i
const REFERENCIA_A_ENTORNO = /^(?:process\.env|os\.environ|os\.getenv|env\(|ENV\[|System\.getenv|config\.|settings\.|secrets\.|vault|keyvault|getenv|import\.meta\.env|Deno\.env)/i
const PALABRA_DE_EJEMPLO = /(?:example|sample|dummy|fake|placeholder|changeme|xxxx|your[-_])/i
const MARCADOR_NO_SECRETO = 'coe:no-secreto'

function entropia(s) {
  const f = new Map()
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1)
  let h = 0
  for (const n of f.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

// Un valor "parece secreto" si no es un placeholder evidente ni una referencia
// al entorno, y tiene pinta de credencial (letras y digitos mezclados, largo, o
// alta entropia). Es una heuristica para cortar falsos positivos de la regla
// generica, no una garantia.
export function pareceSecreto(valor) {
  if (!valor) return false
  const v = String(valor).trim().replace(/^["'`]+|["'`,;)]+$/g, '')
  if (v.length < 8) return false
  if (PLACEHOLDER.test(v)) return false
  // Expresiones y plantillas (${X}, $(X), {{X}}, <X>, %X%) no son secretos; un
  // "$" en medio de una contrasena fuerte si puede serlo.
  if (/[\s<>()`]/.test(v)) return false
  if (/^[$%{]/.test(v) || /\$\{|\$\(|\{\{/.test(v)) return false
  if (REFERENCIA_A_ENTORNO.test(v)) return false
  if (PALABRA_DE_EJEMPLO.test(v)) return false
  const tieneLetra = /[A-Za-z]/.test(v)
  const tieneDigito = /\d/.test(v)
  return (tieneLetra && tieneDigito) || v.length >= 20 || entropia(v) >= 3.5
}

// --- Datos sensibles de la organizacion ---------------------------------------------

// Archivos de datos (no de codigo) cuyo nombre delata nomina, personal, listados
// de clientes o volcados de base. Las extensiones de codigo y de texto quedan
// fuera a proposito (una migracion `crear-empleados.sql` o un `empleados.md` de
// documentacion no son datos): esas se juzgan por contenido.
const DATOS_ARCHIVOS = [
  {
    re: /(^|\/)[^/]*(n[oó]mina|payroll|salari|sueldo|legajo|empleado|employee|liquidaci[oó]n|recibo[s]?[-_ ]?de[-_ ]?sueldo|planilla|padr[oó]n|rrhh|recursos[-_ ]humanos)[^/]*\.(csv|tsv|xlsx?|xlsm|ods|parquet|db|sqlite3?|pdf|docx?)$/i,
    motivo: 'nomina / datos de personal',
  },
  {
    re: /(^|\/)[^/]*(clientes|customers|proveedores|suppliers|contactos|contacts|leads|pacientes|patients|alumnos|students)[^/]*\.(csv|tsv|xlsx?|xlsm|ods|parquet|db|sqlite3?)$/i,
    motivo: 'listado de personas / clientes / proveedores',
  },
  {
    re: /(^|\/)[^/]*(dump|backup|respaldo|volcado)[^/]*\.(sql|sql\.gz|dump|bak|gz|zip|7z|tar|tgz)$/i,
    motivo: 'volcado de base de datos',
  },
]

const PATRONES_DOCUMENTO = [
  { id: 'cuit-cuil', re: /\b(?:20|23|24|27|30|33|34)-\d{8}-\d\b/g },
  { id: 'rut', re: /\b\d{1,2}\.\d{3}\.\d{3}-[\dkK]\b/g },
  { id: 'curp', re: /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/g },
  { id: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { id: 'documento-con-etiqueta', re: /\b(?:DNI|C\.?I\.?|c[eé]dula|NIF|NIE|pasaporte|passport)\s*[:#nº°]*\s*[A-Z]?[\d.]{6,11}\d[A-Z]?\b/gi },
  { id: 'iban', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g },
  { id: 'cbu', re: /\b\d{22}\b/g },
]
const PALABRAS_DE_NOMINA = /\b(?:n[oó]mina|payroll|salarios?|sueldos?|remuneraci[oó]n(?:es)?|legajos?|obra social|fecha de nacimiento|birth ?date|date of birth|cuil|cuit|cbu|iban|n[uú]mero de documento|estado civil|domicilio particular)\b/gi
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g
const EMAIL_IGNORADO = /@(?:example\.(?:com|org|net)|test\.|localhost|noreply|no-reply|users\.noreply\.github\.com)/i
const TARJETA = /\b(?:\d[ -]?){12,18}\d\b/g
// PANs de prueba publicados por las pasarelas: aparecen en tests legitimos.
const TARJETAS_DE_PRUEBA = new Set([
  '4111111111111111', '4242424242424242', '4000000000000002', '4012888888881881',
  '5555555555554444', '5105105105105100', '5200828282828210', '378282246310005',
  '371449635398431', '6011111111111117', '6011000990139424', '3530111333300000',
  '30569309025904', '38520000023237',
])
const MAX_EMAILS = 8
// Archivos generados o compactados donde las heuristicas solo hacen ruido.
const SIN_ESCANEO_DE_CONTENIDO = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$|\.(min\.js|min\.css|map|svg|lock)$/
// Una linea mas larga que esto (minificados, blobs embebidos) no se escanea:
// las regex de correos y URLs son cuadraticas en lineas asi (unos 150 ms a
// 8 000 caracteres, ~1 s a 20 000) y un diff con muchas agotaria el tiempo del
// hook, que entonces solo podria pedir confirmacion. Se cuenta y se avisa.
const MAX_LINEA = 8_000

export function luhn(digitos) {
  let suma = 0
  let doble = false
  for (let i = digitos.length - 1; i >= 0; i--) {
    let d = Number(digitos[i])
    if (doble) {
      d *= 2
      if (d > 9) d -= 9
    }
    suma += d
    doble = !doble
  }
  return suma % 10 === 0
}

// Un numero de tarjeta plausible: Luhn valido, no un PAN de prueba, y con una
// forma que no se confunda con un timestamp en milisegundos (13 digitos que
// empiezan en 1 y pasan Luhn una de cada diez veces).
export function pareceTarjeta(crudo) {
  const digitos = crudo.replace(/[ -]/g, '')
  if (!/^\d{13,19}$/.test(digitos)) return false
  if (TARJETAS_DE_PRUEBA.has(digitos)) return false
  if (/^(\d)\1+$/.test(digitos)) return false
  if (!/^[3-6]/.test(digitos)) return false
  const conSeparadores = /[ -]/.test(crudo)
  if (!conSeparadores && digitos.length !== 15 && digitos.length !== 16) return false
  return luhn(digitos)
}

// --- .datos-autorizados ------------------------------------------------------------

export function globARegex(glob) {
  let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  const esDirectorio = g.endsWith('/')
  if (esDirectorio) g = g.slice(0, -1)
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}${esDirectorio ? '(?:/.*)?' : ''}$`)
}

// Lineas no vacias y sin comentario; lo que sigue a " #" es la justificacion.
export function leeAutorizados(texto) {
  return String(texto ?? '')
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(globARegex)
}

// Las autorizaciones valen cuando ya estan en `dev` (la rama de integracion,
// revisada): asi un commit no puede traer el dato y su propia exencion. Si
// origin/dev todavia no existe (repo recien creado), vale el archivo local.
// Siempre por el nombre completo de la ref: un tag o una rama local llamada
// "origin/dev" ganaria la resolucion corta (DWIM) y sustituiria el archivo.
const DEV_REMOTA = 'refs/remotes/origin/dev'

function autorizadosDelRepo() {
  try {
    return leeAutorizados(sh(['git', 'show', `${DEV_REMOTA}:.datos-autorizados`]))
  } catch {
    if (refExiste(DEV_REMOTA)) return []
    try {
      return leeAutorizados(readFileSync('.datos-autorizados', 'utf8'))
    } catch {
      return []
    }
  }
}

function refExiste(ref) {
  try {
    sh(['git', 'rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

export function estaAutorizado(ruta, autorizados) {
  return autorizados.some((re) => re.test(ruta))
}

// --- Lectura de diffs ------------------------------------------------------------------

// Parte un diff unificado en archivos con sus lineas agregadas y su numero de
// linea en la version nueva. Los borrados (+++ /dev/null) y los binarios no
// aportan lineas. Usa "+++ b/<ruta>", que a diferencia de "diff --git a/x b/x"
// no es ambiguo con rutas con espacios (core.quotePath=false).
export function archivosDeDiff(texto) {
  const archivos = []
  let actual = null
  let linea = 0
  for (const cruda of String(texto ?? '').split('\n')) {
    if (cruda.startsWith('diff --git ')) {
      actual = { ruta: null, binario: false, lineas: [] }
      archivos.push(actual)
      continue
    }
    if (!actual) continue
    if (cruda.startsWith('+++ ')) {
      const destino = cruda.slice(4).replace(/\t.*$/, '')
      actual.ruta = destino === '/dev/null' ? null : destino.replace(/^b\//, '')
      continue
    }
    if (cruda.startsWith('--- ')) continue
    if (cruda.startsWith('Binary files')) {
      // Un binario no trae "+++ b/<ruta>": la ruta sale de esta linea.
      actual.binario = true
      const m = cruda.match(/^Binary files (?:a\/.*|\/dev\/null) and (?:b\/(.*)|\/dev\/null) differ$/)
      if (m?.[1] && actual.ruta == null) actual.ruta = m[1]
      continue
    }
    const hunk = cruda.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      linea = Number(hunk[1])
      continue
    }
    if (cruda.startsWith('\\')) continue
    if (cruda.startsWith('+')) {
      actual.lineas.push({ n: linea, texto: cruda.slice(1) })
      linea++
    } else if (cruda.startsWith(' ')) {
      linea++
    }
  }
  return archivos.filter((a) => a.ruta != null)
}

// Lineas que superan MAX_LINEA en archivos escaneables: no se revisan, se avisan.
export function lineasLargasDeDiff(texto) {
  let n = 0
  for (const archivo of archivosDeDiff(texto)) {
    if (archivo.binario || SIN_ESCANEO_DE_CONTENIDO.test(archivo.ruta)) continue
    for (const { texto: l } of archivo.lineas) if (l.length > MAX_LINEA) n++
  }
  return n
}

// Excepciones que llegan en el mismo diff: marcadores coe:no-secreto nuevos y
// lineas nuevas en .datos-autorizados. No fallan (las decide el usuario), pero
// se listan para que el revisor las vea.
export function excepcionesNuevas(texto) {
  const marcadores = []
  let autorizaciones = 0
  for (const archivo of archivosDeDiff(texto)) {
    if (archivo.binario) continue
    for (const { n, texto: l } of archivo.lineas) {
      if (archivo.ruta === '.datos-autorizados') {
        if (l.trim() && !l.trim().startsWith('#')) autorizaciones++
      } else if (l.length <= MAX_LINEA && l.includes(MARCADOR_NO_SECRETO) && patronDeSecreto(l)) {
        // Solo cuenta un marcador que exime algo de verdad; una linea que
        // menciona el marcador (documentacion, este mismo script) no es una excepcion.
        marcadores.push({ ruta: archivo.ruta, n })
      }
    }
  }
  return { marcadores, autorizaciones }
}

// El primer patron de secreto que coincide en la linea, o null.
function patronDeSecreto(l) {
  for (const patron of PATRONES_SECRETO) {
    if (patron.requiere && !l.includes(patron.requiere)) continue
    const m = l.match(patron.re)
    if (!m) continue
    if (patron.contexto && !patron.contexto.test(l)) continue
    if (patron.valor != null && !pareceSecreto(m[patron.valor])) continue
    return patron.id
  }
  return null
}

// Secretos en las lineas agregadas de un diff. Devuelve { ruta, n, regla }.
export function escaneaSecretos(texto) {
  const hallazgos = []
  for (const archivo of archivosDeDiff(texto)) {
    if (archivo.binario || SIN_ESCANEO_DE_CONTENIDO.test(archivo.ruta)) continue
    for (const { n, texto: l } of archivo.lineas) {
      if (l.length > MAX_LINEA) continue
      if (l.includes(MARCADOR_NO_SECRETO)) continue
      const regla = patronDeSecreto(l)
      if (regla) hallazgos.push({ ruta: archivo.ruta, n, regla })
    }
  }
  return hallazgos
}

// Datos personales / de nomina en las lineas agregadas de un diff, por archivo.
// Un documento suelto no alcanza: hace falta mas de uno, o uno junto a una
// palabra de nomina, o una tarjeta valida, o un listado de correos.
export function escaneaDatosSensibles(texto, autorizados = []) {
  const hallazgos = []
  for (const archivo of archivosDeDiff(texto)) {
    if (archivo.binario || SIN_ESCANEO_DE_CONTENIDO.test(archivo.ruta)) continue
    if (archivo.ruta === '.datos-autorizados' || estaAutorizado(archivo.ruta, autorizados)) continue
    let documentos = 0
    let palabras = 0
    let tarjetas = 0
    const emails = new Set()
    for (const { texto: l } of archivo.lineas) {
      if (l.length > MAX_LINEA) continue
      for (const p of PATRONES_DOCUMENTO) documentos += (l.match(p.re) ?? []).length
      palabras += (l.match(PALABRAS_DE_NOMINA) ?? []).length
      for (const t of l.match(TARJETA) ?? []) if (pareceTarjeta(t)) tarjetas++
      // Sin "@" no hay correo, y la regex de correos es cuadratica en lineas largas.
      if (l.includes('@')) for (const e of l.match(EMAIL) ?? []) if (!EMAIL_IGNORADO.test(e)) emails.add(e.toLowerCase())
    }
    const motivos = []
    if (tarjetas) motivos.push(`${tarjetas} numero(s) de tarjeta`)
    if (documentos >= 2 || (documentos >= 1 && palabras >= 1)) {
      motivos.push(`${documentos} documento(s)/cuenta(s) de identidad${palabras ? ` y ${palabras} palabra(s) de nomina` : ''}`)
    }
    if (emails.size >= MAX_EMAILS) motivos.push(`${emails.size} correos distintos`)
    if (motivos.length) hallazgos.push({ ruta: archivo.ruta, motivo: motivos.join(', ') })
  }
  return hallazgos
}

// --- Git / gh --------------------------------------------------------------------------

// Sin prompts de credenciales: un check que se cuelga esperando un usuario
// que no existe (hook, CI) es peor que uno que falla.
const ENTORNO = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' }

function sh(args, { red = false, maxBuffer } = {}) {
  return execFileSync(args[0], args.slice(1), {
    encoding: 'utf8',
    env: ENTORNO,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: red ? 60_000 : undefined,
    maxBuffer: maxBuffer ?? 64 * 1024 * 1024,
  }).trim()
}

// core.quotePath=false + -z: con el default, git escribe una ruta con tildes o
// enie ("configuración/.env") entre comillas y con escapes octales, y ningun
// patron anclado con $ la reconoce.
function rutas(args) {
  const salida = execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    env: ENTORNO,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return rutasDeSalidaZ(salida)
}

function diff(args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    env: ENTORNO,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

export function rutasDeSalidaZ(salida) {
  return salida
    .split('\0')
    .map((s) => s.replace(/^\n+/, ''))
    .filter(Boolean)
}

export function describeError(e) {
  if (e?.code === 'ENOENT') return `no se encontro "${e.path ?? 'el comando'}" en el PATH`
  if (e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM') return 'se agoto el tiempo de espera'
  const stderr = (e?.stderr ?? '').toString().trim()
  return (stderr || String(e?.message ?? e)).split('\n')[0]
}

function ramaActual() {
  // En un checkout de pull_request, Actions hace HEAD detached sobre un merge
  // commit sintetico (refs/pull/<n>/merge): "git rev-parse --abbrev-ref HEAD"
  // devuelve literalmente "HEAD". GITHUB_HEAD_REF trae el nombre real de la rama.
  return process.env.GITHUB_HEAD_REF || sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
}

function cabezaDeLaRama() {
  // Mismo motivo que ramaActual(): en el checkout de PR, Actions resuelve
  // refs/pull/<n>/merge, un merge commit sintetico donde el padre 1 es la
  // base y el padre 2 es la cabeza real de la rama.
  if (process.env.GITHUB_HEAD_REF) {
    try {
      return sh(['git', 'rev-parse', 'HEAD^2'])
    } catch {
      return 'HEAD'
    }
  }
  return 'HEAD'
}

// Con --pr la cabeza es el commit que GitHub tiene como cabeza del PR, no el
// checkout local. Si ese commit no esta en local, las reglas que lo necesitan
// salen en skip: evaluar HEAD en su lugar daria un resultado sobre algo que no
// es el PR.
function cabezaDelPR(pr) {
  if (!pr?.headRefOid) return null
  try {
    sh(['git', 'cat-file', '-e', `${pr.headRefOid}^{commit}`])
    return pr.headRefOid
  } catch {
    return null
  }
}

function commitsDeLaRama(baseRef, cabeza) {
  const log = sh(['git', 'log', `${baseRef}..${cabeza}`, '--no-merges', '--format=%H%x1f%s'])
  if (!log) return []
  return log.split('\n').map((linea) => {
    const [hash, subject] = linea.split('\x1f')
    return { hash, subject }
  })
}

// Lo que el PR agregaria a la base al mergearse: diff de tres puntos (desde la
// base comun), para no atribuirle al PR lo que cambio la base despues.
function archivosAgregados(baseRef, cabeza) {
  return rutas(['diff', `${baseRef}...${cabeza}`, '--diff-filter=A', '--name-only', '-z'])
}

function diffDelPR(baseRef, cabeza) {
  return diff(['diff', `${baseRef}...${cabeza}`, '--unified=0', '--no-color', '--diff-filter=AMCR'])
}

// Commit por commit, todo lo que un push subiria: un archivo agregado en un
// commit y borrado en el siguiente no aparece en el diff de arboles, pero el
// push sube igual el commit que lo contiene. Los merge commits tambien
// cuentan: sin --remerge-diff, `git log -p` no muestra lo que un merge agrego
// a mano por encima del merge automatico ("evil merge"). git < 2.36 no lo
// tiene: se cae a -m --first-parent (mas ruidoso, no menos seguro).
function logSinPushear(cabeza, extra) {
  const base = ['log', cabeza, '--not', '--remotes=origin', '--format=', ...extra]
  try {
    return diff([...base, '--remerge-diff'])
  } catch (e) {
    if (!/remerge-diff/.test(String(e?.stderr ?? ''))) throw e
    return diff([...base, '-m', '--first-parent'])
  }
}

function archivosSinPushear(cabeza) {
  return rutasDeSalidaZ(logSinPushear(cabeza, ['--diff-filter=A', '--name-only', '-z']))
}

function diffSinPushear(cabeza) {
  return logSinPushear(cabeza, ['--no-color', '--unified=0', '--diff-filter=AMCR', '-p'])
}

function tagsRemotos() {
  return sh(['git', 'ls-remote', '--tags', '--refs', 'origin'], { red: true })
    .split('\n')
    .map((linea) => linea.split('\t')[1]?.replace(/^refs\/tags\//, ''))
    .filter(Boolean)
}

function tagsLocales() {
  return sh(['git', 'tag', '-l', 'v*']).split('\n').filter(Boolean)
}

export function ultimoTagDe(nombres) {
  const semver = nombres.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort(compararSemver)
  return semver.at(-1) ?? null
}

// Los tags del remoto, no los locales: en la maquina de un dev pueden estar
// viejos. ls-remote es de solo lectura. Sin red, los locales.
function ultimoTag() {
  try {
    return ultimoTagDe(tagsRemotos())
  } catch {
    try {
      return ultimoTagDe(tagsLocales())
    } catch {
      return null
    }
  }
}

function compararSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

// --- Reglas: rama-commits ---------------------------------------------------------

// El release dev -> main es un PR sobre la propia rama "dev": nunca va a
// cumplir tipo/descripcion-corta porque no es una rama de trabajo. Ninguna rama
// de trabajo, ni siquiera hotfix/*, mergea directo a main (CLAUDE.md, regla dura).
export function evaluaRama(nombre, baseRefName) {
  if (nombre === 'dev' && baseRefName === 'main') {
    return { regla: 'rama-formato', cumple: true, detalle: 'PR de release dev -> main' }
  }
  if (baseRefName === 'main') {
    return { regla: 'rama-formato', cumple: false, detalle: `PR a main solo puede venir de "dev", no de "${nombre}"` }
  }
  if (!RAMA_REGEX.test(nombre)) {
    return { regla: 'rama-formato', cumple: false, detalle: `"${nombre}" no cumple tipo/descripcion-corta` }
  }
  // Coincidencia exacta: la lista caza nombres vagos ("prueba" a secas), no
  // descripciones legitimas que empiecen igual (experiment/prueba-modelo-rag).
  const slug = nombre.split('/').slice(1).join('/')
  if (RAMA_LISTA_NEGRA.includes(slug)) {
    return { regla: 'rama-formato', cumple: false, detalle: `"${nombre}" usa un slug prohibido` }
  }
  return { regla: 'rama-formato', cumple: true, detalle: nombre }
}

export function evaluaCommits(commits) {
  if (commits.length === 0) {
    return [{ regla: 'commits-formato', cumple: null, detalle: 'sin commits nuevos contra la base' }]
  }
  return commits.map(({ hash, subject }) => {
    const corto = hash.slice(0, 7)
    if (!COMMIT_REGEX.test(subject)) {
      return { regla: 'commits-formato', cumple: false, detalle: `${corto} "${subject}" no matchea tipo: descripcion` }
    }
    const mensaje = subject.split(': ').slice(1).join(': ').trim().toLowerCase()
    if (COMMIT_MENSAJES_PROHIBIDOS.includes(mensaje)) {
      return { regla: 'commits-formato', cumple: false, detalle: `${corto} "${subject}" es un mensaje prohibido` }
    }
    return { regla: 'commits-formato', cumple: true, detalle: `${corto} "${subject}"` }
  })
}

// --- Reglas: secretos -----------------------------------------------------------------

export function esArchivoDeSecreto(ruta) {
  return SECRETO_ARCHIVOS.some((patron) => patron.test(ruta))
}

export function motivoArchivoDeDatos(ruta) {
  return DATOS_ARCHIVOS.find((d) => d.re.test(ruta))?.motivo ?? null
}

export function evaluaSecretos(archivos, donde = 'agregados') {
  const encontrados = archivos.filter(esArchivoDeSecreto)
  if (encontrados.length > 0) {
    return { regla: 'sin-secretos', cumple: false, detalle: `archivos de credenciales ${donde}: ${encontrados.join(', ')}` }
  }
  return { regla: 'sin-secretos', cumple: true, detalle: `sin archivos de credenciales ${donde}` }
}

const MAX_DETALLE = 10

export function evaluaContenidoSecreto(textoDiff, donde = 'agregado') {
  const hallazgos = escaneaSecretos(textoDiff)
  const largas = lineasLargasDeDiff(textoDiff)
  const nota = largas ? ` (${largas} linea(s) de mas de ${MAX_LINEA} caracteres sin escanear)` : ''
  if (hallazgos.length === 0) {
    return { regla: 'sin-secretos-en-contenido', cumple: true, detalle: `sin llaves, tokens ni contrasenas en el contenido ${donde}${nota}` }
  }
  const lista = hallazgos.slice(0, MAX_DETALLE).map((h) => `${h.ruta}:${h.n} (${h.regla})`)
  const resto = hallazgos.length > MAX_DETALLE ? ` y ${hallazgos.length - MAX_DETALLE} mas` : ''
  return {
    regla: 'sin-secretos-en-contenido',
    cumple: false,
    detalle: `posibles credenciales en el contenido ${donde}: ${lista.join(', ')}${resto}${nota} -- si es un falso positivo, el usuario marca la linea con ${MARCADOR_NO_SECRETO}`,
  }
}

// Informativa: las excepciones las decide el usuario, pero el revisor tiene que
// verlas. Sale como skip (no OK) cuando hay alguna, para que llegue al agente.
export function evaluaExcepcionesNuevas(textoDiff, donde = 'agregado') {
  const { marcadores, autorizaciones } = excepcionesNuevas(textoDiff)
  if (!marcadores.length && !autorizaciones) {
    return { regla: 'excepciones-nuevas', cumple: true, detalle: `sin marcadores ${MARCADOR_NO_SECRETO} ni autorizaciones nuevas ${donde}` }
  }
  const partes = []
  if (marcadores.length) {
    partes.push(`${marcadores.length} marcador(es) ${MARCADOR_NO_SECRETO} nuevo(s): ${marcadores.slice(0, MAX_DETALLE).map((m) => `${m.ruta}:${m.n}`).join(', ')}`)
  }
  if (autorizaciones) partes.push(`${autorizaciones} linea(s) nueva(s) en .datos-autorizados (valen cuando esten en dev)`)
  return { regla: 'excepciones-nuevas', cumple: null, detalle: `revisar a mano, las excepciones las decide el usuario y no el agente: ${partes.join('; ')}` }
}

export function evaluaDatosSensibles({ archivos = [], textoDiff = '', autorizados = [] }, donde = 'agregado') {
  const porNombre = archivos
    .filter((r) => !estaAutorizado(r, autorizados))
    .map((r) => ({ ruta: r, motivo: motivoArchivoDeDatos(r) }))
    .filter((h) => h.motivo)
  const porContenido = escaneaDatosSensibles(textoDiff, autorizados)
  const hallazgos = [...porNombre, ...porContenido.filter((c) => !porNombre.some((n) => n.ruta === c.ruta))]
  if (hallazgos.length === 0) {
    return { regla: 'sin-datos-sensibles', cumple: true, detalle: `sin datos personales ni de nomina ${donde}` }
  }
  const lista = hallazgos.slice(0, MAX_DETALLE).map((h) => `${h.ruta} (${h.motivo})`)
  const resto = hallazgos.length > MAX_DETALLE ? ` y ${hallazgos.length - MAX_DETALLE} mas` : ''
  return {
    regla: 'sin-datos-sensibles',
    cumple: false,
    detalle: `posibles datos de la organizacion sin autorizar ${donde}: ${lista.join(', ')}${resto} -- con autorizacion del responsable, el usuario registra la ruta en .datos-autorizados`,
  }
}

// --- Reglas: pr-metadata ---------------------------------------------------------------

function evaluaBaseDev(baseRefName, nombreRama) {
  if (baseRefName == null) {
    return { regla: 'pr-apunta-a-dev', cumple: null, detalle: 'no hay datos de PR (falta --pr o gh)' }
  }
  if (baseRefName === 'main') {
    if (nombreRama === 'dev') {
      return { regla: 'pr-apunta-a-dev', cumple: true, detalle: 'PR de release dev -> main' }
    }
    return { regla: 'pr-apunta-a-dev', cumple: false, detalle: `base es "main" pero la rama es "${nombreRama}", debe ser "dev"` }
  }
  if (baseRefName !== 'dev') {
    return { regla: 'pr-apunta-a-dev', cumple: false, detalle: `base es "${baseRefName}", debe ser "dev"` }
  }
  return { regla: 'pr-apunta-a-dev', cumple: true, detalle: 'base = dev' }
}

function evaluaMergeable(pr) {
  if (pr == null) {
    return { regla: 'rama-al-dia-sin-conflictos', cumple: null, detalle: 'no hay datos de PR' }
  }
  if (pr.mergeable === 'UNKNOWN') {
    return { regla: 'rama-al-dia-sin-conflictos', cumple: null, detalle: 'GitHub todavia no calculo mergeable' }
  }
  return {
    regla: 'rama-al-dia-sin-conflictos',
    cumple: pr.mergeable === 'MERGEABLE',
    detalle: `mergeable=${pr.mergeable}`,
  }
}

// Justo despues de gh pr create, GitHub todavia no calculo si el PR mergea
// limpio (UNKNOWN). Se relee solo ese campo unas veces antes de rendirse.
export function esperaMergeable(pr, releer, dormir, { intentos = 4, esperaMs = 3000 } = {}) {
  let actual = pr
  for (let i = 0; i < intentos && actual?.mergeable === 'UNKNOWN'; i++) {
    dormir(esperaMs)
    try {
      actual = { ...actual, mergeable: releer() }
    } catch {
      break
    }
  }
  return actual
}

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function extraeSeccion(cuerpo, titulo) {
  // El lookahead (?=\n## |$) se combina con el flag 'm' del anchor ^, y ahi
  // $ significa fin-de-linea: corta la seccion en su primera linea. (?![\s\S])
  // fuerza fin-de-string real.
  const regex = new RegExp(`^## ${titulo}\\s*\\n([\\s\\S]*?)(?=\\n## |(?![\\s\\S]))`, 'm')
  const m = cuerpo.match(regex)
  return m ? m[1].trim() : null
}

export function evaluaVersion(pr, baseRefName) {
  if (pr == null) {
    return { regla: 'version-semver', cumple: null, detalle: 'no hay datos de PR' }
  }
  const seccion = extraeSeccion(pr.body ?? '', 'Requiere versión / release')
  if (seccion == null) {
    return { regla: 'version-semver', cumple: false, detalle: 'falta la seccion "Requiere versión / release"' }
  }
  const marcadosSi = /- \[x\] S[ií]/i.test(seccion)
  const marcadosNo = /- \[x\] No/i.test(seccion)
  if (marcadosSi === marcadosNo) {
    return { regla: 'version-semver', cumple: false, detalle: 'debe marcarse exactamente una de No/Si' }
  }
  if (!marcadosSi) {
    return { regla: 'version-semver', cumple: true, detalle: 'No requiere version' }
  }
  const m = seccion.match(/Versi[oó]n sugerida:\s*(v\d+\.\d+\.\d+)/i)
  if (!m) {
    return { regla: 'version-semver', cumple: false, detalle: 'marco "Si" pero no propuso vX.Y.Z' }
  }
  const propuesta = m[1]
  if (baseRefName !== 'main') {
    return { regla: 'version-semver', cumple: true, detalle: `${propuesta} (formato valido; comparacion con tags solo aplica en PR dev->main)` }
  }
  const ultimo = ultimoTag()
  if (ultimo && compararSemver(propuesta, ultimo) <= 0) {
    return { regla: 'version-semver', cumple: false, detalle: `${propuesta} no es mayor al ultimo tag ${ultimo}` }
  }
  return { regla: 'version-semver', cumple: true, detalle: `${propuesta} > ${ultimo ?? '(sin tags previos)'}` }
}

function plantillaPR() {
  try {
    return readFileSync('.github/pull_request_template.md', 'utf8')
  } catch {
    return ''
  }
}

export function evaluaSeccionesCompletas(pr) {
  if (pr == null) {
    return { regla: 'sin-secciones-vacias', cumple: null, detalle: 'no hay datos de PR' }
  }
  const cuerpo = pr.body ?? ''
  const plantilla = plantillaPR()
  const secciones = ['Descripción del cambio', 'Evidencia', 'Impacto / Riesgos']
  const vacias = secciones.filter((titulo) => {
    const contenido = extraeSeccion(cuerpo, titulo)
    if (contenido == null) return true
    if (contenido === '' || /^n\/a\.?$/i.test(contenido)) return true
    // Plantilla intacta: el texto guia de la seccion quedo tal cual, sin rellenar.
    const guia = extraeSeccion(plantilla, titulo)
    return guia != null && guia !== '' && contenido === guia
  })
  if (vacias.length > 0) {
    return { regla: 'sin-secciones-vacias', cumple: false, detalle: `vacias, "N/A" o con el texto de la plantilla: ${vacias.join(', ')}` }
  }
  return { regla: 'sin-secciones-vacias', cumple: true, detalle: 'secciones clave con contenido' }
}

// El security review es obligatorio antes de cada PR, y la auditoria gateada
// (skill security-audit) antes de cada release dev -> main. La seccion del PR
// es la evidencia: casilla marcada, hallazgos declarados y, en el release, el
// estado READY del informe.
export function evaluaSecurityReview(pr, baseRefName) {
  if (pr == null) {
    return { regla: 'security-review-declarado', cumple: null, detalle: 'no hay datos de PR' }
  }
  const seccion = extraeSeccion(pr.body ?? '', 'Security review')
  if (seccion == null) {
    return { regla: 'security-review-declarado', cumple: false, detalle: 'falta la seccion "Security review"' }
  }
  if (!/- \[x\][^\n]*\/security-review/i.test(seccion)) {
    return { regla: 'security-review-declarado', cumple: false, detalle: 'la casilla de /security-review no esta marcada: corre el review antes de abrir el PR' }
  }
  const hallazgos = seccion.match(/Hallazgos:\s*(.*)/i)?.[1]?.trim() ?? ''
  if (!hallazgos || /^\(ninguno \/ listar/i.test(hallazgos)) {
    return { regla: 'security-review-declarado', cumple: false, detalle: 'la linea "Hallazgos:" esta vacia o con el texto de la plantilla' }
  }
  if (baseRefName === 'main' && !/READY (?:FOR REVIEW|WITH CONDITIONS)/.test(seccion)) {
    return {
      regla: 'security-review-declarado',
      cumple: false,
      detalle: 'el PR de release debe declarar el estado de security-audit (READY FOR REVIEW / READY WITH CONDITIONS) y la ruta del informe',
    }
  }
  return { regla: 'security-review-declarado', cumple: true, detalle: `security review declarado (hallazgos: ${hallazgos.slice(0, 60)})` }
}

// Exactamente una de las dos casillas: "no incluye datos" o "incluye con
// autorizacion", y en el segundo caso, quien autorizo.
export function evaluaDatosSensiblesDeclarados(pr) {
  if (pr == null) {
    return { regla: 'datos-sensibles-declarados', cumple: null, detalle: 'no hay datos de PR' }
  }
  const seccion = extraeSeccion(pr.body ?? '', 'Datos sensibles')
  if (seccion == null) {
    return { regla: 'datos-sensibles-declarados', cumple: false, detalle: 'falta la seccion "Datos sensibles"' }
  }
  const noIncluye = /- \[x\] Este PR \*\*no\*\* incluye/i.test(seccion)
  const incluye = /- \[x\] Este PR incluye datos/i.test(seccion)
  if (noIncluye === incluye) {
    return { regla: 'datos-sensibles-declarados', cumple: false, detalle: 'debe marcarse exactamente una de las dos casillas (no incluye / incluye con autorizacion)' }
  }
  if (incluye) {
    const autor = seccion.match(/Autorizado por:\s*(.*)/i)?.[1]?.trim() ?? ''
    if (!autor || /<[^>]+>/.test(autor)) {
      return { regla: 'datos-sensibles-declarados', cumple: false, detalle: 'marco que incluye datos de la organizacion pero no dice quien lo autorizo ni cuando' }
    }
    return { regla: 'datos-sensibles-declarados', cumple: true, detalle: `incluye datos con autorizacion: ${autor.slice(0, 80)}` }
  }
  return { regla: 'datos-sensibles-declarados', cumple: true, detalle: 'declara que no incluye datos sensibles' }
}

// --- Orquestacion --------------------------------------------------------------------------

// --pr acepta el numero o la URL del PR. La URL evita que gh tenga que elegir
// remoto (con varios remotos, pregunta o falla).
function obtenerPR(pr) {
  const campos = 'baseRefName,headRefName,headRefOid,body,mergeable,state'
  return JSON.parse(sh(['gh', 'pr', 'view', String(pr), '--json', campos], { red: true }))
}

function releerMergeable(pr) {
  return sh(['gh', 'pr', 'view', String(pr), '--json', 'mergeable', '--jq', '.mergeable'], { red: true })
}

// Con PR, base y rama salen del PR; sin PR, del entorno de Actions o del
// checkout local. Un GITHUB_BASE_REF vacio cae a "dev".
export function contextoDelCheck({ pr = null, envBase = '', ramaLocal = null } = {}) {
  return {
    base: pr?.baseRefName || envBase || 'dev',
    rama: pr?.headRefName || ramaLocal,
  }
}

// Nombre completo de la ref remota (refs/remotes/origin/<rama>): el nombre
// corto "origin/<rama>" lo puede sombrear un tag o una rama local.
function resuelveRef(nombre) {
  const completa = `refs/remotes/origin/${nombre}`
  try {
    sh(['git', 'rev-parse', '--verify', completa])
    return completa
  } catch {
    return nombre
  }
}

function sinCabeza(regla) {
  return { regla, cumple: null, detalle: 'la cabeza del PR no esta en local (corre git fetch origin)' }
}

const GRUPOS = ['rama-commits', 'secretos', 'pr-metadata']

function evaluar(values) {
  let pr = values.pr ? obtenerPR(values.pr) : null
  const { base, rama } = contextoDelCheck({
    pr,
    envBase: process.env.GITHUB_BASE_REF,
    ramaLocal: pr?.headRefName ? null : ramaActual(),
  })
  const baseLocal = resuelveRef(base)
  const cabeza = pr ? cabezaDelPR(pr) : values.cabeza || cabezaDeLaRama()

  const resultados = []
  if (values.grupo === 'rama-commits') {
    resultados.push(evaluaRama(rama, pr?.baseRefName ?? null))
    resultados.push(...(cabeza ? evaluaCommits(commitsDeLaRama(baseLocal, cabeza)) : [sinCabeza('commits-formato')]))
  }
  if (values.grupo === 'secretos') {
    const autorizados = autorizadosDelRepo()
    if (values['sin-pushear']) {
      const ref = values.cabeza || 'HEAD'
      const archivos = archivosSinPushear(ref)
      const textoDiff = diffSinPushear(ref)
      resultados.push(evaluaSecretos(archivos, 'en commits sin pushear'))
      resultados.push(evaluaContenidoSecreto(textoDiff, 'en commits sin pushear'))
      resultados.push(evaluaDatosSensibles({ archivos, textoDiff, autorizados }, 'en commits sin pushear'))
      resultados.push(evaluaExcepcionesNuevas(textoDiff, 'en commits sin pushear'))
    } else if (cabeza) {
      const archivos = archivosAgregados(baseLocal, cabeza)
      const textoDiff = diffDelPR(baseLocal, cabeza)
      resultados.push(evaluaSecretos(archivos))
      resultados.push(evaluaContenidoSecreto(textoDiff))
      resultados.push(evaluaDatosSensibles({ archivos, textoDiff, autorizados }))
      resultados.push(evaluaExcepcionesNuevas(textoDiff))
    } else {
      resultados.push(sinCabeza('sin-secretos'), sinCabeza('sin-secretos-en-contenido'), sinCabeza('sin-datos-sensibles'), sinCabeza('excepciones-nuevas'))
    }
  }
  if (values.grupo === 'pr-metadata') {
    // Un PR mergeado o cerrado reporta UNKNOWN para siempre: reintentar ahi es
    // pura espera.
    if (pr?.state === 'OPEN') pr = esperaMergeable(pr, () => releerMergeable(values.pr), dormir)
    resultados.push(evaluaBaseDev(pr?.baseRefName ?? null, rama))
    resultados.push(evaluaMergeable(pr))
    resultados.push(evaluaVersion(pr, pr?.baseRefName ?? null))
    resultados.push(evaluaSeccionesCompletas(pr))
    resultados.push(evaluaSecurityReview(pr, pr?.baseRefName ?? null))
    resultados.push(evaluaDatosSensiblesDeclarados(pr))
  }
  return resultados
}

function main() {
  let values
  try {
    ;({ values } = parseArgs({
      options: {
        pr: { type: 'string' },
        grupo: { type: 'string' },
        cabeza: { type: 'string' },
        'sin-pushear': { type: 'boolean' },
      },
    }))
  } catch (e) {
    console.log(`[ERROR] uso: ${describeError(e)}`)
    process.exit(2)
  }
  if (!GRUPOS.includes(values.grupo)) {
    console.log(`[ERROR] uso: --grupo debe ser uno de: ${GRUPOS.join(', ')}`)
    process.exit(2)
  }
  // --cabeza es una rev para git log: nada que git pueda leer como opcion,
  // salvo --branches/--tags (lo que suben git push --all/--mirror/--tags).
  if (values.cabeza?.startsWith('-') && !['--branches', '--tags'].includes(values.cabeza)) {
    console.log(`[ERROR] uso: --cabeza no admite "${values.cabeza}"`)
    process.exit(2)
  }

  let resultados
  try {
    resultados = evaluar(values)
  } catch (e) {
    console.log(`[ERROR] ${values.grupo}: no se pudo verificar: ${describeError(e)}`)
    process.exit(2)
  }

  let huboFalse = false
  for (const r of resultados) {
    const marca = r.cumple === true ? 'OK  ' : r.cumple === false ? 'FAIL' : 'skip'
    console.log(`[${marca}] ${r.regla}: ${r.detalle}`)
    if (r.cumple === false) huboFalse = true
  }

  process.exit(huboFalse ? 1 : 0)
}

// Solo como ejecutable: al importarse desde los tests no corre nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

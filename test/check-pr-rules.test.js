import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  evaluaRama,
  evaluaCommits,
  evaluaSeccionesCompletas,
  evaluaVersion,
  evaluaSecurityReview,
  evaluaDatosSensiblesDeclarados,
  esArchivoDeSecreto,
  motivoArchivoDeDatos,
  evaluaSecretos,
  evaluaContenidoSecreto,
  evaluaDatosSensibles,
  pareceSecreto,
  pareceTarjeta,
  luhn,
  escaneaSecretos,
  escaneaDatosSensibles,
  lineasLargasDeDiff,
  excepcionesNuevas,
  evaluaExcepcionesNuevas,
  archivosDeDiff,
  globARegex,
  leeAutorizados,
  rutasDeSalidaZ,
  contextoDelCheck,
  esperaMergeable,
  ultimoTagDe,
  describeError,
} from '../scripts/check-pr-rules.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/check-pr-rules.mjs', import.meta.url))

// --- Ramas y commits ---------------------------------------------------------

test('evaluaRama: acepta la forma simple tipo/descripcion-corta', () => {
  const validas = [
    'feature/captura-lead',
    'fix/error-integracion-erp',
    'hotfix/correccion-produccion',
    'docs/onboarding-auth-gh',
    'chore/actualizar-dependencias',
    'refactor/mejorar-estructura-api',
    'experiment/prueba-modelo-rag',
    'chore/bump-1.2.0',
  ]
  for (const rama of validas) {
    assert.equal(evaluaRama(rama).cumple, true, rama)
  }
})

test('evaluaRama: acepta el prefijo de ID de un tracker externo', () => {
  for (const rama of ['feature/ABC-123-captura-lead', 'fix/GH-12-chequeo-gh', 'feature/PROJ-4-x']) {
    assert.equal(evaluaRama(rama).cumple, true, rama)
  }
})

test('evaluaRama: rechaza lo que ninguna de las dos formas permite', () => {
  const invalidas = [
    'feature/Mayusculas-en-el-slug',
    'feature/ABC-123', // ID sin slug descriptivo
    'cambios/algo', // tipo inexistente
    'feature/prueba', // slug prohibido
    'feature/final-final',
    'main',
    'feature/', // sin slug
  ]
  for (const rama of invalidas) {
    assert.equal(evaluaRama(rama).cumple, false, rama)
  }
})

test('evaluaRama: "dev" contra base "main" es la excepcion del release, y ninguna rama de trabajo pasa a main', () => {
  assert.equal(evaluaRama('dev', 'main').cumple, true)
  assert.equal(evaluaRama('dev').cumple, false)
  assert.equal(evaluaRama('dev', 'dev').cumple, false)
  for (const rama of ['feature/captura-lead', 'hotfix/correccion-produccion', 'chore/bump-1.2.0']) {
    assert.equal(evaluaRama(rama, 'main').cumple, false, rama)
  }
})

test('evaluaCommits: acepta tildes y enie al inicio, y revert en minuscula o mayuscula', () => {
  const commits = [
    { hash: '1111111aaaa', subject: 'fix: ícono roto en el boton de exportar' },
    { hash: '2222222bbbb', subject: 'feat: ñoquis de los viernes en el catering' },
    { hash: '4444444dddd', subject: 'revert: deshacer el bump de version 1.2.0' },
    { hash: '5555555eeee', subject: 'Revert: deshacer el bump de version 1.2.0' },
  ]
  for (const r of evaluaCommits(commits)) assert.equal(r.cumple, true, r.detalle)
  assert.equal(evaluaCommits([{ hash: '6666666ffff', subject: 'update' }])[0].cumple, false)
  assert.equal(evaluaCommits([{ hash: '7777777gggg', subject: 'fix: fix' }])[0].cumple, false)
})

// El harness distribuye el check, el hook y los workflows via el manifest. La
// fuente sigue siendo lo que este repo aplica sobre si mismo: si alguien toca
// una copia y no la otra, los consumidores quedan con una version distinta.
test('las copias distribuidas en templates/base son identicas a las fuentes', () => {
  const espejos = [
    ['scripts/check-pr-rules.mjs', 'templates/base/scripts/check-pr-rules.mjs'],
    ['scripts/tag-release.mjs', 'templates/base/scripts/tag-release.mjs'],
    ['.github/workflows/reglas-pr.yml', 'templates/base/github/workflows/reglas-pr.yml'],
    ['.github/workflows/tag-release.yml', 'templates/base/github/workflows/tag-release.yml'],
    ['.claude/hooks/reglas-pr.mjs', 'templates/base/claude/hooks/reglas-pr.mjs'],
  ]
  for (const [fuente, copia] of espejos) {
    assert.equal(readFileSync(copia, 'utf8'), readFileSync(fuente, 'utf8'), `${copia} difiere de ${fuente}`)
  }
})

// --- Plantilla del PR -----------------------------------------------------------

test('evaluaSeccionesCompletas: la plantilla sin rellenar NO pasa; con contenido real si; N/A o vacia no', () => {
  const plantilla = readFileSync('.github/pull_request_template.md', 'utf8')
  const cruda = evaluaSeccionesCompletas({ body: plantilla })
  assert.equal(cruda.cumple, false)
  assert.match(cruda.detalle, /Descripción del cambio/)

  const body = ['## Descripción del cambio', 'Se corrige la regex de ramas del check.', '', '## Evidencia', 'npm test en verde.', '', '## Impacto / Riesgos', 'Solo CI de este repo.'].join('\n')
  assert.equal(evaluaSeccionesCompletas({ body }).cumple, true)

  const vacia = ['## Descripción del cambio', 'N/A', '', '## Evidencia', '', '## Impacto / Riesgos', 'Ninguno relevante.'].join('\n')
  assert.equal(evaluaSeccionesCompletas({ body: vacia }).cumple, false)
})

test('evaluaVersion: exige exactamente una casilla marcada', () => {
  const conNo = '## Requiere versión / release\n- [x] No\n- [ ] Sí\nVersión sugerida: vX.Y.Z'
  const cruda = '## Requiere versión / release\n- [ ] No\n- [ ] Sí\nVersión sugerida: vX.Y.Z'
  assert.equal(evaluaVersion({ body: conNo }, 'dev').cumple, true)
  assert.equal(evaluaVersion({ body: cruda }, 'dev').cumple, false)
})

test('evaluaSecurityReview: la casilla marcada y los hallazgos declarados; el release exige el estado de security-audit', () => {
  const plantilla = readFileSync('.github/pull_request_template.md', 'utf8')
  assert.equal(evaluaSecurityReview({ body: plantilla }, 'dev').cumple, false, 'la plantilla cruda no pasa')
  assert.match(evaluaSecurityReview({ body: plantilla }, 'dev').detalle, /casilla/)

  const marcadaSinHallazgos = '## Security review\n- [x] Corrí `/security-review` sobre este cambio antes de abrir el PR.\n- Hallazgos: (ninguno / listar hallazgos y su severidad)'
  assert.match(evaluaSecurityReview({ body: marcadaSinHallazgos }, 'dev').detalle, /Hallazgos/)

  const ok = '## Security review\n- [x] Corrí `/security-review` sobre este cambio antes de abrir el PR.\n- Hallazgos: ninguno\n'
  assert.equal(evaluaSecurityReview({ body: ok }, 'dev').cumple, true)
  // El mismo body en un PR a main no alcanza: falta la auditoria.
  assert.equal(evaluaSecurityReview({ body: ok }, 'main').cumple, false)
  const release = ok + '- security-audit: READY FOR REVIEW — docs/security/2026-10-05_101500/SECURITY-AUDIT.md\n'
  assert.equal(evaluaSecurityReview({ body: release }, 'main').cumple, true)

  assert.equal(evaluaSecurityReview({ body: '## Evidencia\nx' }, 'dev').cumple, false, 'sin seccion')
  assert.equal(evaluaSecurityReview(null, 'dev').cumple, null)
})

test('evaluaDatosSensiblesDeclarados: exactamente una casilla, y con autorizacion hay que decir quien', () => {
  const plantilla = readFileSync('.github/pull_request_template.md', 'utf8')
  assert.equal(evaluaDatosSensiblesDeclarados({ body: plantilla }).cumple, false, 'ninguna marcada')

  const no = '## Datos sensibles\n- [x] Este PR **no** incluye credenciales ni datos personales o internos de la organización.\n- [ ] Este PR incluye datos de la organización **con autorización previa**.'
  assert.equal(evaluaDatosSensiblesDeclarados({ body: no }).cumple, true)

  const ambas = no.replace('- [ ] Este PR incluye', '- [x] Este PR incluye')
  assert.equal(evaluaDatosSensiblesDeclarados({ body: ambas }).cumple, false, 'las dos marcadas')

  const siSinAutor = '## Datos sensibles\n- [ ] Este PR **no** incluye credenciales.\n- [x] Este PR incluye datos de la organización **con autorización previa**.\n  - Autorizado por: <quién, rol> el <AAAA-MM-DD>'
  assert.equal(evaluaDatosSensiblesDeclarados({ body: siSinAutor }).cumple, false)
  assert.match(evaluaDatosSensiblesDeclarados({ body: siSinAutor }).detalle, /quien lo autorizo/)

  const siConAutor = siSinAutor.replace('<quién, rol> el <AAAA-MM-DD>', 'Gerencia Comercial (responsable del dato) el 2026-10-01')
  assert.equal(evaluaDatosSensiblesDeclarados({ body: siConAutor }).cumple, true)
})

// --- Secretos: archivos ----------------------------------------------------------

test('esArchivoDeSecreto: .env.example y sus variantes no son secretos', () => {
  for (const ruta of ['.env.example', 'app/.env.sample', '.env.template', 'config/.env.dist']) {
    assert.equal(esArchivoDeSecreto(ruta), false, ruta)
  }
})

test('esArchivoDeSecreto: los .env reales, las llaves y las credenciales si lo son', () => {
  const secretos = [
    '.env',
    '.env.local',
    '.env.staging',
    'config/.env',
    'configuración/.env',
    'certs/servidor.pem',
    'llave.key',
    'firma.pfx',
    'certs/cliente.p12',
    'android/release.keystore',
    'credentials.json',
    'infra/secrets.json',
    'gcp/service-account.json',
    'oauth/client_secret_123.apps.googleusercontent.com.json',
    '.ssh/id_ed25519',
    'deploy/kubeconfig',
    'infra/terraform.tfstate',
    'funcs/local.settings.json',
    '.netrc',
  ]
  for (const ruta of secretos) {
    assert.equal(esArchivoDeSecreto(ruta), true, ruta)
  }
  // Y lo que se les parece pero no lo es.
  for (const ruta of ['.ssh/id_ed25519.pub', 'src/keys.ts', 'docs/secrets-policy.md', 'public.pem.md']) {
    assert.equal(esArchivoDeSecreto(ruta), false, ruta)
  }
})

test('evaluaSecretos: el detalle dice donde se buscaron', () => {
  const r = evaluaSecretos(['a.txt', '.env.staging'], 'en commits sin pushear')
  assert.equal(r.cumple, false)
  assert.match(r.detalle, /en commits sin pushear: \.env\.staging/)
  assert.equal(evaluaSecretos(['a.txt']).cumple, true)
})

// --- Secretos: contenido -------------------------------------------------------------

test('pareceSecreto: descarta placeholders y referencias al entorno, acepta credenciales reales (con $ en el medio tambien)', () => {
  for (const v of ['<your-token>', '${DB_PASSWORD}', '{{ vault_pass }}', '$SECRET', '$(cat secreto)', 'x${FOO}y', '%SECRET%', 'changeme', 'your-api-key-here', 'process.env.TOKEN', 'os.environ["X"]', 'xxxxxxxxxx', 'string', 'contraseña', 'example-key-123']) {
    assert.equal(pareceSecreto(v), false, v)
  }
  for (const v of ['Sup3rS3cr3t!', 'Pa$$w0rd-larga-123', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'.replace('EXAMPLE', 'QWERTY'), 'abcdefghijklmnopqrstuvwxyz', 'hunter2hunter2']) {
    assert.equal(pareceSecreto(v), true, v)
  }
})

// Las regex de correos y URLs eran cuadraticas en lineas largas sin "@" ni
// "://": un commit con una linea patologica vencia el timeout del hook. Ahora
// hay pre-chequeos baratos y un tope de linea que se cuenta y se avisa.
test('escaneo: una linea larga patologica no cuelga el check, y las que superan el tope se cuentan', () => {
  const casiTope = 'a.'.repeat(3_900) // 7 800 caracteres: se escanea
  const sobreTope = 'a-'.repeat(60_000) // 120 000 caracteres: se omite y se avisa
  const texto = diffDe({ 'src/datos.js': [casiTope, sobreTope, 'const x = 1'] })
  const inicio = Date.now()
  assert.deepEqual(escaneaSecretos(texto), [])
  assert.deepEqual(escaneaDatosSensibles(texto), [])
  const ms = Date.now() - inicio
  assert.ok(ms < 1500, `el escaneo tardo ${ms} ms`)
  assert.equal(lineasLargasDeDiff(texto), 1)
  const r = evaluaContenidoSecreto(texto)
  assert.equal(r.cumple, true)
  assert.match(r.detalle, /1 linea\(s\) de mas de 8000 caracteres sin escanear/)
})

test('excepcionesNuevas: los marcadores que eximen algo y las autorizaciones nuevas se listan como skip; mencionar el marcador no cuenta', () => {
  const texto = diffDe({
    'src/a.js': ['const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab" // coe:no-secreto (fixture)', 'const y = 2'], // coe:no-secreto (fixture)
    'docs/guia.md': ['Si es un falso positivo, el usuario marca la linea con coe:no-secreto.'],
    '.datos-autorizados': ['# comentario', 'tests/fixtures/x.json  # sinteticos', ''],
  })
  const { marcadores, autorizaciones } = excepcionesNuevas(texto)
  assert.deepEqual(marcadores, [{ ruta: 'src/a.js', n: 1 }])
  assert.equal(autorizaciones, 1)
  const r = evaluaExcepcionesNuevas(texto)
  assert.equal(r.cumple, null)
  assert.match(r.detalle, /src\/a\.js:1/)
  assert.match(r.detalle, /1 linea\(s\) nueva\(s\) en \.datos-autorizados/)
  assert.equal(evaluaExcepcionesNuevas(diffDe({ 'src/a.js': ['const y = 2'] })).cumple, true)
})

function diffDe(archivos) {
  return Object.entries(archivos)
    .map(([ruta, lineas]) => [`diff --git a/${ruta} b/${ruta}`, `--- /dev/null`, `+++ b/${ruta}`, `@@ -0,0 +1,${lineas.length} @@`, ...lineas.map((l) => `+${l}`)].join('\n'))
    .join('\n')
}

test('archivosDeDiff: rutas con espacios, borrados y binarios', () => {
  const texto = [
    'diff --git a/mi carpeta/a.txt b/mi carpeta/a.txt',
    '--- /dev/null',
    '+++ b/mi carpeta/a.txt',
    '@@ -0,0 +1,2 @@',
    '+uno',
    '+dos',
    'diff --git a/borrado.txt b/borrado.txt',
    '--- a/borrado.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-adios',
    'diff --git a/logo.png b/logo.png',
    'Binary files /dev/null and b/logo.png differ',
  ].join('\n')
  const archivos = archivosDeDiff(texto)
  assert.deepEqual(archivos.map((a) => a.ruta), ['mi carpeta/a.txt', 'logo.png'])
  assert.deepEqual(archivos[0].lineas, [{ n: 1, texto: 'uno' }, { n: 2, texto: 'dos' }])
  assert.equal(archivos[1].binario, true)
})

test('escaneaSecretos: detecta llaves, tokens y contrasenas reales en las lineas agregadas', () => {
  const texto = diffDe({
    'src/config.js': ['const apiKey = "AKIA4QX7NY2PZT9W8L3M"', 'const password = "Sup3rS3cr3t!"', 'const url = "postgres://app:Pa55w0rd!@db.internal:5432/app"'], // coe:no-secreto (fixture)
    'deploy/key.txt': ['-----BEGIN RSA PRIVATE KEY-----', 'MIIE...'], // coe:no-secreto (fixture)
    'ci/.npmrc': ['//registry.npmjs.org/:_authToken=npm_ABCdef1234567890ghijKLMN'], // coe:no-secreto (fixture)
  })
  const reglas = escaneaSecretos(texto).map((h) => `${h.ruta}:${h.n}:${h.regla}`)
  assert.deepEqual(reglas, [
    'src/config.js:1:aws-access-key-id',
    'src/config.js:2:asignacion-de-secreto',
    'src/config.js:3:url-con-credenciales',
    'deploy/key.txt:1:llave-privada',
    'ci/.npmrc:1:npm-token',
  ])
})

// La clave puede venir con prefijo (DB_PASSWORD, db_password, MYSQL_ROOT_PASSWORD)
// o en camelCase (smtpPassword): \b trataba "_" como letra y no las veia.
test('escaneaSecretos: claves con prefijo y en camelCase; nombres que solo contienen la palabra no', () => {
  const texto = diffDe({
    '.env.local': ['DB_PASSWORD=Sup3rS3cr3t!', 'MYSQL_ROOT_PASSWORD="Sup3rS3cr3t!"'], // coe:no-secreto (fixture)
    'config/app.yml': ['db_password: Sup3rS3cr3t!', 'smtpPassword = "Sup3rS3cr3t!"', 'maxTokens = 20480000', 'isTokenValid = truthy123'], // coe:no-secreto (fixture)
  })
  assert.deepEqual(
    escaneaSecretos(texto).map((h) => `${h.ruta}:${h.n}`),
    ['.env.local:1', '.env.local:2', 'config/app.yml:1', 'config/app.yml:2'],
  )
})

test('escaneaSecretos: ignora placeholders, referencias al entorno, el marcador coe:no-secreto y los lockfiles', () => {
  const texto = diffDe({
    'src/config.ts': ['const password = process.env.DB_PASSWORD', 'token: "<your-token>"', 'secret: ${SECRET}', 'apiKey: string', 'const password = "Sup3rS3cr3t!" // coe:no-secreto'],
    'docs/setup.md': ['DATABASE_URL=postgres://user:password@localhost:5432/app', 'API_KEY=your-api-key-here'],
    'package-lock.json': ['"integrity": "sha512-Sup3rS3cr3t1234567890abcdefghijklmnop=="', 'password = "Sup3rS3cr3t!"'], // coe:no-secreto (fixture)
  })
  assert.deepEqual(escaneaSecretos(texto), [])
})

test('evaluaContenidoSecreto: FAIL con la lista de ubicaciones y la via de falso positivo', () => {
  const r = evaluaContenidoSecreto(diffDe({ 'a.js': ['const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab"'] })) // coe:no-secreto (fixture)
  assert.equal(r.cumple, false)
  assert.match(r.detalle, /a\.js:1 \(github-token\)/)
  assert.match(r.detalle, /coe:no-secreto/)
  assert.equal(evaluaContenidoSecreto(diffDe({ 'a.js': ['const x = 1'] })).cumple, true)
})

// --- Datos sensibles -----------------------------------------------------------------

test('luhn y pareceTarjeta: tarjetas validas si, PAN de prueba y timestamps no', () => {
  assert.equal(luhn('4539578763621486'), true)
  assert.equal(pareceTarjeta('4539578763621486'), true)
  assert.equal(pareceTarjeta('4539 5787 6362 1486'), true)
  assert.equal(pareceTarjeta('4111111111111111'), false, 'PAN de prueba')
  assert.equal(pareceTarjeta('1696500000000'), false, 'timestamp en ms')
  assert.equal(pareceTarjeta('4539578763621487'), false, 'Luhn invalido')
  assert.equal(pareceTarjeta('4444444444444448'), true)
  assert.equal(pareceTarjeta('0000000000000000'), false)
})

test('motivoArchivoDeDatos: nominas, listados y volcados por nombre; codigo y docs no', () => {
  assert.match(motivoArchivoDeDatos('rrhh/nomina-2026.xlsx'), /nomina/)
  assert.match(motivoArchivoDeDatos('exports/Clientes_activos.csv'), /listado/)
  assert.match(motivoArchivoDeDatos('db/dump-prod.sql'), /volcado/)
  assert.equal(motivoArchivoDeDatos('migrations/001-crear-empleados.sql'), null)
  assert.equal(motivoArchivoDeDatos('docs/empleados.md'), null)
  assert.equal(motivoArchivoDeDatos('src/empleados/empleado.service.ts'), null)
})

test('escaneaDatosSensibles: documentos con palabras de nomina, varios documentos, tarjetas y listados de correos', () => {
  const texto = diffDe({
    'fixtures/empleados.json': ['{"nombre": "Persona Uno", "cuil": "20-12345678-9", "sueldo": 1500000}'],
    'docs/ejemplo.md': ['El CUIT de la empresa es 30-71234567-8 y el del proveedor 30-71234567-9.'],
    'src/pago.test.js': ['const tarjeta = "4539578763621486"'],
    'contactos.txt': Array.from({ length: 8 }, (_, i) => `persona${i}@empresa-real.com`),
    'src/un-documento.ts': ['// el DNI 12345678 es un ejemplo aislado'],
    'tests/fixtures/pagos.json': ['{"card": "4242424242424242"}'],
  })
  const porRuta = Object.fromEntries(escaneaDatosSensibles(texto).map((h) => [h.ruta, h.motivo]))
  assert.match(porRuta['fixtures/empleados.json'], /documento/)
  assert.match(porRuta['docs/ejemplo.md'], /2 documento/)
  assert.match(porRuta['src/pago.test.js'], /tarjeta/)
  assert.match(porRuta['contactos.txt'], /8 correos/)
  assert.equal(porRuta['src/un-documento.ts'], undefined, 'un documento aislado no alcanza')
  assert.equal(porRuta['tests/fixtures/pagos.json'], undefined, 'PAN de prueba')
})

test('escaneaDatosSensibles y evaluaDatosSensibles: .datos-autorizados exime por ruta y por glob', () => {
  const autorizados = leeAutorizados(['# comentario', 'fixtures/empleados.json   # sinteticos — @coord 2026-01-01', 'exports/**/*.csv', ''].join('\n'))
  const texto = diffDe({ 'fixtures/empleados.json': ['{"cuil": "20-12345678-9", "sueldo": 1}'], 'otros/empleados.json': ['{"cuil": "20-12345678-9", "sueldo": 1}'] })
  assert.deepEqual(escaneaDatosSensibles(texto, autorizados).map((h) => h.ruta), ['otros/empleados.json'])

  const r = evaluaDatosSensibles({ archivos: ['exports/2026/clientes.csv', 'rrhh/nomina.xlsx'], textoDiff: '', autorizados })
  assert.equal(r.cumple, false)
  assert.match(r.detalle, /rrhh\/nomina\.xlsx/)
  assert.doesNotMatch(r.detalle, /clientes\.csv/)
  assert.match(r.detalle, /\.datos-autorizados/)
  assert.equal(evaluaDatosSensibles({ archivos: ['src/a.js'], textoDiff: diffDe({ 'src/a.js': ['x'] }) }).cumple, true)
})

test('globARegex: *, ** y directorios', () => {
  assert.ok(globARegex('exports/**/*.csv').test('exports/2026/q1/clientes.csv'))
  assert.ok(globARegex('exports/**/*.csv').test('exports/clientes.csv'))
  assert.ok(!globARegex('exports/*.csv').test('exports/2026/clientes.csv'))
  assert.ok(globARegex('fixtures/').test('fixtures/x/y.json'))
  assert.ok(globARegex('./datos/a.json').test('datos/a.json'))
  assert.ok(!globARegex('datos/a.json').test('datos/a.jsonx'))
})

// --- Utilidades ------------------------------------------------------------------------

test('rutasDeSalidaZ: separa por NUL y descarta vacios y saltos de linea sueltos', () => {
  assert.deepEqual(rutasDeSalidaZ('a.txt\0configuración/.env\0\n\0b/c.json\0'), ['a.txt', 'configuración/.env', 'b/c.json'])
  assert.deepEqual(rutasDeSalidaZ(''), [])
})

test('contextoDelCheck: con PR, base y rama salen del PR; sin PR, del entorno o dev', () => {
  const pr = { baseRefName: 'main', headRefName: 'dev' }
  assert.deepEqual(contextoDelCheck({ pr, envBase: 'dev', ramaLocal: 'fix/otra' }), { base: 'main', rama: 'dev' })
  assert.deepEqual(contextoDelCheck({ envBase: 'main', ramaLocal: 'dev' }), { base: 'main', rama: 'dev' })
  assert.deepEqual(contextoDelCheck({ envBase: '', ramaLocal: 'fix/algo' }), { base: 'dev', rama: 'fix/algo' })
})

test('esperaMergeable: relee mientras GitHub no calculo el estado y se rinde tras los intentos', () => {
  const respuestas = ['UNKNOWN', 'MERGEABLE']
  const esperas = []
  const pr = esperaMergeable({ mergeable: 'UNKNOWN', body: 'x' }, () => respuestas.shift(), (ms) => esperas.push(ms), { esperaMs: 5 })
  assert.equal(pr.mergeable, 'MERGEABLE')
  assert.equal(pr.body, 'x')
  assert.deepEqual(esperas, [5, 5])

  let lecturas = 0
  const rendido = esperaMergeable({ mergeable: 'UNKNOWN' }, () => (lecturas++, 'UNKNOWN'), () => {}, { intentos: 3 })
  assert.equal(rendido.mergeable, 'UNKNOWN')
  assert.equal(lecturas, 3)
})

test('ultimoTagDe: el mayor semver, ignorando el tag movil y los ajenos', () => {
  assert.equal(ultimoTagDe(['v1', 'v1.9.2', 'v1.15.2', 'v1.10.0', 'latest']), 'v1.15.2')
  assert.equal(ultimoTagDe(['v1']), null)
})

test('describeError: gh ausente y errores de git se describen en una linea', () => {
  assert.match(describeError({ code: 'ENOENT', path: 'gh' }), /no se encontro "gh" en el PATH/)
  assert.equal(describeError({ stderr: 'fatal: bad revision\nmas detalle', message: 'Command failed' }), 'fatal: bad revision')
})

// --- Integracion: el script real contra repos git en tmp (con espacios en la
// ruta), sin red. origin/* se simula con update-ref.

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', '-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function repoConBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness check '))
  git(dir, 'init', '-q', '-b', 'dev')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'chore: raiz')
  git(dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD')
  git(dir, 'switch', '-q', '-c', 'fix/algo')
  return dir
}

function commitear(dir, archivos, mensaje) {
  for (const [ruta, contenido] of Object.entries(archivos)) {
    const destino = path.join(dir, ruta)
    if (contenido == null) {
      fs.rmSync(destino)
    } else {
      fs.mkdirSync(path.dirname(destino), { recursive: true })
      fs.writeFileSync(destino, contenido)
    }
  }
  git(dir, 'add', '-A', '--force')
  git(dir, 'commit', '-q', '-m', mensaje)
}

function correrCheck(dir, args, env = process.env) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout }
  } catch (e) {
    return { status: e.status, stdout: e.stdout ?? '' }
  }
}

test('secretos --sin-pushear: detecta el secreto agregado y borrado en commits locales', () => {
  const dir = repoConBase()
  commitear(dir, { 'configuración/.env': 'TOKEN=1\n', 'a.txt': 'a\n' }, 'feat: uno')
  commitear(dir, { 'configuración/.env': null }, 'fix: dos')

  // El diff de arboles no lo ve (el archivo ya no esta en la cabeza)...
  assert.equal(correrCheck(dir, ['--grupo', 'secretos']).status, 0)
  // ...pero el push subiria el commit que lo contiene.
  const r = correrCheck(dir, ['--grupo', 'secretos', '--sin-pushear'])
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /\[FAIL\] sin-secretos: archivos de credenciales en commits sin pushear: configuración\/\.env/)
})

test('secretos --sin-pushear: lo ya pusheado no se vuelve a revisar', () => {
  const dir = repoConBase()
  commitear(dir, { '.env.staging': 'X=1\n' }, 'feat: uno')
  git(dir, 'update-ref', 'refs/remotes/origin/fix/algo', 'HEAD')
  commitear(dir, { 'b.txt': 'b\n' }, 'feat: dos')
  const r = correrCheck(dir, ['--grupo', 'secretos', '--sin-pushear'])
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /\[OK  \] sin-secretos/)
  assert.match(r.stdout, /\[OK  \] sin-secretos-en-contenido/)
  assert.match(r.stdout, /\[OK  \] sin-datos-sensibles/)
})

test('secretos: una credencial en el contenido de un archivo de codigo falla, con ruta y linea', () => {
  const dir = repoConBase()
  commitear(dir, { 'src/config.js': 'export const db = {\n  password: "Sup3rS3cr3t!",\n}\n' }, 'feat: config') // coe:no-secreto (fixture)
  const r = correrCheck(dir, ['--grupo', 'secretos', '--sin-pushear'])
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /\[FAIL\] sin-secretos-en-contenido: .*src\/config\.js:2 \(asignacion-de-secreto\)/)
  // Y tambien en el diff del PR contra la base.
  assert.equal(correrCheck(dir, ['--grupo', 'secretos']).status, 1)
})

test('secretos: una nomina falla por nombre y un fixture con documentos por contenido; .datos-autorizados los exime solo cuando ya esta en dev', () => {
  const dir = repoConBase()
  commitear(dir, { '.datos-autorizados': 'rrhh/nomina-2026.xlsx   # autorizado por Gerencia el 2026-01-01\nfixtures/empleados.json # sinteticos\n' }, 'chore: autorizaciones')
  commitear(dir, { 'rrhh/nomina-2026.xlsx': 'binario falso\n', 'fixtures/empleados.json': '[{"cuil": "20-12345678-9", "sueldo": 1}]\n' }, 'feat: datos')

  // La autorizacion viaja en la misma rama que los datos: no vale todavia, y se reporta como excepcion nueva.
  const r = correrCheck(dir, ['--grupo', 'secretos', '--sin-pushear'])
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /\[FAIL\] sin-datos-sensibles: .*rrhh\/nomina-2026\.xlsx \(nomina/)
  assert.match(r.stdout, /fixtures\/empleados\.json \(1 documento/)
  assert.match(r.stdout, /\[skip\] excepciones-nuevas: .*2 linea\(s\) nueva\(s\) en \.datos-autorizados/)

  // La autorizacion llega a dev (simulado) y los datos vienen despues: ahora si vale.
  git(dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD~1')
  const ok = correrCheck(dir, ['--grupo', 'secretos', '--sin-pushear'])
  assert.equal(ok.status, 0, ok.stdout)
  assert.match(ok.stdout, /\[OK  \] excepciones-nuevas/)
})

// Un tag (o una rama local) llamado "origin/dev" gana la resolucion corta de
// git (DWIM) y podria aportar un .datos-autorizados a medida: el check lee
// siempre refs/remotes/origin/dev por su nombre completo.
test('secretos: un tag llamado origin/dev no sustituye al .datos-autorizados de la rama remota', () => {
  const dir = repoConBase()
  commitear(dir, { '.datos-autorizados': 'rrhh/nomina-2026.xlsx   # "autorizado"\n' }, 'chore: autorizacion a medida')
  git(dir, 'tag', 'origin/dev')
  commitear(dir, { 'rrhh/nomina-2026.xlsx': 'binario falso\n' }, 'feat: datos')
  const r = correrCheck(dir, ['--grupo', 'secretos', '--sin-pushear'])
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /\[FAIL\] sin-datos-sensibles: .*rrhh\/nomina-2026\.xlsx/)
})

// Sin --remerge-diff, `git log -p` no muestra lo que un merge agrego a mano por
// encima del merge automatico: un secreto metido asi pasaba el pre-push.
test('secretos --sin-pushear: un secreto agregado a mano en un merge commit (evil merge) se detecta', () => {
  const dir = repoConBase()
  commitear(dir, { 'a.txt': 'a\n' }, 'feat: a')
  git(dir, 'branch', 'otra', 'origin/dev')
  git(dir, 'switch', '-q', 'otra')
  commitear(dir, { 'b.txt': 'b\n' }, 'feat: b')
  git(dir, 'switch', '-q', 'fix/algo')
  git(dir, 'merge', '-q', '--no-ff', '--no-commit', 'otra')
  fs.writeFileSync(path.join(dir, '.env.staging'), 'TOKEN=x\n')
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'c.js'), 'export const password = "Sup3rS3cr3t!"\n') // coe:no-secreto (fixture)
  git(dir, 'add', '-A', '--force')
  git(dir, 'commit', '-q', '-m', 'Merge otra')

  const r = correrCheck(dir, ['--grupo', 'secretos', '--sin-pushear'])
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /\[FAIL\] sin-secretos: .*\.env\.staging/)
  assert.match(r.stdout, /\[FAIL\] sin-secretos-en-contenido: .*src\/c\.js:1 \(asignacion-de-secreto\)/)
})

test('secretos: una ruta con tildes se detecta y .env.example no', () => {
  const dir = repoConBase()
  commitear(dir, { '.env.example': 'TOKEN=\n' }, 'feat: plantilla de entorno')
  assert.equal(correrCheck(dir, ['--grupo', 'secretos']).status, 0)

  commitear(dir, { 'datos/configuración/credentials.json': '{}\n' }, 'feat: config')
  const r = correrCheck(dir, ['--grupo', 'secretos'])
  assert.equal(r.status, 1, r.stdout)
  assert.match(r.stdout, /datos\/configuración\/credentials\.json/)
})

test('pr-metadata sin gh disponible: [ERROR] y exit 2, no un FAIL de regla', () => {
  const dir = repoConBase()
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness sin gh '))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'))
  env.PATH = vacio
  const r = correrCheck(dir, ['--grupo', 'pr-metadata', '--pr', '1'], env)
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stdout, /^\[ERROR\] pr-metadata: no se pudo verificar: no se encontro "gh"/)
})

test('uso incorrecto: [ERROR] y exit 2', () => {
  const r = correrCheck(repoConBase(), ['--grupo', 'inventado'])
  assert.equal(r.status, 2)
  assert.match(r.stdout, /^\[ERROR\] uso: --grupo debe ser uno de/)
})

// --cabeza termina en git log: nada que git pueda leer como opcion
// (--output=<archivo> escribiria un archivo), salvo --branches/--tags.
test('--cabeza rechaza opciones de git, salvo --branches y --tags', () => {
  const dir = repoConBase()
  const r = correrCheck(dir, ['--grupo', 'secretos', '--sin-pushear', '--cabeza=--output=pwned.txt'])
  assert.equal(r.status, 2)
  assert.ok(!fs.existsSync(path.join(dir, 'pwned.txt')))
  commitear(dir, { '.env.local': 'X=1\n' }, 'feat: x')
  assert.equal(correrCheck(dir, ['--grupo', 'secretos', '--sin-pushear', '--cabeza=--branches']).status, 1)
})

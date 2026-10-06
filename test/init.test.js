import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../src/cli.js'
import { mkRepo, read, has, tree, snapshot, replan, verdicts } from './helpers.js'
import { NOOP, OBSOLETE } from '../src/core/plan.js'
import { missingVars } from '../src/core/render.js'
import { loadManifest } from '../src/core/manifest.js'
import { BEGIN } from '../src/core/block.js'

const YES = ['--yes', '--name', 'acme', '--type', 'backend', '--lang', 'es']

// El catalogo 1.0: cuatro obligatorias (Git, datos sensibles y seguridad) y dos
// opcionales.
const OBLIGATORIAS = ['coe-github', 'datos-sensibles', 'security-audit', 'security-report-standard']
const OPCIONALES = ['adr-new', 'harness-upgrade']
const SKILLS = [...OBLIGATORIAS, ...OPCIONALES]

test('init en repo vacio: emite el harness completo + scaffolding', async () => {
  const dir = mkRepo({ 'README.md': '' })
  assert.equal(await main(['init', ...YES], dir), 0)

  const files = tree(dir)

  // La superficie Claude y la de seguridad.
  for (const f of [
    'CLAUDE.md',
    'notes.md',
    '.claude/settings.json',
    '.claude/harness.json',
    '.claude/hooks/reglas-pr.mjs',
    '.gitignore',
    '.datos-autorizados',
    '.github/pull_request_template.md',
    '.github/CODEOWNERS',
    '.github/workflows/reglas-pr.yml',
    'scripts/check-pr-rules.mjs',
  ]) {
    assert.ok(files.includes(f), `falta ${f}`)
  }

  // Sin --skills, se instalan todas las del catalogo.
  for (const s of SKILLS) {
    assert.ok(files.includes(`.claude/skills/${s}/SKILL.md`), `falta la skill ${s}`)
  }
  assert.ok(files.includes('.claude/skills/security-audit/report-template.md'))
  assert.ok(files.includes('docs/decisions/_template.md'))

  // Scaffolding: solo porque el repo estaba vacio.
  assert.ok(files.includes('src/.gitkeep'))
  assert.ok(files.includes('tests/.gitkeep'))
  assert.ok(files.includes('scripts/.gitkeep'))

  // tag-release esta atado a Node: un repo vacio no tiene stack, no se instala.
  assert.ok(!files.includes('scripts/tag-release.mjs'))
  assert.ok(!files.includes('.github/workflows/tag-release.yml'))
})

test('init: no queda ningun {{PLACEHOLDER}} sin resolver', async () => {
  const dir = mkRepo({ 'README.md': '' })
  await main(['init', ...YES], dir)

  for (const rel of ['CLAUDE.md', 'notes.md', 'README.md']) {
    assert.deepEqual(missingVars(read(dir, rel), {}), [], `${rel} tiene placeholders sin resolver`)
  }
})

test('init: las vars llegan al contenido', async () => {
  const dir = mkRepo({ 'README.md': '' })
  await main(['init', '--yes', '--name', 'facturacion', '--type', 'data', '--lang', 'en'], dir)

  const claudeMd = read(dir, 'CLAUDE.md')
  assert.ok(claudeMd.includes('# CLAUDE.md — facturacion'))
  assert.ok(claudeMd.includes('Proyecto de data.'))
  assert.ok(claudeMd.includes('Responder siempre en inglés.'))
  assert.ok(claudeMd.includes(`coe-harness ${loadManifest().harnessVersion}`))
})

test('init: el settings.json emitido deniega secretos, main y las acciones del coordinador, y registra el hook', async () => {
  const dir = mkRepo({ 'README.md': '' })
  await main(['init', ...YES], dir)

  const settings = JSON.parse(read(dir, '.claude/settings.json'))
  assert.equal(settings.effortLevel, 'medium')
  assert.equal(settings.model, undefined, 'no forzamos modelo a nivel proyecto')

  for (const regla of [
    'Read(./.env)',
    'Read(./secrets/**)',
    'Read(./**/*.pem)',
    'Read(~/.ssh/**)',
    'Bash(git push origin main*)',
    'Bash(git push * *:main*)',
    'Bash(git push --mirror*)',
    'Bash(gh pr merge:*)',
    'Bash(gh repo create:*)',
  ]) {
    assert.ok(settings.permissions.deny.includes(regla), `falta el deny ${regla}`)
  }
  assert.ok(settings.permissions.ask.includes('Bash(git push --force*)'))

  const comandos = JSON.stringify(settings.hooks)
  assert.match(comandos, /reglas-pr\.mjs/)
  assert.ok(settings.hooks.PreToolUse.length >= 1)
  assert.ok(settings.hooks.PostToolUse.length >= 1)
  assert.equal(settings.hooks.SessionStart, undefined, 'no hay hook de sesion: no hay tablero externo que declarar')
})

test('--skills: instala solo lo elegido, pero las obligatorias entran siempre', async () => {
  const dir = mkRepo({ 'README.md': '' })
  assert.equal(await main(['init', ...YES, '--skills', 'adr-new'], dir), 0)

  const files = tree(dir)
  assert.ok(files.includes('.claude/skills/adr-new/SKILL.md'))
  assert.ok(files.includes('docs/decisions/_template.md'))
  for (const s of OBLIGATORIAS) {
    assert.ok(files.includes(`.claude/skills/${s}/SKILL.md`), `la obligatoria ${s} no entro`)
  }
  assert.ok(!files.includes('.claude/skills/harness-upgrade/SKILL.md'))

  // La seleccion queda en el lockfile, y el upgrade la respeta sin re-preguntar.
  const lock = JSON.parse(read(dir, '.claude/harness.json'))
  assert.deepEqual(lock.skills, [...OBLIGATORIAS, 'adr-new'].sort())

  await main(['upgrade', ...YES], dir)
  assert.ok(!has(dir, '.claude/skills/harness-upgrade/SKILL.md'), 'el upgrade instalo una skill no elegida')
})

test('--skills: una skill desconocida corta con error claro', async () => {
  const dir = mkRepo({ 'README.md': '' })
  assert.equal(await main(['init', ...YES, '--skills', 'no-existe'], dir), 1)
  assert.ok(!has(dir, '.claude/harness.json'), 'con error no se escribe nada')
})

test('--skills: deseleccionar una skill opcional la marca obsoleta, no la borra', async () => {
  const dir = mkRepo({ 'README.md': '' })
  await main(['init', ...YES], dir)
  assert.ok(has(dir, '.claude/skills/adr-new/SKILL.md'))

  await main(['upgrade', ...YES, '--skills', 'harness-upgrade'], dir)

  // Sigue en disco: borrar exige --prune.
  assert.ok(has(dir, '.claude/skills/adr-new/SKILL.md'))
  const obsoletos = verdicts(replan(dir))[OBSOLETE] ?? []
  assert.ok(obsoletos.includes('.claude/skills/adr-new/SKILL.md'), 'la skill deseleccionada no quedo obsoleta')
})

test('--skills: una obligatoria no se puede deseleccionar', async () => {
  const dir = mkRepo({ 'README.md': '' })
  await main(['init', ...YES], dir)
  await main(['upgrade', ...YES, '--skills', 'adr-new'], dir)

  for (const s of OBLIGATORIAS) {
    assert.ok(has(dir, `.claude/skills/${s}/SKILL.md`))
  }
  const obsoletos = verdicts(replan(dir))[OBSOLETE] ?? []
  assert.ok(!obsoletos.some((d) => d.includes('coe-github') || d.includes('security-audit') || d.includes('datos-sensibles')))
})

test('se emiten los archivos del flujo Git y de seguridad con sus secciones clave', async () => {
  const dir = mkRepo({ 'README.md': '' })
  await main(['init', ...YES], dir)

  const plantilla = read(dir, '.github/pull_request_template.md')
  for (const seccion of ['## Security review', '## Datos sensibles', '## Requiere versión / release', '## Evidencia']) {
    assert.ok(plantilla.includes(seccion), `la plantilla de PR no tiene ${seccion}`)
  }
  assert.ok(has(dir, '.github/CODEOWNERS'))

  const git = read(dir, '.claude/skills/coe-github/SKILL.md')
  assert.ok(git.includes('Nunca `git push` a `main`'))
  assert.ok(git.includes('security-audit'))

  assert.ok(read(dir, 'CLAUDE.md').includes('Secretos y datos sensibles'))
  assert.ok(read(dir, '.datos-autorizados').includes('NUNCA agrega'))
})

test('el .gitignore emitido excluye credenciales y conserva .env.example', async () => {
  const dir = mkRepo({ 'README.md': '' })
  await main(['init', ...YES], dir)

  const ignore = read(dir, '.gitignore')
  assert.ok(ignore.includes(BEGIN))
  for (const linea of ['.env', '.env.*', '!.env.example', '*.pem', '*.key', '*.pfx', 'credentials.json', '*.tfstate', '.claude/settings.local.json']) {
    assert.ok(ignore.split('\n').includes(linea), `falta "${linea}" en el .gitignore`)
  }
})

test('IDEMPOTENCIA: correr init dos veces no cambia nada la segunda vez', async () => {
  const dir = mkRepo({ 'README.md': '' })

  await main(['init', ...YES], dir)
  const before = snapshot(dir)

  await main(['init', ...YES], dir)
  const after = snapshot(dir)

  assert.equal(after, before, 'la segunda corrida modifico archivos')

  // La prueba real: el plan recomputado no tiene ni una accion de escritura.
  const plan = replan(dir)
  const nonNoop = plan.actions.filter((a) => a.verdict !== NOOP)
  assert.deepEqual(nonNoop.map((a) => `${a.dest}:${a.verdict}`), [], 'quedaron acciones pendientes')
})

// El caso real: un repo recien creado en GitHub trae un README.md de 0 bytes.
// Tratarlo como "archivo del usuario" dejaria un README.md.new al lado para siempre.
test('un archivo vacio se llena, no se le deja un .new al lado', async () => {
  const dir = mkRepo({ 'README.md': '' })
  await main(['init', ...YES], dir)

  assert.ok(!has(dir, 'README.md.new'))
  assert.ok(read(dir, 'README.md').includes('# acme'))

  // Y queda reclamado en el lockfile, asi que la proxima corrida es NOOP.
  const lock = JSON.parse(read(dir, '.claude/harness.json'))
  assert.ok(lock.files['README.md'])
})

test('PUREZA DE --dry-run: no se escribe ni un byte', async () => {
  const dir = mkRepo({ 'README.md': '# mi readme', 'package.json': '{"name":"x"}' })
  const before = snapshot(dir, { includeLockfile: true })

  assert.equal(await main(['init', ...YES, '--dry-run'], dir), 0)

  assert.equal(snapshot(dir, { includeLockfile: true }), before, '--dry-run escribio algo')
  assert.ok(!has(dir, '.claude/harness.json'))
  assert.ok(!has(dir, 'CLAUDE.md'))
})

test('el lockfile registra hash y policy de cada archivo emitido', async () => {
  const dir = mkRepo({ 'README.md': '' })
  await main(['init', ...YES], dir)

  const lock = JSON.parse(read(dir, '.claude/harness.json'))
  assert.equal(lock.harness, 'coe-harness')
  assert.equal(lock.harnessVersion, loadManifest().harnessVersion)
  assert.equal(lock.vars.PROJECT_NAME, 'acme')
  assert.equal(lock.modo, undefined, 'no hay modos de trabajo: una sola superficie')
  assert.equal(lock.files['CLAUDE.md'].policy, 'user-owned')
  assert.equal(lock.files['.datos-autorizados'].policy, 'user-owned')
  assert.equal(lock.files['.claude/skills/coe-github/SKILL.md'].policy, 'managed')
  assert.deepEqual(lock.skills, [...SKILLS].sort())
  assert.ok(lock.blocks['.gitignore'].hash, 'el bloque del .gitignore no quedo registrado')

  // El lockfile refleja el disco: replanificar da NOOP y nada mas.
  assert.deepEqual(Object.keys(verdicts(replan(dir))), [NOOP])
})

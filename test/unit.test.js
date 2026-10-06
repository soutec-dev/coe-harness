import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashContent, normalize } from '../src/core/hash.js'
import { render, missingVars } from '../src/core/render.js'
import { buildBlock, upsertBlock, extractBlock, BEGIN } from '../src/core/block.js'
import { seedMerge } from '../src/core/jsonmerge.js'
import { lt } from '../src/core/lockfile.js'
import { loadManifest, readTemplate } from '../src/core/manifest.js'
import { cuerpoProteccion, motivoDelFallo, fusionarProteccion, proteccionDev } from '../src/core/github-protect.js'
import { destSeguro } from '../src/core/plan.js'

test('hash: CRLF y LF dan el mismo hash', () => {
  assert.equal(hashContent('a\r\nb\r\n'), hashContent('a\nb\n'))
  assert.equal(hashContent('a\nb'), hashContent('a\nb\n\n'))
  assert.equal(normalize('x\r\ny\n'), 'x\ny')
})

test('hash: contenido distinto da hash distinto', () => {
  assert.notEqual(hashContent('a'), hashContent('b'))
})

test('render: sustituye vars y deja intacto lo que no conoce', () => {
  assert.equal(render('hola {{NAME}}', { NAME: 'mundo' }), 'hola mundo')
  assert.equal(render('{{UNKNOWN}}', {}), '{{UNKNOWN}}')
  assert.deepEqual(missingVars('{{A}} {{B}}', { A: 1 }), ['B'])
})

test('block: upsert reemplaza in-place, no duplica, y el marcador es el de coe-harness', () => {
  assert.equal(BEGIN, '# >>> coe-harness >>>')
  const v1 = buildBlock(['node_modules/'], '1.0.0')
  const v2 = buildBlock(['node_modules/', 'dist/'], '1.1.0')

  const original = '# mis reglas\n*.tmp\ncustom/'
  const once = upsertBlock(original, v1)
  const twice = upsertBlock(once, v2)

  // Las lineas del usuario sobreviven intactas.
  assert.ok(twice.includes('# mis reglas'))
  assert.ok(twice.includes('*.tmp'))
  assert.ok(twice.includes('custom/'))

  // Un solo bloque, no dos.
  assert.equal(twice.split(BEGIN).length - 1, 1)
  assert.ok(twice.includes('dist/'))
  assert.equal(extractBlock(twice), v2)
})

test('block: en archivo inexistente escribe solo el bloque', () => {
  const block = buildBlock(['x'], '1.0.0')
  assert.equal(upsertBlock(null, block), block)
})

test('seedMerge: nunca pisa un valor que el usuario escribio', () => {
  const user = { effortLevel: 'xhigh', permissions: { deny: ['Read(./mi-secreto)'] } }
  const seed = { effortLevel: 'medium', permissions: { deny: ['Read(./.env)'], ask: ['Bash(git push:*)'] } }
  const out = seedMerge(user, seed)

  assert.equal(out.effortLevel, 'xhigh')
  assert.deepEqual(out.permissions.deny, ['Read(./mi-secreto)', 'Read(./.env)'])
  assert.deepEqual(out.permissions.ask, ['Bash(git push:*)'])
})

test('seedMerge: sin archivo previo devuelve el seed entero', () => {
  assert.deepEqual(seedMerge(null, { a: 1 }), { a: 1 })
})

// El bloque PreToolUse/PostToolUse del harness llega a los consumidores por
// merge-json. Tiene que convivir con hooks propios del usuario y no duplicarse
// en cada upgrade.
test('seedMerge: los hooks del harness se suman a los del usuario y no se duplican', () => {
  const seed = JSON.parse(readTemplate('base/claude/settings.json'))
  const propio = { matcher: 'Edit', hooks: [{ type: 'command', command: 'node mi-hook.mjs' }] }
  const user = { hooks: { PreToolUse: [propio] } }

  const una = seedMerge(user, seed)
  assert.deepEqual(una.hooks.PreToolUse[0], propio, 'el hook del usuario queda primero')
  assert.equal(una.hooks.PreToolUse.length, 1 + seed.hooks.PreToolUse.length)
  assert.deepEqual(una.hooks.PostToolUse, seed.hooks.PostToolUse)
  assert.deepEqual(seedMerge(una, seed), una, 'un segundo upgrade no cambia nada')
})

test('lt: comparacion semver', () => {
  assert.ok(lt('0.0.0', '1.0.0'))
  assert.ok(lt('1.0.0', '1.0.1'))
  assert.ok(!lt('1.0.0', '1.0.0'))
  assert.ok(!lt('2.0.0', '1.9.9'))
})

test('manifest: todos los templates declarados existen en disco', () => {
  const manifest = loadManifest()
  for (const f of manifest.files) {
    if (f.policy === 'append-block') continue
    assert.doesNotThrow(() => readTemplate(f.src), `falta el template ${f.src}`)
  }
})

test('manifest: ningun dest con dos entries, salvo merge-json (se funden en computePlan)', () => {
  const byDest = new Map()
  for (const f of loadManifest().files) {
    const group = byDest.get(f.dest) ?? []
    group.push(f)
    byDest.set(f.dest, group)
  }
  for (const [dest, group] of byDest) {
    if (group.length < 2) continue
    assert.ok(group.every((f) => f.policy === 'merge-json'), `dest duplicado: "${dest}"`)
  }
})

// La proteccion de main que init/upgrade aplican en GitHub: PR obligatorio con
// el check de reglas-pr en verde, tambien para admins, sin force-push ni borrado.
test('github-protect: el cuerpo de la proteccion exige PR, el check reglas-pr y alcanza a admins', () => {
  const cuerpo = JSON.parse(cuerpoProteccion())
  assert.equal(cuerpo.enforce_admins, true)
  assert.equal(cuerpo.allow_force_pushes, false)
  assert.equal(cuerpo.allow_deletions, false)
  assert.deepEqual(cuerpo.required_status_checks.checks, [{ context: 'reglas-pr' }])
  assert.equal(cuerpo.required_status_checks.strict, true)
  assert.ok(cuerpo.required_pull_request_reviews)
})

// PUT reemplaza la proteccion entera: lo que el equipo endurecio a mano
// (aprobaciones, code owners, checks extra, restricciones) tiene que sobrevivir
// a cada upgrade; lo que el harness exige se impone aunque estuviera relajado.
test('fusionarProteccion: sin proteccion previa devuelve la base; con una mas estricta nunca la rebaja', () => {
  assert.deepEqual(fusionarProteccion(null), JSON.parse(cuerpoProteccion()))
  const existente = {
    required_status_checks: { strict: false, contexts: ['ci'], checks: [{ context: 'ci', app_id: 15368 }] },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: {
      required_approving_review_count: 2,
      require_code_owner_reviews: true,
      dismiss_stale_reviews: true,
      require_last_push_approval: false,
      dismissal_restrictions: { users: [{ login: 'coord' }], teams: [] },
    },
    required_conversation_resolution: { enabled: true },
    required_linear_history: { enabled: false },
    restrictions: { users: [{ login: 'coord' }], teams: [{ slug: 'core' }], apps: [] },
    allow_force_pushes: { enabled: true },
    allow_deletions: { enabled: true },
  }
  const f = fusionarProteccion(existente)
  assert.deepEqual(f.required_status_checks, { strict: true, checks: [{ context: 'ci' }, { context: 'reglas-pr' }] })
  assert.equal(f.required_pull_request_reviews.required_approving_review_count, 2)
  assert.equal(f.required_pull_request_reviews.require_code_owner_reviews, true)
  assert.equal(f.required_pull_request_reviews.dismiss_stale_reviews, true)
  assert.deepEqual(f.required_pull_request_reviews.dismissal_restrictions, { users: ['coord'], teams: [] })
  assert.equal(f.required_conversation_resolution, true)
  assert.equal(f.required_linear_history, undefined)
  assert.deepEqual(f.restrictions, { users: ['coord'], teams: ['core'], apps: [] })
  assert.equal(f.enforce_admins, true)
  assert.equal(f.allow_force_pushes, false)
  assert.equal(f.allow_deletions, false)
  // dev: solo lo irreversible, sin PR obligatorio (el bump de version se commitea ahi).
  assert.deepEqual(proteccionDev(), { required_status_checks: null, enforce_admins: false, required_pull_request_reviews: null, restrictions: null, allow_force_pushes: false, allow_deletions: false })
})

test('destSeguro: solo rutas relativas POSIX dentro del repo', () => {
  for (const ok of ['CLAUDE.md', '.claude/settings.json', 'docs/decisions/x.md', 'a.b/c']) assert.equal(destSeguro(ok), true, ok)
  for (const mal of ['../fuera.txt', 'docs/../../x', '/etc/passwd', 'C:/x', 'a\\b', '.git/HEAD', './a', 'a//b', '', null]) assert.equal(destSeguro(mal), false, String(mal))
})

// Un repo privado en un plan Free no tiene branch protection: no es un permiso
// que falte y el mensaje no puede mandar a nadie a buscarlo.
test('github-protect: distingue la limitacion de plan Free del permiso faltante', () => {
  assert.equal(motivoDelFallo({ stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\n' }), 'plan')
  assert.equal(motivoDelFallo({ stderr: 'gh: Must have admin rights to Repository. (HTTP 403)\n' }), 'permiso')
  assert.equal(motivoDelFallo({ stderr: 'gh: Not Found (HTTP 404)\n' }), 'permiso')
  assert.equal(motivoDelFallo({ message: 'spawnSync gh ETIMEDOUT' }), 'otro')
})

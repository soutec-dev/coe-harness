import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashContent, normalize } from '../src/core/hash.js'
import { render, missingVars } from '../src/core/render.js'
import { buildBlock, upsertBlock, extractBlock, BEGIN } from '../src/core/block.js'
import { seedMerge } from '../src/core/jsonmerge.js'
import { lt } from '../src/core/lockfile.js'
import { loadManifest, readTemplate } from '../src/core/manifest.js'
import { cuerpoProteccion } from '../src/core/github-protect.js'

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

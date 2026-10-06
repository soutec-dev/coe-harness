import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { main } from '../src/cli.js'
import { mkRepo, read, write, has, snapshot, replan, verdicts } from './helpers.js'
import { OBSOLETE, NOOP, computePlan } from '../src/core/plan.js'
import { resolveDetected } from '../src/core/detect.js'
import { hashContent } from '../src/core/hash.js'

const YES = ['--yes', '--name', 'kit', '--type', 'backend', '--lang', 'es']

// Un repo con una estructura previa hecha a mano: un CLAUDE.md propio y un
// settings.json con una clave que el usuario eligio.
function repoPrevio() {
  return mkRepo({
    'package.json': '{"name":"proyecto-previo"}',
    'CLAUDE.md': '# CLAUDE.md — Proyecto previo\n\n## Reglas de la casa\nNunca tocar la tabla pagos.\n',
    '.claude/settings.json': JSON.stringify({ effortLevel: 'xhigh' }, null, 2),
    '.gitignore': 'node_modules/\n',
  })
}

test('upgrade sobre una estructura previa: el CLAUDE.md hecho a mano NO se pisa', async () => {
  const dir = repoPrevio()
  const original = read(dir, 'CLAUDE.md')

  assert.equal(await main(['upgrade', ...YES], dir), 0)

  assert.equal(read(dir, 'CLAUDE.md'), original)
  assert.ok(has(dir, 'CLAUDE.md.new'))
  assert.ok(read(dir, 'CLAUDE.md.new').includes('## Secretos y datos sensibles'))
})

test('upgrade sobre una estructura previa: el settings.json conserva lo del usuario y suma lo del harness', async () => {
  const dir = repoPrevio()
  await main(['upgrade', ...YES], dir)

  const settings = JSON.parse(read(dir, '.claude/settings.json'))
  // El dev eligio xhigh. Un upgrade no tiene derecho a devolverselo a medium.
  assert.equal(settings.effortLevel, 'xhigh')
  assert.ok(settings.permissions.deny.includes('Read(./.env)'))
  assert.ok(JSON.stringify(settings.hooks).includes('reglas-pr.mjs'))
})

test('upgrade sobre una estructura previa: lo que faltaba se crea y hay backup de lo sobrescrito', async () => {
  const dir = repoPrevio()
  await main(['upgrade', ...YES], dir)

  for (const s of ['coe-github', 'datos-sensibles', 'security-audit', 'security-report-standard', 'adr-new', 'harness-upgrade']) {
    assert.ok(has(dir, `.claude/skills/${s}/SKILL.md`), `no se creo la skill ${s}`)
  }

  const backups = fs.readdirSync(path.join(dir, '.claude')).filter((e) => e.startsWith('backup-'))
  assert.equal(backups.length, 1, 'no se creo el directorio de backup')
  // settings.json fue sobrescrito (merge), asi que su version previa tiene que estar guardada.
  const previo = JSON.parse(read(dir, `.claude/${backups[0]}/.claude/settings.json`))
  assert.deepEqual(previo, { effortLevel: 'xhigh' })
})

test('adopt: escribe el lockfile y no toca ni un archivo', async () => {
  const dir = repoPrevio()
  const antes = snapshot(dir, { includeLockfile: true })

  assert.equal(await main(['adopt', ...YES], dir), 0)

  const despues = snapshot(dir, { includeLockfile: false })
  assert.equal(despues, antes, 'adopt modifico un archivo')
  assert.ok(has(dir, '.claude/harness.json'))

  const lock = JSON.parse(read(dir, '.claude/harness.json'))
  assert.equal(lock.adopted, true)
  assert.equal(lock.harnessVersion, '0.0.0')

  // Nada coincide byte a byte con el harness, asi que el lockfile no reclama
  // nada. Reclamar un archivo modificado seria autorizar al upgrade a pisarlo.
  assert.equal(lock.files['CLAUDE.md'], undefined)
  assert.equal(lock.files['.claude/settings.json'], undefined)
})

test('upgrade despues de adopt: converge y queda idempotente', async () => {
  const dir = repoPrevio()
  await main(['adopt', ...YES], dir)
  await main(['upgrade', ...YES], dir)

  const estable = snapshot(dir)
  await main(['upgrade', ...YES], dir)
  assert.equal(snapshot(dir), estable, 'el segundo upgrade no fue idempotente')

  // Lo unico que queda pendiente es el CLAUDE.md del usuario (que nunca se pisa).
  const pendientes = Object.keys(verdicts(replan(dir))).filter((v) => v !== NOOP)
  assert.deepEqual(pendientes.sort(), ['foreign'])
})

// Un obsoleto de verdad (declarado en el lockfile, ya no en el manifest): si el
// contenido en disco sigue siendo exactamente lo que el harness escribio, es
// contenido del harness y --prune lo borra sin pedir confirmacion (autoPrune).
// Si el usuario lo edito, --prune exige la confirmacion escrita.
test('computePlan: obsoleto sin editar (hash intacto) se marca autoPrune, editado no', () => {
  const contenidoOriginal = 'contenido que escribio el harness\n'
  const dir = mkRepo({ 'viejo/intacto.md': contenidoOriginal, 'viejo/editado.md': 'lo que el usuario dejo\n' })
  const manifest = { harnessVersion: '1.0.0', files: [], obsolete: [] }
  const lock = {
    harnessVersion: '1.0.0',
    files: {
      'viejo/intacto.md': { policy: 'managed', hash: hashContent(contenidoOriginal) },
      'viejo/editado.md': { policy: 'managed', hash: hashContent('contenido que escribio el harness, version anterior\n') },
    },
  }
  const detected = resolveDetected(dir, null)

  const plan = computePlan({ manifest, cwd: dir, lock, vars: {}, detected })
  const porDest = Object.fromEntries(plan.actions.map((a) => [a.dest, a]))

  assert.equal(porDest['viejo/intacto.md'].verdict, OBSOLETE)
  assert.equal(porDest['viejo/intacto.md'].autoPrune, true)

  assert.equal(porDest['viejo/editado.md'].verdict, OBSOLETE)
  assert.equal(porDest['viejo/editado.md'].autoPrune, false)
})

test('upgrade --prune: borra el obsoleto intacto sin preguntar (con backup) y respeta el editado', async () => {
  const dir = mkRepo({ 'README.md': '' })
  await main(['init', ...YES], dir)

  write(dir, 'viejo/intacto.md', 'contenido del harness\n')
  write(dir, 'viejo/editado.md', 'lo que el usuario dejo\n')
  const lock = JSON.parse(read(dir, '.claude/harness.json'))
  lock.files['viejo/intacto.md'] = { policy: 'managed', hash: hashContent('contenido del harness\n') }
  lock.files['viejo/editado.md'] = { policy: 'managed', hash: hashContent('otra cosa\n') }
  write(dir, '.claude/harness.json', JSON.stringify(lock, null, 2))

  // CI=true: la confirmacion escrita del editado se niega sola.
  assert.equal(await main(['upgrade', ...YES, '--prune'], dir), 0)

  assert.ok(!has(dir, 'viejo/intacto.md'), 'el obsoleto intacto no se borro')
  assert.ok(has(dir, 'viejo/editado.md'), 'el obsoleto editado se borro sin confirmacion')

  const backups = fs.readdirSync(path.join(dir, '.claude')).filter((e) => e.startsWith('backup-'))
  assert.equal(backups.length, 1)
  assert.ok(has(dir, `.claude/${backups[0]}/viejo/intacto.md`), 'no hay backup del borrado')

  // El borrado salio del lockfile; el editado sigue registrado para seguir avisando.
  const despues = JSON.parse(read(dir, '.claude/harness.json'))
  assert.equal(despues.files['viejo/intacto.md'], undefined)
  assert.ok(despues.files['viejo/editado.md'])
})

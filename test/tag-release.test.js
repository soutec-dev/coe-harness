import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { versionDePackageJson, tagInmutable, tagMovil } from '../scripts/tag-release.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/tag-release.mjs', import.meta.url))

test('versionDePackageJson: lee la version SemVer del package.json y rechaza lo que no lo es', () => {
  assert.equal(versionDePackageJson('{"version": "1.6.0"}'), '1.6.0')
  assert.throws(() => versionDePackageJson('{}'), /versión SemVer válida/)
  assert.throws(() => versionDePackageJson('{"version": "v1.6"}'), /versión SemVer válida/)
})

test('tagInmutable y tagMovil', () => {
  assert.equal(tagInmutable('1.6.0'), 'v1.6.0')
  assert.equal(tagMovil('1.6.0'), 'v1')
  assert.equal(tagMovil('10.2.1'), 'v10')
})

// --- Integracion: el agente corre el script en SU maquina tras el merge de
// release (repos sin Actions). Ahi el tag movil local suele estar viejo, y
// "git fetch --tags" sin --force moria con "would clobber existing tag" antes
// de crear nada. Remoto bare local, sin red.

const IDENTIDAD = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test',
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...IDENTIDAD },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function commitearVersion(dir, version) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }) + '\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', `chore: release v${version}`)
  git(dir, 'push', '-q', 'origin', 'HEAD:main')
  return git(dir, 'rev-parse', 'HEAD')
}

function correrTagRelease(dir, args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTIDAD },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('tag-release --ref origin/main: taggea el release con el tag movil local viejo y sin cambiar de rama', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness tags '))
  const remoto = path.join(base, 'remoto.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remoto])

  // Quien publico releases anteriores.
  const publicador = path.join(base, 'publicador')
  execFileSync('git', ['clone', '-q', remoto, publicador], { stdio: 'ignore' })
  const c1 = commitearVersion(publicador, '1.0.1')
  git(publicador, 'tag', '-a', 'v1.0.1', '-m', 'Release v1.0.1')
  git(publicador, 'tag', '-a', 'v1', '-m', 'Release v1.0.1')
  git(publicador, 'push', '-q', 'origin', 'v1.0.1', 'v1')

  // La maquina del dev: clona con v1 -> 1.0.1...
  const dev = path.join(base, 'maquina del dev')
  execFileSync('git', ['clone', '-q', remoto, dev], { stdio: 'ignore' })
  assert.equal(git(dev, 'rev-parse', 'v1^{commit}'), c1)

  // ...y despues el remoto avanza: otro release movio v1, y ahora se mergea el nuevo.
  const c2 = commitearVersion(publicador, '1.0.2')
  git(publicador, 'tag', '-a', 'v1.0.2', '-m', 'Release v1.0.2')
  git(publicador, 'tag', '-f', '-a', 'v1', '-m', 'Release v1.0.2', c2)
  git(publicador, 'push', '-q', 'origin', 'v1.0.2')
  git(publicador, 'push', '-q', '--force', 'origin', 'v1')
  const c3 = commitearVersion(publicador, '1.1.0')

  // El dev esta en otra rama, con otra version en su arbol: --ref no la mira.
  git(dev, 'switch', '-q', '-c', 'fix/otra-cosa')
  fs.writeFileSync(path.join(dev, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }) + '\n')
  git(dev, 'fetch', '-q', 'origin')

  const salida = correrTagRelease(dev, ['--ref', 'origin/main'])
  assert.match(salida, /\[OK\] v1\.1\.0 creado y pusheado/)
  assert.match(salida, /\[OK\] v1 apunta ahora a v1\.1\.0/)

  const remotos = git(publicador, 'ls-remote', '--tags', 'origin')
  assert.match(remotos, new RegExp(`^${c3}\\s+refs/tags/v1\\.1\\.0\\^\\{\\}$`, 'm'))
  assert.match(remotos, new RegExp(`^${c3}\\s+refs/tags/v1\\^\\{\\}$`, 'm'))
  assert.equal(git(dev, 'branch', '--show-current'), 'fix/otra-cosa', 'el script no cambio de rama')
  assert.equal(git(dev, 'cat-file', '-t', 'v1.1.0'), 'tag', 'el tag inmutable es anotado')

  // Idempotente: una segunda corrida no duplica ni falla.
  const otra = correrTagRelease(dev, ['--ref', 'origin/main'])
  assert.match(otra, /\[skip\] v1\.1\.0 ya existe/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { main } from '../src/cli.js'
import { mkRepo, has, replan } from './helpers.js'

const YES = ['--yes', '--name', 'acme', '--type', 'backend', '--lang', 'es']

const TAG_RELEASE_DESTS = ['scripts/tag-release.mjs', '.github/workflows/tag-release.yml']

test('tag-release: se instala en un repo Node (package.json presente)', async () => {
  const dir = mkRepo({ 'package.json': '{"name": "acme", "version": "1.0.0"}' })
  assert.equal(await main(['init', ...YES], dir), 0)

  for (const dest of TAG_RELEASE_DESTS) {
    assert.ok(has(dir, dest), `falta ${dest} en un repo Node`)
  }

  // Replanificar contra lo ya instalado: nada pendiente, nada marcado como
  // saltado por stack -- el repo sigue siendo Node.
  const plan = replan(dir)
  assert.deepEqual(plan.skippedByStack, [])
})

test('tag-release: NO se instala en un repo sin stack Node, y se reporta como saltado por stack', async () => {
  const dir = mkRepo({ 'pyproject.toml': '[project]\nname = "acme"\nversion = "1.0.0"\n' })
  assert.equal(await main(['init', ...YES], dir), 0)

  for (const dest of TAG_RELEASE_DESTS) {
    assert.ok(!has(dir, dest), `${dest} no deberia instalarse en un repo Python`)
  }

  const plan = replan(dir)
  const skippedDests = plan.skippedByStack.map((s) => s.dest).sort()
  assert.deepEqual(skippedDests, [...TAG_RELEASE_DESTS].sort())
  assert.ok(plan.skippedByStack.every((s) => s.stack === 'node'))
})

test('tag-release: tampoco se instala en un repo sin ninguna senal de stack', async () => {
  const dir = mkRepo({ 'README.md': '' })
  const plan = replan(dir)

  const skippedDests = plan.skippedByStack.map((s) => s.dest).sort()
  assert.deepEqual(skippedDests, [...TAG_RELEASE_DESTS].sort())
})

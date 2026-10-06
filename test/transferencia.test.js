import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../src/cli.js'
import { mkRepo, read, tree } from './helpers.js'

const YES = ['--yes', '--name', 'acme', '--type', 'backend', '--lang', 'es']

// La razon de ser de este harness: lo que instala en un proyecto no depende de
// ninguna herramienta interna de la organizacion que lo creo (tablero de
// milestones, espejos en trackers, vault de documentacion, monitores). Un repo
// instalado se puede transferir a otro equipo u otra empresa tal cual. La unica
// referencia externa permitida es la URL del propio harness, para `upgrade`.
const PROHIBIDO = /soubunker|jira|azure devops|azdo|souclaude|vault\.local|Project-<PREFIJO>|milestone|kanban|observatorio|soutec(?!dev\/coe-harness)/i

test('transferibilidad: ningun archivo emitido menciona herramientas internas de la organizacion de origen', async () => {
  const dir = mkRepo({ 'package.json': '{"name":"acme","version":"1.0.0"}' })
  assert.equal(await main(['init', ...YES], dir), 0)

  const emitidos = tree(dir).filter((rel) => rel !== 'package.json')
  assert.ok(emitidos.length > 20)
  for (const rel of emitidos) {
    const contenido = read(dir, rel)
    const m = contenido.match(PROHIBIDO)
    assert.equal(m, null, `${rel} menciona "${m?.[0]}"`)
  }
})

test('transferibilidad: el harness no pide ni escribe configuracion fuera del repo', async () => {
  const dir = mkRepo({ 'README.md': '' })
  assert.equal(await main(['init', ...YES], dir), 0)
  const emitidos = tree(dir)
  assert.ok(!emitidos.some((f) => /vault|mcp\.json|jira|azdo/i.test(f)), emitidos.join('\n'))
  const lock = JSON.parse(read(dir, '.claude/harness.json'))
  assert.deepEqual(Object.keys(lock.vars).sort(), ['HARNESS_VERSION', 'LANGUAGE', 'OWNER', 'PROJECT_NAME', 'PROJECT_TYPE', 'STACK'])
})

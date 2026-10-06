import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { loadManifest, readTemplate } from '../src/core/manifest.js'
import { toPosix } from '../src/core/fsx.js'
import { hashContent } from '../src/core/hash.js'

// Este test responde una pregunta distinta a la de verify.test.js: no si el
// manifest es internamente consistente, sino si ESTE repo (el generador,
// via dogfooding) practica lo que instala. Compara .claude/** real contra
// manifest.files[].dest; lo que sobra debe estar explicitamente reconocido
// como extension local del propio repo generador, no del harness distribuido.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const LOCAL_ONLY = new Set([
  '.claude/harness.json', // lockfile de este propio repo, no un template
  '.claude/scheduled_tasks.lock', // generado en runtime por Claude Code
  '.claude/settings.local.json', // config local del dev, ya ignorada por el .gitignore que emite el harness
])

// git ls-files, no fs.readdirSync: el disco tiene backups (.claude/backup-*/) y
// propuestas pendientes (*.new) que el propio harness genera y el propio
// .gitignore excluye a proposito.
function walkClaudeDir() {
  const out = execFileSync('git', ['ls-files', '.claude'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .filter(Boolean)
    .map((rel) => toPosix(rel))
}

test('dogfood: todo archivo de .claude/ del repo esta en el manifest o en LOCAL_ONLY', () => {
  const manifest = loadManifest()
  const declared = new Set(manifest.files.map((f) => f.dest))

  const unrecognized = walkClaudeDir().filter((rel) => !declared.has(rel) && !LOCAL_ONLY.has(rel))

  assert.deepEqual(
    unrecognized,
    [],
    `Archivo(s) bajo .claude/ sin entry en el manifest ni en LOCAL_ONLY: ${unrecognized.join(', ')}`
  )
})

// Las copias distribuidas de los archivos managed no pueden derivar de lo que
// este repo aplica sobre si mismo: si alguien toca una copia y no la otra, los
// consumidores reciben una version distinta de la que el generador practica.
test('dogfood: las copias managed de este repo son identicas a sus templates', () => {
  const manifest = loadManifest()
  const managed = manifest.files.filter((f) => f.policy === 'managed' && !f.binary && !f.render)
  assert.ok(managed.length > 5)
  for (const entry of managed) {
    let local
    try {
      local = readFileSync(new URL(`../${entry.dest}`, import.meta.url), 'utf8')
    } catch {
      continue // entries condicionales (when) que este repo no tiene
    }
    assert.equal(hashContent(local), hashContent(readTemplate(entry.src)), `${entry.dest} difiere de templates/${entry.src}`)
  }
})

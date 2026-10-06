import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadManifest } from '../src/core/manifest.js'
import {
  verifyManifest,
  findOrphanTemplateFiles,
  findOrphanFragments,
  findMissingSrcFiles,
  findDuplicateIds,
  findDuplicateDests,
  findMissingCriticalFiles,
  findUnsafeDests,
} from '../src/core/verify.js'

// Fabrica un directorio temporal con la forma de templates/: root/base/**.
// No se toca templates/ real en ningun caso negativo.
function mkTemplatesRoot(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness verify '))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  return root
}

test('verify: el manifest real del repo no tiene huerfanos', () => {
  assert.deepEqual(findOrphanTemplateFiles(loadManifest()), [])
})

test('verify: el manifest real del repo no tiene src rotos', () => {
  assert.deepEqual(findMissingSrcFiles(loadManifest()), [])
})

test('verify: el manifest real del repo no tiene ids ni dest duplicados', () => {
  const manifest = loadManifest()
  assert.deepEqual(findDuplicateIds(manifest), [])
  assert.deepEqual(findDuplicateDests(manifest), [])
})

test('verify: el manifest real del repo no tiene criticos faltantes', () => {
  assert.deepEqual(findMissingCriticalFiles(loadManifest()), [])
})

test('verify: los fragmentos reales de gitignore corresponden todos a base o a un stack', () => {
  assert.deepEqual(findOrphanFragments(), [])
})

test('verify: el manifest real no tiene dest inseguros, y uno con ".." o bajo .git/ es error', () => {
  assert.deepEqual(findUnsafeDests(loadManifest()), [])
  const manifest = { files: [{ id: 'x', src: 'base/x', dest: '../x', policy: 'managed' }], obsolete: [{ dest: '.git/config', reason: 'r' }] }
  assert.equal(findUnsafeDests(manifest).length, 2)
  assert.ok(findUnsafeDests(manifest).every((e) => e.code === 'unsafe-dest'))
})

test('verify: harnessVersion del manifest coincide con la version de package.json', () => {
  const manifest = loadManifest()
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.harnessVersion, pkg.version)
})

test('verify: las skills obligatorias del manifest son las de Git, datos sensibles y seguridad', () => {
  const required = loadManifest().skills.filter((s) => s.required).map((s) => s.id).sort()
  assert.deepEqual(required, ['coe-github', 'datos-sensibles', 'security-audit', 'security-report-standard'])
})

test('verify: detecta un fragmento de gitignore que no corresponde a ningun stack', () => {
  const root = mkTemplatesRoot({ 'fragments/gitignore/base.txt': 'x', 'fragments/gitignore/cobol.txt': 'y' })
  const warnings = findOrphanFragments(root)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].code, 'orphan-gitignore-fragment')
  assert.match(warnings[0].message, /cobol\.txt/)
})

test('verify: detecta huerfano cuando templates/base tiene un archivo sin entry', () => {
  const root = mkTemplatesRoot({ 'base/claude/skills/fantasma/SKILL.md': 'x' })
  const warnings = findOrphanTemplateFiles({ files: [] }, root)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].code, 'orphan-template-file')
})

test('verify: detecta src roto cuando el manifest referencia un archivo inexistente', () => {
  const root = mkTemplatesRoot({})
  const manifest = { files: [{ id: 'x', src: 'base/no-existe.md', dest: 'no-existe.md', policy: 'managed' }] }
  const errors = findMissingSrcFiles(manifest, root)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'missing-src')
})

test('verify: detecta ids y dest duplicados', () => {
  const manifest = {
    files: [
      { id: 'a', src: 'base/a.md', dest: 'a.md', policy: 'managed' },
      { id: 'a', src: 'base/b.md', dest: 'a.md', policy: 'managed' },
    ],
  }
  assert.equal(findDuplicateIds(manifest).length, 1)
  assert.equal(findDuplicateDests(manifest).length, 1)
})

test('verify: dest duplicado no es error cuando todos los entries son merge-json (se funden en computePlan)', () => {
  const manifest = {
    files: [
      { id: 'mcp-a', src: 'base/a.json', dest: '.mcp.json', policy: 'merge-json', skill: 'a' },
      { id: 'mcp-b', src: 'base/b.json', dest: '.mcp.json', policy: 'merge-json', skill: 'b' },
    ],
  }
  assert.equal(findDuplicateDests(manifest).length, 0)
})

test('verify: dest duplicado SI es error si alguno de los entries no es merge-json', () => {
  const manifest = {
    files: [
      { id: 'mcp-a', src: 'base/a.json', dest: '.mcp.json', policy: 'merge-json' },
      { id: 'mcp-managed', src: 'base/b.json', dest: '.mcp.json', policy: 'managed' },
    ],
  }
  assert.equal(findDuplicateDests(manifest).length, 1)
})

test('verify: detecta critico faltante cuando el src del entry critical no existe', () => {
  const root = mkTemplatesRoot({})
  const manifest = { files: [{ id: 'claude-md', src: 'base/CLAUDE.md', dest: 'CLAUDE.md', policy: 'user-owned', critical: true }] }
  const errors = findMissingCriticalFiles(manifest, root)
  assert.ok(errors.some((e) => e.code === 'missing-critical'))
})

test('verifyManifest: agrega en errors y warnings, no mezcla tipos', () => {
  const root = mkTemplatesRoot({ 'base/huerfano.md': 'x' })
  const manifest = { files: [{ id: 'roto', src: 'base/no-existe.md', dest: 'no-existe.md', policy: 'managed' }] }
  const { errors, warnings } = verifyManifest(manifest, root)
  assert.ok(errors.every((e) => e.type === 'error'))
  assert.ok(warnings.every((w) => w.type === 'warning'))
  assert.ok(errors.some((e) => e.code === 'missing-src'))
  assert.ok(warnings.some((w) => w.code === 'orphan-template-file'))
})

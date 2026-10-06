import fs from 'node:fs'
import path from 'node:path'
import { TEMPLATES_DIR } from './manifest.js'
import { toPosix } from './fsx.js'
import { SIGNATURES } from './detect.js'
import { destSeguro } from './plan.js'

export const ERROR = 'error'
export const WARNING = 'warning'

// Rutas del propio generador (el CLI, no lo que instala). No van en el manifest
// porque el manifest describe el harness que se distribuye a un proyecto
// consumidor, no la anatomia del generador.
const GENERATOR_CRITICAL_FILES = ['package.json', 'bin/cli.mjs', 'templates/harness.manifest.json']

// Camina un subdirectorio de templates/ y devuelve rutas POSIX relativas a
// templates/ (ej. "base/claude/skills/coe-github/SKILL.md"). `root` es
// inyectable para poder testear con un directorio temporal fabricado a mano.
export function walkTemplateFiles(subdir = 'base', root = TEMPLATES_DIR) {
  const out = []
  const abs = path.join(root, subdir)
  const walk = (cur, prefix) => {
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(cur, e.name), rel)
      else out.push(toPosix(`${subdir}/${rel}`))
    }
  }
  walk(abs, '')
  return out
}

// Archivos fisicos en templates/base/** sin ningun entry en manifest.files[]
// que los referencie por `src`. Es basura acumulandose: nadie los borra, pero
// tampoco se instalan en ningun proyecto consumidor.
export function findOrphanTemplateFiles(manifest, root = TEMPLATES_DIR) {
  const declared = new Set(manifest.files.filter((f) => f.policy !== 'append-block').map((f) => f.src))
  return walkTemplateFiles('base', root)
    .filter((rel) => !declared.has(rel))
    .map((rel) => ({
      type: WARNING,
      code: 'orphan-template-file',
      message: `templates/${rel} existe pero ningun entry de manifest.files[] lo referencia.`,
    }))
}

// entry.src que no existe fisicamente. append-block usa un directorio de
// fragmentos (fragments/gitignore/*.txt), no un archivo unico -- se ignora.
export function findMissingSrcFiles(manifest, root = TEMPLATES_DIR) {
  const errors = []
  for (const entry of manifest.files) {
    if (entry.policy === 'append-block') continue
    const abs = path.join(root, ...entry.src.split('/'))
    if (!fs.existsSync(abs)) {
      errors.push({
        type: ERROR,
        code: 'missing-src',
        message: `manifest.files[] entry "${entry.id}" referencia "${entry.src}", que no existe en templates/.`,
      })
    }
  }
  return errors
}

// Los fragmentos de .gitignore por stack (templates/fragments/gitignore/*.txt) no
// pasan por manifest.files[]: el entry "gitignore" es append-block y su `src` es el
// directorio entero. Sin este chequeo, un fragmento renombrado, mal tipeado o para
// un stack que detect.js no reconoce nunca se detectaria. `base.txt` es la
// excepcion: se concatena siempre, no es por-stack.
export function findOrphanFragments(root = TEMPLATES_DIR) {
  const dir = path.join(root, 'fragments', 'gitignore')
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }

  const known = new Set(['base.txt', ...SIGNATURES.map((s) => `${s.stack}.txt`)])
  return entries
    .filter((name) => name.endsWith('.txt') && !known.has(name))
    .map((name) => ({
      type: WARNING,
      code: 'orphan-gitignore-fragment',
      message: `templates/fragments/gitignore/${name} no corresponde a base.txt ni a ningun stack de detect.js: nunca se incluye en el .gitignore emitido.`,
    }))
}

export function findDuplicateIds(manifest) {
  const seen = new Map()
  const errors = []
  for (const entry of manifest.files) {
    const count = (seen.get(entry.id) ?? 0) + 1
    seen.set(entry.id, count)
    if (count === 2) {
      errors.push({ type: ERROR, code: 'duplicate-id', message: `manifest.files[] tiene mas de un entry con id "${entry.id}".` })
    }
  }
  return errors
}

// Dos entries con el mismo dest son un error salvo que todos sean merge-json:
// computePlan los funde en una sola accion (ver src/core/plan.js), asi que no se
// pisan. Cualquier otra combinacion sobre un mismo dest es last-write-wins.
export function findDuplicateDests(manifest) {
  const byDest = new Map()
  for (const entry of manifest.files) {
    const group = byDest.get(entry.dest) ?? []
    group.push(entry)
    byDest.set(entry.dest, group)
  }
  const errors = []
  for (const [dest, group] of byDest) {
    if (group.length < 2) continue
    if (!group.every((e) => e.policy === 'merge-json')) {
      errors.push({ type: ERROR, code: 'duplicate-dest', message: `manifest.files[] tiene mas de un entry con dest "${dest}".` })
    }
  }
  return errors
}

// "Critico" para el lado consumidor = entry con critical:true cuyo src falta.
// Para el lado generador = las 3 rutas fijas de arriba, que no viven en el
// manifest porque describen al propio CLI.
export function findMissingCriticalFiles(manifest, root = TEMPLATES_DIR) {
  const errors = []
  for (const entry of manifest.files.filter((f) => f.critical)) {
    const abs = path.join(root, ...entry.src.split('/'))
    if (!fs.existsSync(abs)) {
      errors.push({ type: ERROR, code: 'missing-critical', message: `Archivo critico "${entry.id}" (${entry.src}) no existe.` })
    }
  }

  const repoRoot = path.join(root, '..')
  for (const rel of GENERATOR_CRITICAL_FILES) {
    if (!fs.existsSync(path.join(repoRoot, ...rel.split('/')))) {
      errors.push({ type: ERROR, code: 'missing-critical-generator', message: `Archivo critico del generador "${rel}" no existe.` })
    }
  }
  return errors
}

// Todo dest del manifest (files y obsolete) es una ruta relativa POSIX dentro
// del repo: la misma regla que computePlan aplica al lockfile.
export function findUnsafeDests(manifest) {
  const errors = []
  for (const entry of [...(manifest.files ?? []), ...(manifest.obsolete ?? []), ...(manifest.dirs ?? [])]) {
    if (!destSeguro(entry.dest)) {
      errors.push({ type: ERROR, code: 'unsafe-dest', message: `dest "${entry.dest}" no es una ruta relativa segura dentro del repo.` })
    }
  }
  return errors
}

export function verifyManifest(manifest, root = TEMPLATES_DIR) {
  const errors = [
    ...findMissingSrcFiles(manifest, root),
    ...findDuplicateIds(manifest),
    ...findDuplicateDests(manifest),
    ...findMissingCriticalFiles(manifest, root),
    ...findUnsafeDests(manifest),
  ]
  const warnings = [...findOrphanTemplateFiles(manifest, root), ...findOrphanFragments(root)]
  return { errors, warnings }
}

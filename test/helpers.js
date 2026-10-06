import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hashContent } from '../src/core/hash.js'
import { loadManifest } from '../src/core/manifest.js'
import { resolveDetected } from '../src/core/detect.js'
import { readLockfile } from '../src/core/lockfile.js'
import { computePlan } from '../src/core/plan.js'

process.env.CI = 'true'

// El directorio temporal lleva un espacio a proposito: muchos repos reales viven
// bajo OneDrive o en rutas con espacios. Si el CLI se rompe con espacios en la
// ruta, se tiene que romper aqui y no en la maquina de un dev.
export function mkRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness test '))
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content)
  return dir
}

export function write(dir, rel, content) {
  const abs = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return abs
}

export function read(dir, rel) {
  return fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
}

export function has(dir, rel) {
  return fs.existsSync(path.join(dir, ...rel.split('/')))
}

export function tree(dir) {
  const out = []
  const walk = (cur, prefix) => {
    const entries = fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (e.name === '.git') continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(cur, e.name), rel)
      else out.push(rel)
    }
  }
  walk(dir, '')
  return out
}

// Listado path -> hash. Se excluye el lockfile porque lleva un timestamp
// (installedAt) que cambia entre corridas por diseno.
export function snapshot(dir, { includeLockfile = false } = {}) {
  return tree(dir)
    .filter((rel) => includeLockfile || rel !== '.claude/harness.json')
    .map((rel) => `${rel}\t${hashContent(read(dir, rel))}`)
    .join('\n')
}

// Recalcula el plan tal como lo veria el CLI ahora mismo. Es la forma honesta de
// preguntar "quedo algo por hacer?" sin depender del stdout.
export function replan(dir) {
  const manifest = loadManifest()
  const lock = readLockfile(dir)
  const detected = resolveDetected(dir, lock)
  const vars = lock?.vars ?? {}
  return computePlan({ manifest, cwd: dir, lock, vars, detected })
}

export function verdicts(plan) {
  const by = {}
  for (const a of plan.actions) (by[a.verdict] ??= []).push(a.dest)
  return by
}

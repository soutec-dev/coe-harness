import path from 'node:path'
import { readIfExists, writeFileLF } from './fsx.js'

export const LOCKFILE = '.claude/harness.json'

// Se commitea. Es la fuente de verdad del equipo sobre que version del harness
// tiene el repo y que archivos siguen intactos vs cuales toco el usuario.
export function readLockfile(cwd) {
  const raw = readIfExists(path.join(cwd, '.claude', 'harness.json'))
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw)
    parsed.files ??= {}
    parsed.blocks ??= {}
    parsed.vars ??= {}
    return parsed
  } catch {
    return null
  }
}

export function writeLockfile(cwd, lock) {
  writeFileLF(path.join(cwd, '.claude', 'harness.json'), JSON.stringify(lock, null, 2))
}

export function emptyLockfile() {
  return { harnessVersion: '0.0.0', files: {}, blocks: {}, vars: {} }
}

// Comparacion semver simple. Las versiones del harness son siempre X.Y.Z.
export function lt(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x < y) return true
    if (x > y) return false
  }
  return false
}

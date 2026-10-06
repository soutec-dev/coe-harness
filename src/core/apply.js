import fs from 'node:fs'
import path from 'node:path'
import { hashContent, hashBytes } from './hash.js'
import { writeFileLF, writeFileBytes, ensureDir, readBytesIfExists } from './fsx.js'
import { extractBlock } from './block.js'
import { writeLockfile } from './lockfile.js'
import { CREATE, UPDATE, RESTORE, CONFLICT, FOREIGN, NOOP, OBSOLETE, MIGRATE, writeActions } from './plan.js'

export function backupDirName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

// Ninguna ruta del plan puede salir del repo ni tocar .git: ni para escribir,
// ni para borrar, ni para respaldar, ni para crear directorios. computePlan ya
// descarta los dest con ".." y ".git", pero esto es la ultima linea,
// independiente de quien armo el plan, y se decide sobre la ruta REAL
// (realpath): un symlink commiteado no desvia nada hacia fuera, un nombre
// corto 8.3 de Windows (GIT~1) no disfraza a .git, y la ultima componente no
// puede ser un symlink.
function dentroDelRepo(cwd, abs) {
  const raiz = rutaReal(path.resolve(cwd))
  const objetivo = rutaReal(path.resolve(abs))
  const rel = path.relative(raiz, objetivo)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
  if (rel.split(/[\\/]/).some((p) => p.toLowerCase() === '.git')) return false
  try {
    if (fs.lstatSync(path.resolve(abs)).isSymbolicLink()) return false
  } catch {
    // no existe todavia: nada que comprobar
  }
  return true
}

// realpath del tramo que exista (los directorios nuevos todavia no se pueden
// resolver): se sube hasta el primer ancestro real y se vuelve a bajar.
function rutaReal(abs) {
  const faltantes = []
  let actual = abs
  while (!fs.existsSync(actual)) {
    const padre = path.dirname(actual)
    if (padre === actual) return abs
    faltantes.unshift(path.basename(actual))
    actual = padre
  }
  return path.join(fs.realpathSync.native(actual), ...faltantes)
}

function rutaSegura(cwd, abs, accion) {
  if (!dentroDelRepo(cwd, abs)) throw new Error(`bloqueado: ${accion} fuera del repo (${abs})`)
  return abs
}

export function apply({ plan, cwd, manifest, vars, detected, lock, prune = false, pruneEdited = false, backup = true, now }) {
  const written = []
  const backedUp = []
  const removed = []

  // El allowlist sale SOLO de las acciones que escriben. Construirlo desde
  // plan.actions incluiria noop y local-edit —- que tienen writePath pero no deben
  // tocarse nunca— y el guard dejaria pasar una sobrescritura del trabajo del usuario.
  const writes = writeActions(plan.actions)
  const allowed = new Set(writes.map((a) => a.writePath).filter(Boolean))
  const backupRoot = path.join(cwd, '.claude', backupDirName(now))

  for (const dir of plan.dirs) {
    const abs = rutaSegura(cwd, path.join(cwd, ...dir.dest.split('/')), 'intento de crear un directorio')
    ensureDir(abs)
    const keep = path.join(abs, '.gitkeep')
    if (fs.readdirSync(abs).length === 0) writeFileLF(keep, '')
  }

  for (const action of plan.actions) {
    if (action.verdict === OBSOLETE) {
      if (!prune) continue
      if (!action.autoPrune && !pruneEdited) continue
      const abs = rutaSegura(cwd, path.join(cwd, ...action.dest.split('/')), 'intento de borrado')
      const saved = saveBackup(cwd, backupRoot, action.dest)
      if (backup && saved) backedUp.push(saved)
      fs.rmSync(abs, { force: true })
      removed.push(action.dest)
      continue
    }

    // noop y local-edit tienen contenido y writePath, pero NO se escriben.
    // local-edit significa "el usuario lo edito y el template no cambio": escribirlo
    // le revertiria el trabajo en silencio. Es la garantia central del harness.
    if (!writes.includes(action)) continue
    if (!action.writePath) continue

    // Write guard: nada se escribe si no salio del plan que el usuario vio.
    if (!allowed.has(action.writePath)) {
      throw new Error(`bloqueado: intento de escritura fuera del plan (${action.writePath})`)
    }

    // Backup de todo lo que no sea creacion nueva, antes de tocarlo.
    const isOverwrite =
      action.verdict === UPDATE || action.verdict === MIGRATE || (action.verdict === CONFLICT && action.writePath === action.dest)
    if (backup && isOverwrite) {
      const saved = saveBackup(cwd, backupRoot, action.dest)
      if (saved) backedUp.push(saved)
    }

    const target = rutaSegura(cwd, path.join(cwd, ...action.writePath.split('/')), 'intento de escritura')
    if (action.binary) writeFileBytes(target, action.content)
    else writeFileLF(target, action.content)
    written.push({ dest: action.writePath, verdict: action.verdict })
  }

  const nextLock = buildLockfile({ plan, manifest, vars, detected, lock, prune, pruneEdited, cwd, now })
  writeLockfile(cwd, nextLock)

  return { written, backedUp, removed, backupRoot: backedUp.length ? backupRoot : null, lock: nextLock }
}

// El backup copia bytes tal cual: sin normalizacion LF, para no corromper
// binarios y para que el respaldo sea una copia fiel, no una version "arreglada".
function saveBackup(cwd, backupRoot, dest) {
  const src = rutaSegura(cwd, path.join(cwd, ...dest.split('/')), 'intento de respaldo')
  const content = readBytesIfExists(src)
  if (content == null) return null
  writeFileBytes(rutaSegura(cwd, path.join(backupRoot, ...dest.split('/')), 'intento de respaldo'), content)
  return dest
}

function buildLockfile({ plan, manifest, vars, detected, lock, prune, pruneEdited, cwd, now }) {
  const next = {
    harness: 'coe-harness',
    harnessVersion: manifest.harnessVersion,
    cliVersion: manifest.cliVersion ?? manifest.harnessVersion,
    installedAt: (now ?? new Date()).toISOString(),
    // Sticky: se decide en la primera instalacion y no se recalcula nunca mas.
    greenfield: lock?.greenfield ?? detected.isEmpty,
    // Seleccion de skills de este repo. computePlan la resolvio (flags, lockfile
    // previo o catalogo completo); se persiste para que el proximo upgrade la respete.
    skills: plan.skills ?? lock?.skills,
    vars,
    detected: { stacks: detected.stacks, packageManager: detected.packageManager },
    files: {},
    blocks: {},
  }

  for (const action of plan.actions) {
    const prev = lock?.files?.[action.dest]

    switch (action.verdict) {
      case CREATE:
      case UPDATE:
      case RESTORE:
      case NOOP:
        // El archivo en disco es exactamente lo que el harness quiso emitir.
        if (action.policy === 'append-block') {
          const block = extractBlock(action.content)
          if (block) next.blocks[action.dest] = { hash: hashContent(block) }
        } else if (action.binary) {
          next.files[action.dest] = { policy: action.policy, hash: hashBytes(action.content), binary: true }
        } else {
          next.files[action.dest] = { policy: action.policy, hash: hashContent(action.content) }
        }
        break

      case CONFLICT:
      case FOREIGN:
        // Escribimos un .new al lado. El archivo del usuario sigue siendo suyo:
        // NO reclamamos su hash, o el proximo upgrade lo creeria intacto y lo pisaria.
        if (prev) next.files[action.dest] = prev
        break

      case OBSOLETE: {
        const removedNow = prune && (action.autoPrune || pruneEdited)
        if (!removedNow && prev) next.files[action.dest] = prev
        break
      }

      default:
        // local-edit y migrate: conservamos el hash original para seguir detectando la
        // edicion. Reclamar el hash de un archivo migrado autorizaria a pisarlo despues.
        if (prev) next.files[action.dest] = prev
        break
    }
  }

  return next
}

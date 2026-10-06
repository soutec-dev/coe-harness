import fs from 'node:fs'
import path from 'node:path'

// Los placeholders "cloud-only" de OneDrive pueden tirar al leer, y el repo del
// usuario puede estar sincronizado. Nunca dejamos que eso explote el CLI.
export function readIfExists(abs) {
  try {
    return fs.readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

export function exists(abs) {
  try {
    fs.accessSync(abs)
    return true
  } catch {
    return false
  }
}

// Escritura plana, siempre LF. NO usamos write-temp-then-rename: ese patron
// "atomico" es justo el que falla con EPERM bajo sync de OneDrive y antivirus.
export function writeFileLF(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const normalized = content.replace(/\r\n/g, '\n')
  fs.writeFileSync(abs, normalized.endsWith('\n') ? normalized : normalized + '\n', 'utf8')
}

// Variante binaria de readIfExists: devuelve un Buffer o null. Para los assets
// de skills (PNGs), donde una lectura utf8 corromperia los bytes.
export function readBytesIfExists(abs) {
  try {
    return fs.readFileSync(abs)
  } catch {
    return null
  }
}

// Escritura binaria: sin normalizacion LF ni newline final. Bytes tal cual.
export function writeFileBytes(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buf)
}

export function ensureDir(abs) {
  fs.mkdirSync(abs, { recursive: true })
}

export function listEntries(abs) {
  try {
    return fs.readdirSync(abs)
  } catch {
    return []
  }
}

// Siempre POSIX en el lockfile y en el manifest: un lockfile escrito en Windows
// tiene que ser legible por el mismo CLI corriendo en Linux (CI).
export function toPosix(p) {
  return p.split(path.sep).join('/')
}

export function fromPosix(cwd, p) {
  return path.join(cwd, ...p.split('/'))
}

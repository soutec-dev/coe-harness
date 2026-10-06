import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEMPLATES_DIR = fileURLToPath(new URL('../../templates/', import.meta.url))

export function loadManifest() {
  const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'harness.manifest.json'), 'utf8')
  return JSON.parse(raw)
}

// `src` en el manifest siempre es una ruta POSIX relativa a templates/.
export function readTemplate(src) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, ...src.split('/')), 'utf8')
}

// Para entries con binary:true (assets de skills): Buffer, sin decodificar.
export function readTemplateBytes(src) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, ...src.split('/')))
}

// Los dotfiles se guardan en templates/ SIN el punto inicial (gitignore, no
// .gitignore). Dos razones: npm elimina los .gitignore de los tarballs
// publicados, y un .gitignore vivo dentro de templates/ aplicaria sus reglas
// al propio repo del generador. El nombre real vive en `dest`.
export function readFragments(dir, stacks) {
  const abs = path.join(TEMPLATES_DIR, ...dir.split('/'))
  const parts = []
  const wanted = ['base', ...stacks]
  for (const name of wanted) {
    const file = path.join(abs, `${name}.txt`)
    if (fs.existsSync(file)) {
      parts.push(fs.readFileSync(file, 'utf8').trim())
    }
  }
  return parts
    .filter(Boolean)
    .join('\n\n')
    .split('\n')
}

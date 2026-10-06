import { normalize } from './hash.js'

// Los marcadores NO llevan version. Si la llevaran, al pasar de v1.0.0 a v1.1.0
// el regex no encontraria el bloque viejo y appendearia un segundo bloque.
// La version va DENTRO del bloque, como comentario.
export const BEGIN = '# >>> coe-harness >>>'
export const END = '# <<< coe-harness <<<'

const BLOCK_RE = new RegExp(
  `${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`,
  'm'
)

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildBlock(lines, harnessVersion) {
  const body = [
    BEGIN,
    `# Generado por coe-harness v${harnessVersion}. No editar dentro del bloque:`,
    `# el proximo 'coe-harness upgrade' lo reemplaza. Tus lineas fuera del bloque no se tocan.`,
    ...lines,
    END,
  ]
  return body.join('\n')
}

export function extractBlock(fileContent) {
  if (fileContent == null) return null
  const m = normalize(fileContent).match(BLOCK_RE)
  return m ? m[0] : null
}

// Reemplaza el bloque in-place si existe; si no, lo appendea al final.
// Las lineas propias del usuario nunca se tocan: solo somos duenos de la region
// delimitada.
export function upsertBlock(fileContent, block) {
  const existing = fileContent == null ? '' : normalize(fileContent)
  if (existing === '') return block
  if (BLOCK_RE.test(existing)) return existing.replace(BLOCK_RE, block)
  return `${existing}\n\n${block}`
}

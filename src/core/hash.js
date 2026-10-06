import { createHash } from 'node:crypto'

// El hash se calcula sobre el contenido normalizado a LF y sin newline final.
// Sin esto, el core.autocrlf de git y cualquier editor de Windows producen
// hashes distintos para el mismo archivo, el motor lo clasifica como
// "modificado por el usuario" y el upgrade se niega a hacer nada.
export function normalize(content) {
  return content.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

export function hashContent(content) {
  return createHash('sha256').update(normalize(content), 'utf8').digest('hex').slice(0, 16)
}

// Para archivos binarios (assets de skills): sin normalizacion de newlines,
// que corromperia el contenido. Bytes tal cual.
export function hashBytes(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

export function sameContent(a, b) {
  if (a == null || b == null) return false
  return normalize(a) === normalize(b)
}

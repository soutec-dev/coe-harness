// Merge "seed": el harness solo AGREGA claves que faltan. Nunca pisa un valor
// que el usuario ya escribio, nunca borra.
//
// Por que no un deep-merge que gane: si un dev cambia "model" a "sonnet" porque
// asi trabaja, un upgrade no tiene derecho a devolverselo a "opusplan" (P8).
// Para remover o renombrar claves (ej: las 4 claves invalidas del Kit v0) existen
// las migraciones en src/migrations/ — eso es un acto explicito y versionado,
// no un efecto secundario silencioso del merge.
export function seedMerge(existing, seed) {
  if (!isPlainObject(existing)) return structuredClone(seed)
  const out = structuredClone(existing)
  for (const [key, value] of Object.entries(seed)) {
    if (!(key in out)) {
      out[key] = structuredClone(value)
    } else if (isPlainObject(out[key]) && isPlainObject(value)) {
      out[key] = seedMerge(out[key], value)
    } else if (Array.isArray(out[key]) && Array.isArray(value)) {
      // Union preservando el orden del usuario primero.
      const seen = new Set(out[key].map((v) => JSON.stringify(v)))
      for (const v of value) {
        if (!seen.has(JSON.stringify(v))) out[key].push(v)
      }
    }
    // Escalar ya presente -> se respeta el del usuario.
  }
  return out
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

export function parseJson(content, dest) {
  if (content == null) return null
  try {
    return JSON.parse(content)
  } catch (err) {
    throw new Error(`${dest} no es JSON valido: ${err.message}`)
  }
}

export function stringifyJson(obj) {
  return JSON.stringify(obj, null, 2)
}

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
      out[key] = unionDeArrays(out[key], value)
    }
    // Escalar ya presente -> se respeta el del usuario.
  }
  return out
}

// Union preservando el orden del usuario primero. Una entrada de hooks de
// Claude Code se identifica por matcher + comandos: la del harness (mismo
// matcher, mismo comando) es del harness, asi que en un upgrade la version
// nueva (otro timeout, por ejemplo) reemplaza a la vieja en vez de sumarse como
// una entrada mas, y las copias viejas duplicadas se funden. Un hook del
// usuario tiene otro comando y se conserva tal cual.
function unionDeArrays(existentes, semilla) {
  const porClave = new Map(semilla.map((v) => [claveDe(v), v]))
  const salida = []
  const vistas = new Set()
  for (const v of existentes) {
    const clave = claveDe(v)
    if (vistas.has(clave)) continue
    vistas.add(clave)
    salida.push(identidadDeHook(v) && porClave.has(clave) ? structuredClone(porClave.get(clave)) : v)
  }
  for (const v of semilla) {
    const clave = claveDe(v)
    if (vistas.has(clave)) continue
    vistas.add(clave)
    salida.push(structuredClone(v))
  }
  return salida
}

function claveDe(v) {
  return identidadDeHook(v) ?? JSON.stringify(v)
}

export function identidadDeHook(v) {
  if (!isPlainObject(v) || typeof v.matcher !== 'string' || !Array.isArray(v.hooks)) return null
  const comandos = v.hooks.map((h) => (isPlainObject(h) ? `${h.type ?? ''}:${h.command ?? ''}` : JSON.stringify(h))).sort()
  return JSON.stringify(['hook', v.matcher, comandos])
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

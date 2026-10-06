#!/usr/bin/env node
// Tag de release, según la sección "Versionamiento" de la skill coe-github:
// tras el merge dev -> main se crea el tag inmutable vX.Y.Z y se mueve el tag
// móvil vX. Lo corre el workflow tag-release.yml (pull_request cerrado y
// mergeado con base main) o, en repos sin Actions, el agente después del merge
// de release:
//
//   git fetch origin && node scripts/tag-release.mjs --ref origin/main
//
// Con --ref, la versión sale del package.json de ese commit y los tags apuntan
// a él: no hace falta cambiar de rama ni tocar el árbol de trabajo. Sin --ref,
// usa el package.json del árbol y HEAD (el checkout de main del workflow).
//
// No crea el GitHub Release: eso sigue siendo del coordinador (ver skill).
// Es idempotente: si vX.Y.Z ya existe (alguien lo taggeó a mano), no falla
// ni duplica -- solo reporta y sale 0.
//
// Uso: node scripts/tag-release.mjs [--ref <ref>]

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export function versionDePackageJson(contenidoJson) {
  const pkg = JSON.parse(contenidoJson)
  const version = pkg.version
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`package.json no tiene una versión SemVer válida: "${version}"`)
  }
  return version
}

export function tagInmutable(version) {
  return `v${version}`
}

export function tagMovil(version) {
  return `v${version.split('.')[0]}`
}

function sh(args) {
  return execFileSync(args[0], args.slice(1), {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function tagExiste(tag) {
  try {
    sh(['git', 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])
    return true
  } catch {
    return false
  }
}

function main() {
  const { values } = parseArgs({ options: { ref: { type: 'string' } } })
  const contenido = values.ref ? sh(['git', 'show', `${values.ref}:package.json`]) : readFileSync('package.json', 'utf8')
  const version = versionDePackageJson(contenido)
  const inmutable = tagInmutable(version)
  const movil = tagMovil(version)
  const objetivo = values.ref ? sh(['git', 'rev-parse', `${values.ref}^{commit}`]) : 'HEAD'

  // --force: sin él, git >= 2.20 se niega a actualizar un tag local que ya
  // existe y difiere del remoto ("would clobber existing tag") -- justo el
  // caso del tag móvil vX en la máquina de un dev -- y el script moría antes
  // de crear nada.
  sh(['git', 'fetch', 'origin', '--tags', '--force'])

  if (tagExiste(inmutable)) {
    console.log(`[skip] ${inmutable} ya existe -- release ya taggeado, no se toca.`)
  } else {
    sh(['git', 'tag', '-a', inmutable, '-m', `Release ${inmutable}`, objetivo])
    sh(['git', 'push', 'origin', inmutable])
    console.log(`[OK] ${inmutable} creado y pusheado.`)
  }

  // El tag móvil (vX) es un puntero que se reasigna en cada release de esa
  // major -- a diferencia del tag inmutable, sí se mueve: -f es intencional
  // y coincide con lo que la skill coe-github documenta. Apunta al commit del
  // tag inmutable, exista de antes o no.
  const commitDelRelease = sh(['git', 'rev-parse', `${inmutable}^{commit}`])
  sh(['git', 'tag', '-f', '-a', movil, '-m', `Release ${inmutable}`, commitDelRelease])
  sh(['git', 'push', 'origin', movil, '--force'])
  console.log(`[OK] ${movil} apunta ahora a ${inmutable}.`)
}

// Solo como ejecutable: al importarse desde los tests no corre nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (e) {
    const detalle = (e?.stderr ?? '').toString().trim() || e?.message || String(e)
    console.error(`[ERROR] ${detalle.split('\n')[0]}`)
    process.exit(1)
  }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  segmentos,
  palabras,
  pushDelComando,
  pushesDelComando,
  invocacionesDeGit,
  queCambia,
  argsDelEnsayo,
  ramaDeDestino,
  parsePorcelain,
  mismaUrl,
  cambioDePR,
  urlDelPR,
  prePush,
  postPR,
  salidaPostToolUse,
  procesar,
  prDeEsteRepo,
  repoDeUrl,
} from '../templates/base/claude/hooks/reglas-pr.mjs'

// Hook PreToolUse/PostToolUse: los checks de check-pr-rules.mjs corren en la
// sesion del agente. Se testea como lo corre Claude Code (JSON por stdin) contra
// repos git reales en tmp, con espacios en la ruta, y la logica de PR con un
// `correr` falso (sin gh).
const HOOK = fileURLToPath(new URL('../templates/base/claude/hooks/reglas-pr.mjs', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../scripts/check-pr-rules.mjs', import.meta.url))
const CWD = path.resolve('/repo')

// --- Lectura del comando ---------------------------------------------------

test('segmentos: corta por operadores pero no dentro de comillas ni en redirecciones', () => {
  assert.deepEqual(segmentos('git add -A && git commit -m "x; git push" && git push 2>&1 | tail -n 3'), [
    'git add -A',
    'git commit -m "x; git push"',
    'git push 2>&1',
    'tail -n 3',
  ])
  assert.deepEqual(segmentos('cd x; git push || echo fallo'), ['cd x', 'git push', 'echo fallo'])
})

test('palabras: quita comillas, redirecciones y asignaciones iniciales', () => {
  assert.deepEqual(palabras('GIT_TRACE=1 git push "origin" fix/x 2>&1'), ['git', 'push', 'origin', 'fix/x'])
  assert.deepEqual(palabras('git push origin x > salida.txt'), ['git', 'push', 'origin', 'x'])
  // PowerShell: la barra invertida es parte de la ruta, no un escape.
  assert.deepEqual(palabras('git -C C:\\repos\\app push', 'powershell'), ['git', '-C', 'C:\\repos\\app', 'push'])
})

test('pushDelComando: pushes de ramas, con y sin refspec, remoto, args y destinos', () => {
  const simple = pushDelComando('git push', CWD)
  assert.equal(simple.dir, CWD)
  assert.deepEqual(simple.cabezas, ['HEAD'])
  assert.deepEqual(simple.destinos, ['HEAD'])
  assert.equal(simple.remoto, null)
  assert.deepEqual(simple.args, [])
  assert.deepEqual(simple.borrados, [])
  assert.equal(simple.forzado, false)
  assert.equal(simple.masivo, false)
  assert.equal(simple.metacaracteres, false)

  const conRemoto = pushDelComando('git push -u origin fix/x', CWD)
  assert.deepEqual(conRemoto.cabezas, ['fix/x'])
  assert.deepEqual(conRemoto.destinos, ['fix/x'])
  assert.equal(conRemoto.remoto, 'origin')
  assert.deepEqual(conRemoto.args, ['-u', 'origin', 'fix/x'])
  assert.equal(pushDelComando('git push https://github.com/otro/repo.git HEAD:x', CWD).remoto, 'https://github.com/otro/repo.git')

  assert.deepEqual(pushDelComando('git push origin HEAD', CWD).destinos, ['HEAD'])
  assert.deepEqual(pushDelComando('git push origin HEAD:main', CWD).destinos, ['main'])
  assert.deepEqual(pushDelComando('git push origin dev:refs/heads/main', CWD).destinos, ['refs/heads/main'])
  assert.deepEqual(pushDelComando('git fetch origin && git merge origin/dev && git push', CWD).cabezas, ['HEAD'])
  assert.deepEqual(pushDelComando('git push --dry-run origin HEAD', CWD).cabezas, ['HEAD'])
  assert.deepEqual(pushDelComando('git push origin fix/x 2>&1 | tail -n 3', CWD).cabezas, ['fix/x'])
})

// Lo que el texto no puede resolver se marca para pedir confirmacion: el shell
// expande $(), {} y comodines antes de que git vea el comando; `git -c` y las
// opciones raras cambian el remoto o el destino sin tocar el refspec.
test('pushDelComando: metacaracteres del shell, git -c y opciones raras quedan marcados', () => {
  assert.equal(pushDelComando('git push origin HEAD:ma{i,}n', CWD).metacaracteres, true)
  assert.equal(pushDelComando('git push origin HEAD:$(printf main)', CWD).metacaracteres, true)
  assert.equal(pushDelComando('git push origin HEAD:`echo main`', CWD).metacaracteres, true)
  assert.equal(pushDelComando('git push origin fix/x', CWD).metacaracteres, false)
  assert.deepEqual(pushDelComando('git -c push.default=upstream push', CWD).configs, ['push.default=upstream'])
  assert.deepEqual(pushDelComando('git -c remote.origin.push=HEAD:refs/heads/main push origin', CWD).configs, ['remote.origin.push=HEAD:refs/heads/main'])
  assert.deepEqual(pushDelComando('git push origin fix/x', CWD).configs, [])
  assert.deepEqual(pushDelComando('git push --no-verify origin fix/x', CWD).riesgosas, ['--no-verify'])
  assert.deepEqual(pushDelComando('git push -o ci.skip origin fix/x', CWD).riesgosas, ['-o'])
  assert.deepEqual(pushDelComando('git push --receive-pack=/tmp/x origin fix/x', CWD).riesgosas, ['--receive-pack=/tmp/x'])
  assert.deepEqual(pushDelComando('git push -u origin fix/x', CWD).riesgosas, [])
})

test('pushDelComando: --force, -f y +refspec se marcan forzados; --force-with-lease no, pero se marca como reescritura', () => {
  assert.equal(pushDelComando('git push --force origin fix/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push -f origin fix/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push -uf origin fix/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push -4fu origin fix/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push origin +fix/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push origin +HEAD:refs/heads/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push --force-with-lease origin fix/x', CWD).forzado, false)
  assert.deepEqual(pushDelComando('git push --force-with-lease origin fix/x', CWD).reescritura, ['--force-with-lease'])
  assert.deepEqual(pushDelComando('git push --force-with-lease=fix/x origin fix/x', CWD).reescritura, ['--force-with-lease=fix/x'])
  assert.equal(pushDelComando('git push -u origin fix/x', CWD).forzado, false)
  assert.deepEqual(pushDelComando('git push -u origin fix/x', CWD).reescritura, [])
})

// Lo que el texto no puede resolver se marca para pedir confirmacion: una
// opcion abreviada (git acepta cualquier prefijo no ambiguo), un grupo corto
// con una push-option, un comando previo que cambia la rama o los commits, una
// variable de entorno delante del push, --git-dir.
test('pushesDelComando: opciones abreviadas o desconocidas, entorno, comandos previos y todos los push del comando', () => {
  assert.deepEqual(pushDelComando('git push --recei=/tmp/x origin fix/x', CWD).desconocidas, ['--recei=/tmp/x'])
  assert.deepEqual(pushDelComando('git push --forc origin fix/x', CWD).desconocidas, ['--forc'])
  assert.deepEqual(pushDelComando('git push -ux origin fix/x', CWD).desconocidas, ['-ux'])
  assert.deepEqual(pushDelComando('git push -uo ci.skip origin fix/x', CWD).riesgosas, ['-uo'])
  assert.deepEqual(pushDelComando('git push -u origin fix/x', CWD).desconocidas, [])
  assert.deepEqual(pushDelComando('git push origin -- fix/x', CWD).destinos, ['fix/x'])

  assert.equal(pushDelComando('GIT_CONFIG_PARAMETERS="\'push.default=upstream\'" git push origin', CWD).entorno, true)
  assert.equal(pushDelComando('git push origin fix/x', CWD).entorno, false)
  assert.equal(pushDelComando('git --git-dir=../otro/.git push origin fix/x', CWD).rutaDeGit, true)
  assert.equal(pushDelComando('git --git-dir=../otro/.git push origin fix/x', CWD).dir, path.resolve(CWD, '../otro'))
  assert.equal(pushDelComando('git --work-tree . push origin fix/x', CWD).rutaDeGit, true)

  const conCheckout = pushDelComando('git checkout main && git push', CWD)
  assert.deepEqual(conCheckout.cambiosPrevios, [{ segmento: 'git checkout main', cambia: 'destino' }])
  const conCommit = pushDelComando('git add -A && git commit -m "feat: x" && git push -u origin fix/x', CWD)
  assert.deepEqual(conCommit.cambiosPrevios, [{ segmento: 'git commit -m "feat: x"', cambia: 'contenido' }])
  assert.deepEqual(pushDelComando('git fetch origin && git merge origin/dev && git push', CWD).cambiosPrevios, [{ segmento: 'git merge origin/dev', cambia: 'contenido' }])
  assert.deepEqual(pushDelComando('export GIT_DIR=/x; git push', CWD).cambiosPrevios, [{ segmento: 'export GIT_DIR=/x', cambia: 'destino' }])
  assert.deepEqual(pushDelComando('$env:GIT_CONFIG_PARAMETERS="x"; git push origin', CWD, 'powershell').cambiosPrevios, [{ segmento: '$env:GIT_CONFIG_PARAMETERS="x"', cambia: 'destino' }])
  assert.deepEqual(pushDelComando('npm test && git push origin fix/x', CWD).cambiosPrevios, [])
  assert.deepEqual(pushDelComando('git status && git push origin fix/x', CWD).cambiosPrevios, [])
  assert.equal(queCambia('git -C sub switch dev'), 'destino')
  assert.equal(queCambia('git log --oneline'), null)

  // Todos los push del comando, no solo el primero: el segundo puede ir a main.
  const dos = pushesDelComando('git push origin fix/x && git push origin HEAD:main', CWD)
  assert.equal(dos.length, 2)
  assert.deepEqual(dos[1].destinos, ['main'])
  assert.deepEqual(dos[1].cambiosPrevios, [], 'un push previo no cambia el estado')
})

// La carpeta del push se sigue a lo largo del comando: cd -, pushd/popd, cd a
// secas (home), rutas POSIX de Git Bash en Windows. Lo que no se puede
// resolver (variables, sustituciones, un popd sin pushd) queda marcado, nunca
// se da por resuelto.
test('invocacionesDeGit: cd -, pushd/popd, cd sin argumento, rutas irresolubles y rutas POSIX en Windows', () => {
  assert.equal(pushDelComando('cd .. && cd - && git push origin', CWD).dir, CWD)
  assert.equal(pushDelComando('pushd .. && popd && git push origin', CWD).dir, CWD)
  assert.equal(pushDelComando('pushd sub && git push origin', CWD).dir, path.resolve(CWD, 'sub'))
  assert.equal(pushDelComando('cd && git push origin', CWD).dir, os.homedir())
  assert.equal(pushDelComando('cd ~ && git push origin', CWD).dir, os.homedir())
  assert.equal(pushDelComando('Set-Location ..; Set-Location -; git push origin', CWD, 'powershell').dir, CWD)
  assert.equal(pushDelComando('cd .. && git push origin', CWD).dir, path.resolve(CWD, '..'))
  assert.equal(pushDelComando('cd .. 2>/dev/null && git push origin', CWD).dir, path.resolve(CWD, '..'))
  for (const comando of [
    'cd "$PWD" && git push origin',
    'cd $OLDPWD && git push origin',
    'cd "$(cygpath -w .)" && git push origin',
    'git -C "$PWD" push origin',
    'cd - && git push origin',
    'popd && git push origin',
    'cd ~otro && git push origin',
    'cd "$X" && cd sub && git push origin',
  ]) {
    const push = pushDelComando(comando, CWD)
    assert.equal(push.dir, null, comando)
    assert.ok(push.dirIrresoluble, comando)
  }
  // Una ruta absoluta despues de una irresoluble vuelve a resolver.
  assert.equal(pushDelComando(`cd "$X" && cd "${CWD}" && git push origin`, CWD).dir, CWD)
  if (process.platform === 'win32') {
    assert.equal(pushDelComando('cd /c/Users/x/repo && git push origin', CWD).dir, 'C:\\Users\\x\\repo')
    assert.equal(pushDelComando('cd /cygdrive/d/repo && git push origin', CWD).dir, 'D:\\repo')
    assert.ok(pushDelComando('cd /tmp/x && git push origin', CWD).dirIrresoluble)
  }
})

// Un git envuelto en otro programa, un subcomando que no es literal, un `git
// push` dentro de una cadena o un comando que es una variable: el hook no
// puede analizarlos y los marca para preguntar.
test('invocacionesDeGit: git envuelto, subcomando no literal, git push dentro de cadenas y comandos no literales', () => {
  assert.deepEqual(pushDelComando('env git push origin HEAD:main', CWD).envoltorio, ['env'])
  assert.deepEqual(pushDelComando('timeout 60 git push origin fix/x', CWD).envoltorio, ['timeout', '60'])
  assert.deepEqual(pushDelComando('cmd /c git push origin', CWD).envoltorio, ['cmd', '/c'])
  assert.deepEqual(pushDelComando('sudo -u deploy git push origin fix/x', CWD).envoltorio, ['sudo', '-u', 'deploy'])
  assert.deepEqual(pushDelComando('git push origin fix/x', CWD).envoltorio, [])
  assert.equal(pushDelComando('grep -rn git docs/', CWD), null)
  assert.equal(pushDelComando('echo hola git status', CWD), null)

  const variable = invocacionesDeGit('s=push; git $s origin', CWD)
  assert.equal(variable.invocaciones.length, 1)
  assert.equal(variable.invocaciones[0].subLiteral, false)
  assert.match(variable.sospechas[0], /no es literal/)
  assert.match(invocacionesDeGit('$a="push"; git $a origin', CWD, 'powershell').sospechas[0], /no es literal/)
  assert.match(invocacionesDeGit("sh -c 'git push origin fix/x'", CWD).sospechas[0], /dentro de una cadena/)
  assert.match(invocacionesDeGit('cmd="git push origin main"; eval "$cmd"', CWD).sospechas[0], /dentro de una cadena/)
  assert.match(invocacionesDeGit('Invoke-Expression "git push origin"', CWD, 'powershell').sospechas[0], /dentro de una cadena/)
  assert.match(invocacionesDeGit('node -e "require(\'child_process\').execSync(\'git push origin\')"', CWD).sospechas[0], /dentro de una cadena/)
  assert.match(invocacionesDeGit('xargs git < lista.txt', CWD).sospechas[0], /sin subcomando/)
  assert.match(invocacionesDeGit('$GIT push origin main', CWD).sospechas[0], /no es literal|dentro de una cadena/)
  assert.match(invocacionesDeGit('git -c alias.p=push p origin', CWD).sospechas[0], /alias/)
  assert.deepEqual(invocacionesDeGit('git commit -m "feat: push notifications" && git push origin fix/x', CWD).sospechas, [])
  assert.deepEqual(invocacionesDeGit('git log --grep=push && npm test && git status', CWD).sospechas, [])
})

test('queCambia: source, eval, funciones, alias, variables de PowerShell y set con solo opciones', () => {
  for (const s of [
    'source env.sh',
    '. env.sh',
    'eval "$(cat env.sh)"',
    'export GIT_DIR=/x',
    'alias git="git -c x=y"',
    'git() { command git -c x=y "$@"',
    'function git { & git.exe -c x=y $args',
    '$a="push"',
    '$env:GIT_CONFIG_COUNT=1',
    'Set-Alias git C:\\otro\\git.exe',
    'git -c alias.p=push p',
    'git $sub',
    'command git checkout main',
    "sh -c 'git push origin main'",
    'cmd="git push origin main"',
    'git remote set-url --push origin ../evil.git',
  ]) {
    assert.equal(queCambia(s), 'destino', s)
  }
  assert.equal(queCambia('. .\\env.ps1', 'powershell'), 'destino')
  for (const s of ['set -e', 'set -euo pipefail', 'npm test', 'git log --oneline', 'env git status', 'grep -rn git docs/', 'echo listo', 'git push origin fix/x']) {
    assert.equal(queCambia(s), null, s)
  }
  assert.equal(queCambia('set X=1'), 'destino')
  assert.equal(queCambia('git tag v1'), 'contenido')
})

test('argsDelEnsayo: -q/--quiet se quitan para que el porcelain tenga contenido', () => {
  assert.deepEqual(argsDelEnsayo(['-q', 'origin', 'fix/x']), ['origin', 'fix/x'])
  assert.deepEqual(argsDelEnsayo(['--quiet', '-uq', 'origin']), ['-u', 'origin'])
  assert.deepEqual(argsDelEnsayo(['-u', 'origin', 'quiet']), ['-u', 'origin', 'quiet'])
})

test('pushDelComando: tags, --all y --mirror revisan lo que de verdad suben, y --all/--mirror/":" son masivos', () => {
  assert.deepEqual(pushDelComando('git push origin v1.2.0', CWD).cabezas, ['v1.2.0'])
  assert.deepEqual(pushDelComando('git push origin refs/tags/v1', CWD).cabezas, ['refs/tags/v1'])
  assert.deepEqual(pushDelComando('git push --tags', CWD).cabezas, ['--tags'])
  assert.deepEqual(pushDelComando('git push --follow-tags', CWD).cabezas, ['HEAD', '--tags'])
  assert.deepEqual(pushDelComando('git push --all origin', CWD).cabezas, ['--branches'])
  assert.equal(pushDelComando('git push --all origin', CWD).masivo, true)
  assert.equal(pushDelComando('git push --mirror origin', CWD).masivo, true)
  assert.equal(pushDelComando('git push --branches origin', CWD).masivo, true)
  // ":" (matching) sube todas las ramas locales que ya existen en el remoto, main incluida.
  assert.equal(pushDelComando('git push origin :', CWD).masivo, true)
  assert.equal(pushDelComando('git push origin +:', CWD).masivo, true)
  assert.equal(pushDelComando('git push --tags', CWD).masivo, false)
})

test('pushDelComando: los borrados se reconocen (sin cabezas que escanear) y los comandos sin push no llevan check', () => {
  const conDelete = pushDelComando('git push origin --delete fix/x', CWD)
  assert.deepEqual(conDelete.borrados, ['fix/x'])
  assert.deepEqual(conDelete.cabezas, [])
  assert.deepEqual(pushDelComando('git push origin :fix/x', CWD).borrados, ['fix/x'])
  assert.deepEqual(pushDelComando('git push origin :main', CWD).borrados, ['main'])
  assert.deepEqual(pushDelComando('git push origin -d main', CWD).borrados, ['main'])
  for (const comando of ['git commit -m "despues hago git push"', 'git status', 'echo "git push"']) {
    assert.equal(pushDelComando(comando, CWD), null, comando)
  }
  // `git push` como dos palabras seguidas detras de otro programa se analiza como push (envuelto: pide confirmacion).
  assert.deepEqual(pushDelComando('echo git push', CWD).envoltorio, ['echo'])
})

test('parsePorcelain y mismaUrl: lo que git resuelve, incluidos los borrados', () => {
  const salida = 'To https://github.com/o/r.git\n*\trefs/heads/fix/x:refs/heads/fix/x\t[new branch]\n=\trefs/tags/v1:refs/tags/v1\t[up to date]\n-\t:refs/heads/vieja\t[deleted]\nDone\n'
  assert.deepEqual(parsePorcelain(salida), { url: 'https://github.com/o/r.git', destinos: ['refs/heads/fix/x', 'refs/tags/v1', 'refs/heads/vieja'] })
  assert.deepEqual(parsePorcelain(''), { url: null, destinos: [] })
  assert.ok(mismaUrl('https://github.com/o/r.git', 'https://github.com/O/R'))
  assert.ok(mismaUrl('git@github.com:o/r.git', 'git@github.com:o/r'))
  assert.ok(!mismaUrl('https://github.com/o/r.git', 'https://github.com/o/otro'))
  assert.ok(!mismaUrl('', ''))
})

test('pushDelComando: resuelve la carpeta con -C y con un cd previo', () => {
  assert.equal(pushDelComando('git -C "otra carpeta" push', CWD).dir, path.resolve(CWD, 'otra carpeta'))
  assert.equal(pushDelComando('cd "../otro repo" && git add -A && git push', CWD).dir, path.resolve(CWD, '../otro repo'))
  assert.equal(pushDelComando('git -c core.x=1 -C sub push', CWD).dir, path.resolve(CWD, 'sub'))
  assert.equal(pushDelComando('"C:/Program Files/Git/cmd/git.exe" push', CWD).dir, CWD)
})

test('ramaDeDestino: HEAD resuelve a la rama actual; heads/x es una rama (DWIM de git); tags y refs ajenas no', () => {
  assert.equal(ramaDeDestino('main'), 'main')
  assert.equal(ramaDeDestino('refs/heads/main'), 'main')
  assert.equal(ramaDeDestino('heads/main'), 'main')
  assert.equal(ramaDeDestino('HEAD', { ramaActual: 'main' }), 'main')
  assert.equal(ramaDeDestino('HEAD', { ramaActual: null }), null)
  assert.equal(ramaDeDestino('refs/tags/v1'), null)
  assert.equal(ramaDeDestino('tags/v1'), null)
  assert.equal(ramaDeDestino('remotes/origin/main'), null)
  assert.equal(ramaDeDestino('v1.2.0'), 'v1.2.0')
})

test('cambioDePR: gh pr create, y gh pr edit solo si toca body o base', () => {
  assert.deepEqual(cambioDePR('gh pr create --base dev --title "t" --body-file cuerpo.md', CWD), { accion: 'create', dir: CWD, objetivo: null })
  assert.deepEqual(cambioDePR('gh pr edit 12 --body-file c.md', CWD), { accion: 'edit', dir: CWD, objetivo: '12' })
  assert.equal(cambioDePR('gh pr edit https://github.com/o/r/pull/12 --base dev', CWD).objetivo, 'https://github.com/o/r/pull/12')
  assert.equal(cambioDePR('gh pr edit --body=hola', CWD).objetivo, null)
  for (const comando of ['gh pr create --web', 'gh pr create --dry-run', 'gh pr edit 12 --add-label x', 'gh pr view 12', 'gh pr checks', 'git push']) {
    assert.equal(cambioDePR(comando, CWD), null, comando)
  }
})

test('urlDelPR: la ultima URL de PR, sin pegar dos URLs seguidas', () => {
  const salida = JSON.stringify({ stdout: 'Creating pull request\nhttps://github.com/o/r/pull/7\nhttps://github.com/o/r/pull/12\n' })
  assert.equal(urlDelPR(salida), 'https://github.com/o/r/pull/12')
  assert.equal(urlDelPR(JSON.stringify({ stdout: 'nada' })), null)
})

// --- Flujos con un `correr` falso -------------------------------------------

function repoFalso() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness reglas '))
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'scripts', 'check-pr-rules.mjs'), '// falso\n')
  return dir
}

// Responde segun el comando: git rev-parse -> la raiz, git symbolic-ref -> la
// rama actual, git push --dry-run -> el ensayo (porcelain), git remote get-url
// -> la URL de origin, gh pr view -> el PR, el script -> lo que diga `grupos`,
// gh pr comment -> guarda el cuerpo.
const URL_ORIGEN = 'https://github.com/o/r.git'
const ensayo = (lineas, url = URL_ORIGEN) => ({ status: 0, stdout: `To ${url}\n${lineas.join('\n')}\nDone\n`, stderr: '' })

function correrFalso({ raiz, ramaActual = 'fix/algo', grupos = {}, vista = { status: 0 }, comentario = { status: 0 }, dryRun, alias = {} }) {
  const llamadas = []
  const porcelain = dryRun ?? ensayo(['*\trefs/heads/fix/algo:refs/heads/fix/algo\t[new branch]'])
  const correr = (cmd, args, opciones = {}) => {
    llamadas.push({ cmd, args, opciones })
    if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${raiz}\n`, stderr: '' }
    if (cmd === 'git' && args[0] === 'symbolic-ref') return ramaActual ? { status: 0, stdout: `${ramaActual}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' }
    if (cmd === 'git' && args[0] === 'push') return porcelain
    if (cmd === 'git' && args[0] === 'remote') return { status: 0, stdout: `${URL_ORIGEN}\n`, stderr: '' }
    if (cmd === 'git' && args[0] === '--list-cmds=builtins') return { status: 0, stdout: 'add\ncheckout\ncommit\nconfig\nfetch\nlog\nmerge\npush\nstatus\nswitch\n', stderr: '' }
    if (cmd === 'git' && args[0] === 'config' && args[1] === '--get') {
      const valor = alias[String(args[2]).replace(/^alias\./, '')]
      return valor ? { status: 0, stdout: `${valor}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' }
    }
    if (cmd === 'git') return { status: 0, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[1] === 'view') {
      return vista.status === 0
        ? { status: 0, stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/12', headRefOid: 'abcdef1234' }), stderr: '' }
        : { status: vista.status, stdout: '', stderr: vista.stderr ?? 'gh: error' }
    }
    if (cmd === 'gh' && args[1] === 'comment') return { status: comentario.status, stdout: '', stderr: 'no se pudo comentar' }
    const grupo = args[args.indexOf('--grupo') + 1]
    return grupos[grupo] ?? { status: 0, stdout: `[OK  ] ${grupo}: ok\n`, stderr: '' }
  }
  return { correr, llamadas }
}

const pushSimple = (extra = {}) => ({
  dir: CWD,
  dirIrresoluble: null,
  envoltorio: [],
  alias: null,
  args: [],
  remoto: null,
  configs: [],
  riesgosas: [],
  reescritura: [],
  desconocidas: [],
  rutaDeGit: false,
  cambiosPrevios: [],
  entorno: false,
  metacaracteres: false,
  cabezas: ['HEAD'],
  destinos: ['HEAD'],
  borrados: [],
  forzado: false,
  masivo: false,
  ...extra,
})

test('prePush: el destino lo decide git: heads/main, el upstream en main y un borrado de main se deniegan', () => {
  const raiz = repoFalso()
  const { correr, llamadas } = correrFalso({ raiz })
  // heads/main es refs/heads/main para git (DWIM): deny estatico, antes de cualquier ensayo.
  assert.equal(prePush({ push: pushSimple({ destinos: ['heads/main'] }), raiz, correr }).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(prePush({ push: pushSimple({ cabezas: [], destinos: [], borrados: ['main'] }), raiz, correr }).hookSpecificOutput.permissionDecision, 'deny')
  assert.ok(!llamadas.some((l) => l.cmd === 'git' && l.args[0] === 'push'), 'con deny estatico no se ensaya nada')
  // Borrar otra rama no sube commits: nada que escanear, pero el ensayo corre igual.
  const borrado = correrFalso({ raiz, dryRun: ensayo(['-\t:refs/heads/fix/vieja\t[deleted]']) })
  assert.equal(prePush({ push: pushSimple({ cabezas: [], destinos: [], borrados: ['fix/vieja'], args: ['origin', '--delete', 'fix/vieja'], remoto: 'origin' }), raiz, correr: borrado.correr }), null)
  assert.ok(!borrado.llamadas.some((l) => l.cmd === process.execPath), 'sin cabezas no hay nada que escanear')
  assert.ok(borrado.llamadas.some((l) => l.cmd === 'git' && l.args[0] === 'push'), 'sin cabezas el ensayo corre igual')

  // Texto inocente (`git push origin`), pero git resuelve a main por push.default o el upstream: deny por el ensayo.
  const upstreamEnMain = correrFalso({ raiz, dryRun: ensayo([' \trefs/heads/fix/algo:refs/heads/main\t[ok]']) })
  const salida = prePush({ push: pushSimple({ remoto: 'origin', args: ['origin'] }), raiz, correr: upstreamEnMain.correr })
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /segun git/)
  const ensayado = upstreamEnMain.llamadas.find((l) => l.cmd === 'git' && l.args[0] === 'push')
  assert.deepEqual(ensayado.args.slice(0, 5), ['push', '--dry-run', '--porcelain', '--no-verify', '--verbose'])

  // -q dejaria el porcelain vacio: el ensayo va sin -q, y si aun asi git no informa nada, ask.
  const silencioso = correrFalso({ raiz, dryRun: ensayo([' \trefs/heads/fix/algo:refs/heads/main\t[ok]']) })
  assert.equal(prePush({ push: pushSimple({ remoto: 'origin', args: ['-q', 'origin'] }), raiz, correr: silencioso.correr }).hookSpecificOutput.permissionDecision, 'deny')
  assert.ok(!silencioso.llamadas.find((l) => l.cmd === 'git' && l.args[0] === 'push').args.includes('-q'))
  const vacio = correrFalso({ raiz, dryRun: { status: 0, stdout: 'Done\n', stderr: '' } })
  const sinDestino = prePush({ push: pushSimple({ remoto: 'origin', args: ['origin'] }), raiz, correr: vacio.correr })
  assert.equal(sinDestino.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(sinDestino.hookSpecificOutput.permissionDecisionReason, /no informo ningun destino/)
})

test('prePush: lo que el hook no puede resolver pide confirmacion, nunca pasa en silencio', () => {
  const raiz = repoFalso()
  const { correr } = correrFalso({ raiz })
  for (const push of [
    pushSimple({ metacaracteres: true }),
    pushSimple({ configs: ['push.default=upstream'] }),
    pushSimple({ riesgosas: ['--no-verify'] }),
    pushSimple({ entorno: true }),
    pushSimple({ rutaDeGit: true }),
    pushSimple({ desconocidas: ['--recei=/tmp/x'] }),
    pushSimple({ reescritura: ['--force-with-lease'] }),
    pushSimple({ cambiosPrevios: [{ segmento: 'git checkout main', cambia: 'destino' }] }),
    pushSimple({ cambiosPrevios: [{ segmento: 'git commit -m "feat: x"', cambia: 'contenido' }] }),
  ]) {
    const salida = prePush({ push, raiz, correr })
    assert.equal(salida.hookSpecificOutput.permissionDecision, 'ask', JSON.stringify(push))
    assert.match(salida.hookSpecificOutput.permissionDecisionReason, /no puedo asegurar/)
  }
  // Las dudas no saltan el escaneo de secretos: un secreto se deniega aunque el destino sea dudoso.
  const conSecreto = correrFalso({ raiz, grupos: { secretos: { status: 1, stdout: '[FAIL] sin-secretos: archivos de credenciales en commits sin pushear: .env\n' } } })
  assert.equal(prePush({ push: pushSimple({ configs: ['push.default=upstream'] }), raiz, correr: conSecreto.correr }).hookSpecificOutput.permissionDecision, 'deny')
  // git no pudo ensayar el push (sin upstream, sin red): tambien ask, con el motivo.
  const sinEnsayo = correrFalso({ raiz, dryRun: { status: 128, stdout: '', stderr: 'fatal: The current branch fix/algo has no upstream branch.\n' } })
  const salida = prePush({ push: pushSimple(), raiz, correr: sinEnsayo.correr })
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /no upstream/)
})

// La plataforma no bloquea el comando si el hook se pasa de su timeout: el hook
// tiene que responder antes, y "me quede sin tiempo" es ask, no silencio.
test('prePush: agotado el presupuesto de tiempo pide confirmacion, y acota el timeout de cada llamada', () => {
  const raiz = repoFalso()
  const lento = correrFalso({ raiz })
  const salida = prePush({ push: pushSimple(), raiz, correr: lento.correr, presupuestoMs: 500 })
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /tiempo/)
  const { correr, llamadas } = correrFalso({ raiz })
  prePush({ push: pushSimple(), raiz, correr, presupuestoMs: 5000 })
  assert.ok(llamadas.every((l) => l.opciones.timeout <= 5000), 'ninguna llamada puede durar mas que el presupuesto')
})

test('procesar: con varios push en el comando, un deny gana a un ask y un ask a dejar pasar', () => {
  const raiz = repoFalso()
  const { correr } = correrFalso({ raiz })
  const entrada = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: raiz, tool_input: { command } })
  assert.equal(procesar(entrada('git push origin fix/algo && git push origin HEAD:main'), correr).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(procesar(entrada('git push origin fix/algo && git push --no-verify origin fix/algo'), correr).hookSpecificOutput.permissionDecision, 'ask')
  assert.equal(procesar(entrada('git push origin fix/algo && git push origin fix/algo'), correr), null)
})

// Sin repo resuelto no hay rama actual, escaneo ni ensayo: lo que se puede
// denegar por el texto se deniega, y el resto se pregunta; nunca se calla.
test('prePush: sin repo resuelto, lo estatico se deniega y el resto pide confirmacion', () => {
  const raiz = repoFalso()
  const { correr, llamadas } = correrFalso({ raiz })
  const sinRaiz = (extra) => prePush({ push: pushSimple({ dir: null, dirIrresoluble: 'la carpeta X no existe', ...extra }), raiz: null, sinRaiz: 'la carpeta X no existe', correr })
  assert.equal(sinRaiz({ destinos: ['main'] }).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(sinRaiz({ forzado: true }).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(sinRaiz({ remoto: 'upstream' }).hookSpecificOutput.permissionDecision, 'deny')
  const salida = sinRaiz({})
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /no pude determinar en que repositorio/)
  assert.ok(!llamadas.some((l) => l.cmd === process.execPath || (l.cmd === 'git' && l.args[0] === 'push')), 'sin repo no se escanea ni se ensaya')
})

test('prePush: envoltorios y alias piden confirmacion; la URL real del ensayo tiene que ser la del repo de origin aunque el remoto sea explicito', () => {
  const raiz = repoFalso()
  const { correr } = correrFalso({ raiz })
  assert.equal(prePush({ push: pushSimple({ envoltorio: ['env'] }), raiz, correr }).hookSpecificOutput.permissionDecision, 'ask')
  assert.equal(prePush({ push: pushSimple({ alias: '`p` = `push`' }), raiz, correr }).hookSpecificOutput.permissionDecision, 'ask')
  // pushurl / pushInsteadOf: git mandaria el push a otro repo bajo el nombre origin.
  const explicito = { remoto: 'origin', args: ['origin', 'fix/algo'], cabezas: ['fix/algo'], destinos: ['fix/algo'] }
  const desviado = correrFalso({ raiz, dryRun: ensayo(['*\trefs/heads/fix/algo:refs/heads/fix/algo\t[new branch]'], 'https://github.com/otro/repo.git') })
  const salida = prePush({ push: pushSimple(explicito), raiz, correr: desviado.correr })
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /pushurl|pushInsteadOf/)
  // El mismo repo por otro protocolo (fetch https, push ssh) sigue siendo origin.
  const ssh = correrFalso({ raiz, dryRun: ensayo(['*\trefs/heads/fix/algo:refs/heads/fix/algo\t[new branch]'], 'git@github.com:o/r.git') })
  assert.equal(prePush({ push: pushSimple(explicito), raiz, correr: ssh.correr }), null)
})

// Una autorizacion nueva en .datos-autorizados entra a dev por PR, donde el
// revisor la ve; por push directo a dev se podria autoeximir cualquier dato.
test('prePush: una autorizacion nueva en .datos-autorizados no entra a dev por push directo', () => {
  const raiz = repoFalso()
  const grupos = { secretos: { status: 0, stdout: '[OK  ] sin-secretos: ok\n[skip] excepciones-nuevas: revisar a mano: 1 linea(s) nueva(s) en .datos-autorizados\n' } }
  const aDev = correrFalso({ raiz, grupos, dryRun: ensayo([' \trefs/heads/fix/algo:refs/heads/dev\t[ok]']) })
  const salida = prePush({ push: pushSimple({ remoto: 'origin', args: ['origin', 'HEAD:dev'], destinos: ['dev'] }), raiz, correr: aDev.correr })
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /datos-autorizados/)
  // A la rama de trabajo si: la autorizacion llega a dev por PR.
  const aRama = correrFalso({ raiz, grupos })
  assert.equal(prePush({ push: pushSimple({ remoto: 'origin', args: ['-u', 'origin', 'fix/algo'], cabezas: ['fix/algo'], destinos: ['fix/algo'] }), raiz, correr: aRama.correr }), null)
})

test('procesar: los alias de git que hacen push se analizan como push; lo que no se puede analizar pide confirmacion', () => {
  const raiz = repoFalso()
  const entrada = (command, tool_name = 'Bash') => ({ hook_event_name: 'PreToolUse', tool_name, cwd: raiz, tool_input: { command } })
  const conAlias = correrFalso({ raiz, alias: { p: 'push', lg: 'log --graph', sube: '!git push origin HEAD' } })
  assert.equal(procesar(entrada('git p origin HEAD:main'), conAlias.correr).hookSpecificOutput.permissionDecision, 'deny')
  const porAlias = procesar(entrada('git p origin fix/algo'), conAlias.correr)
  assert.equal(porAlias.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(porAlias.hookSpecificOutput.permissionDecisionReason, /alias/)
  assert.equal(procesar(entrada('git lg'), conAlias.correr), null)
  assert.match(procesar(entrada('git sube'), conAlias.correr).hookSpecificOutput.permissionDecisionReason, /alias/)
  assert.equal(procesar(entrada('git status'), conAlias.correr), null)
  const { correr } = correrFalso({ raiz })
  for (const [comando, tool] of [
    ["sh -c 'git push origin fix/algo'"],
    ['s=push; git $s origin fix/algo'],
    ['$a="push"; git $a origin fix/algo', 'PowerShell'],
    ['cmd="git push origin main"; eval "$cmd"'],
    ['xargs git < lista.txt'],
    ['GIT_CONFIG_PARAMETERS="\'alias.p=push\'" git p origin fix/algo'],
  ]) {
    const salida = procesar(entrada(comando, tool), correr)
    assert.equal(salida?.hookSpecificOutput.permissionDecision, 'ask', comando)
    assert.match(salida.hookSpecificOutput.permissionDecisionReason, /no puedo analizar/)
  }
  assert.equal(procesar(entrada('git commit -m "feat: push notifications"'), correr), null)
  assert.equal(procesar(entrada('git log --grep=push --oneline'), correr), null)
})

test('prePush: solo se pushea a origin, por nombre y por URL real', () => {
  const raiz = repoFalso()
  const { correr } = correrFalso({ raiz })
  for (const remoto of ['upstream', 'https://github.com/otro/repo.git', '../otro-repo']) {
    const salida = prePush({ push: pushSimple({ remoto, args: [remoto, 'fix/algo'], cabezas: ['fix/algo'], destinos: ['fix/algo'] }), raiz, correr })
    assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny', remoto)
    assert.match(salida.hookSpecificOutput.permissionDecisionReason, /origin/)
  }
  // Sin remoto explicito, el ensayo tiene que ir a la URL de origin (remote.pushDefault, branch.pushRemote...).
  const otroDestino = correrFalso({ raiz, dryRun: ensayo(['*\trefs/heads/fix/algo:refs/heads/fix/algo\t[new branch]'], 'https://github.com/otro/repo.git') })
  const salida = prePush({ push: pushSimple(), raiz, correr: otroDestino.correr })
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /otro\/repo/)
})

test('prePush: un push a main se deniega antes de mirar nada mas, en todas sus formas', () => {
  const raiz = repoFalso()
  for (const push of [
    pushSimple({ destinos: ['main'] }),
    pushSimple({ destinos: ['refs/heads/main'] }),
    pushSimple({ destinos: ['master'] }),
    pushSimple({ cabezas: ['dev'], destinos: ['dev', 'main'] }),
  ]) {
    const { correr, llamadas } = correrFalso({ raiz })
    const salida = prePush({ push, raiz, correr })
    assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(push))
    assert.match(salida.hookSpecificOutput.permissionDecisionReason, /Pull Request/)
    assert.ok(!llamadas.some((l) => l.cmd === process.execPath), 'no hace falta correr el check de secretos')
  }
  // Parado en main sin refspec: HEAD resuelve a main.
  const enMain = correrFalso({ raiz, ramaActual: 'main' })
  assert.equal(prePush({ push: pushSimple(), raiz, correr: enMain.correr }).hookSpecificOutput.permissionDecision, 'deny')
  // Parado en una rama de trabajo: pasa al check de secretos.
  const enRama = correrFalso({ raiz })
  assert.equal(prePush({ push: pushSimple(), raiz, correr: enRama.correr }), null)
  // HEAD detached: no hay rama que proteger, se revisan los secretos.
  const detached = correrFalso({ raiz, ramaActual: null })
  assert.equal(prePush({ push: pushSimple(), raiz, correr: detached.correr }), null)
})

test('prePush: --force y --all/--mirror se deniegan con una razon accionable', () => {
  const raiz = repoFalso()
  const { correr } = correrFalso({ raiz })
  const forzado = prePush({ push: pushSimple({ destinos: ['fix/algo'], cabezas: ['fix/algo'], forzado: true }), raiz, correr })
  assert.equal(forzado.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(forzado.hookSpecificOutput.permissionDecisionReason, /--force-with-lease/)
  const masivo = prePush({ push: pushSimple({ destinos: [], cabezas: ['--branches'], masivo: true }), raiz, correr })
  assert.equal(masivo.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(masivo.hookSpecificOutput.permissionDecisionReason, /--mirror/)
})

test('prePush: FAIL de secretos o de datos sensibles deniega el push con una razon accionable', () => {
  const raiz = repoFalso()
  const { correr, llamadas } = correrFalso({
    raiz,
    grupos: {
      secretos: {
        status: 1,
        stdout: '[OK  ] sin-secretos: sin archivos\n[FAIL] sin-secretos-en-contenido: posibles credenciales en el contenido en commits sin pushear: src/config.js:2 (asignacion-de-secreto)\n[FAIL] sin-datos-sensibles: posibles datos de la organizacion sin autorizar: rrhh/nomina.xlsx (nomina)\n',
      },
    },
  })
  const salida = prePush({ push: pushSimple(), raiz, correr })
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  const razon = salida.hookSpecificOutput.permissionDecisionReason
  assert.match(razon, /src\/config\.js:2/)
  assert.match(razon, /rrhh\/nomina\.xlsx/)
  assert.match(razon, /git rm --cached/)
  assert.match(razon, /\.datos-autorizados/)
  assert.doesNotMatch(razon, /\[OK/, 'al agente solo le llegan los FAIL')
  const args = llamadas.find((l) => l.cmd === process.execPath).args
  assert.ok(args.includes('--sin-pushear'))
  assert.ok(!args.includes('--cabeza'), 'HEAD no se pasa como --cabeza')
})

test('prePush: check en verde no emite nada (nunca "allow": no salta los ask de force-with-lease)', () => {
  const raiz = repoFalso()
  const { correr } = correrFalso({ raiz })
  assert.equal(prePush({ push: pushSimple(), raiz, correr }), null)
})

test('prePush: si el script no pudo verificar, pide confirmacion con el motivo (nunca deja pasar en silencio)', () => {
  const raiz = repoFalso()
  const { correr } = correrFalso({ raiz, grupos: { secretos: { status: 2, stdout: '[ERROR] secretos: no se pudo verificar: fatal\n' } } })
  const salida = prePush({ push: pushSimple(), raiz, correr })
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /no se pudo validar secretos/)
  assert.equal(salida.systemMessage, undefined)
})

test('prePush: revisa la rama nombrada en el refspec con el script confiable del proyecto del hook', () => {
  const raiz = repoFalso()
  const { correr, llamadas } = correrFalso({ raiz })
  prePush({ push: pushSimple({ cabezas: ['fix/otra'], destinos: ['fix/otra'] }), raiz, correr })
  const args = llamadas.find((l) => l.cmd === process.execPath).args
  // Con "=": una ref que empiece con "-" no se lee como otra opcion.
  assert.equal(args.at(-1), '--cabeza=fix/otra')
  assert.notEqual(path.resolve(args[0]), path.resolve(raiz, 'scripts', 'check-pr-rules.mjs'))
})

test('prDeEsteRepo: el modo manual solo acepta PRs del repo de origin, host incluido', () => {
  assert.equal(prDeEsteRepo('https://github.com/org/app/pull/3', 'github.com/org/app'), true)
  assert.equal(prDeEsteRepo('https://github.com/Org/App/pull/3', 'github.com/org/app'), true)
  assert.equal(prDeEsteRepo('https://github.com/otra/org/pull/3', 'github.com/org/app'), false)
  assert.equal(prDeEsteRepo('https://ghes.evil.example/org/app/pull/3', 'github.com/org/app'), false)
  assert.equal(prDeEsteRepo('https://github.com/org/app/pull/3', null), false)
  assert.equal(prDeEsteRepo('12', 'github.com/org/app'), true)
  assert.equal(prDeEsteRepo('http://evil.example/x', 'github.com/org/app'), false)
  // La URL de origin, en todas sus formas, se reduce a host/owner/repo.
  for (const url of ['https://github.com/Org/App.git', 'https://user@github.com/org/app', 'git@github.com:org/app.git', 'ssh://git@github.com:22/org/app.git', 'https://github.com/org/app/']) {
    assert.equal(repoDeUrl(url), 'github.com/org/app', url)
  }
  assert.equal(repoDeUrl('/tmp/remoto.git'), null)
})

test('postPR: FAIL de pr-metadata -> block, comentario publicado con la tabla', () => {
  const raiz = repoFalso()
  const { correr, llamadas } = correrFalso({
    raiz,
    grupos: {
      'pr-metadata': { status: 1, stdout: '[OK  ] pr-apunta-a-dev: base = dev\n[FAIL] security-review-declarado: la casilla de /security-review no esta marcada\n' },
    },
  })
  const resultado = postPR({ objetivo: 'https://github.com/o/r/pull/12', raiz, correr })
  assert.equal(resultado.estado, 'fail')
  const salida = salidaPostToolUse(resultado)
  assert.equal(salida.decision, 'block')
  assert.match(salida.hookSpecificOutput.additionalContext, /\[FAIL\] security-review-declarado/)
  assert.match(salida.hookSpecificOutput.additionalContext, /gh pr edit https:\/\/github\.com\/o\/r\/pull\/12 --body-file/)
  assert.doesNotMatch(salida.hookSpecificOutput.additionalContext, /pr-apunta-a-dev/, 'al agente solo le llega lo que no dio OK')

  const comentario = llamadas.find((l) => l.cmd === 'gh' && l.args[1] === 'comment')
  assert.ok(comentario, 'publica el comentario')
  assert.match(comentario.opciones.input, /coe-harness:reglas-pr/)
  assert.match(comentario.opciones.input, /\| pr-metadata \| FAIL \|/)
  assert.match(comentario.opciones.input, /\| rama-commits \(informativo\) \| OK \|/)
  assert.match(comentario.opciones.input, /abcdef1/)
  const grupos = llamadas.filter((l) => l.cmd === process.execPath)
  assert.equal(grupos.length, 3)
  for (const l of grupos) assert.ok(l.args.includes('https://github.com/o/r/pull/12'))
})

test('postPR: todo OK -> solo contexto, sin block; rama-commits informativo no bloquea', () => {
  const raiz = repoFalso()
  const ok = salidaPostToolUse(postPR({ objetivo: null, raiz, correr: correrFalso({ raiz }).correr }))
  assert.equal(ok.decision, undefined)
  assert.match(ok.hookSpecificOutput.additionalContext, /Los grupos bloqueantes pasaron/)

  const { correr } = correrFalso({ raiz, grupos: { 'rama-commits': { status: 1, stdout: '[FAIL] commits-formato: abc "update"\n' } } })
  const resultado = postPR({ objetivo: null, raiz, correr })
  assert.equal(resultado.estado, 'ok')
  assert.match(resultado.texto, /rama-commits \(informativo\): FAIL/)
})

test('postPR: sin gh (o sin red) no bloquea: avisa que el PR quedo sin validar', () => {
  const raiz = repoFalso()
  const { correr, llamadas } = correrFalso({ raiz, vista: { status: 1, stderr: 'gh: not logged in' } })
  const resultado = postPR({ objetivo: 'https://github.com/o/r/pull/12', raiz, correr })
  assert.equal(resultado.estado, 'error')
  assert.equal(salidaPostToolUse(resultado).decision, undefined)
  assert.match(resultado.texto, /not logged in/)
  assert.ok(!llamadas.some((l) => l.cmd === process.execPath), 'no corre los checks sin datos del PR')
})

test('postPR: un grupo en ERROR no bloquea y pide correr el modo manual; si no se pudo comentar, el agente se entera', () => {
  const raiz = repoFalso()
  const { correr } = correrFalso({ raiz, grupos: { 'pr-metadata': { status: 2, stdout: '[ERROR] pr-metadata: no se pudo verificar: timeout\n' } } })
  const resultado = postPR({ objetivo: null, raiz, correr })
  assert.equal(resultado.estado, 'error')
  assert.match(resultado.texto, /node \.claude\/hooks\/reglas-pr\.mjs --pr/)

  const sinComentario = correrFalso({ raiz, comentario: { status: 1 } })
  assert.match(postPR({ objetivo: null, raiz, correr: sinComentario.correr }).texto, /No se pudo publicar el comentario/)
})

test('procesar: repo sin el script y comandos ajenos -> nada', () => {
  const entradaPush = (cwd) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command: 'git push' } })
  const sinScript = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness sin script '))
  assert.equal(procesar(entradaPush(sinScript), correrFalso({ raiz: sinScript }).correr), null)

  const conScript = repoFalso()
  const { correr, llamadas } = correrFalso({ raiz: conScript })
  assert.equal(procesar({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: conScript, tool_input: { command: 'npm test' } }, correr), null)
  assert.equal(llamadas.length, 0, 'un comando ajeno no dispara ni git')
})

test('procesar: PostToolUse ignora un PR que no es de origin (no corre checks ni comenta)', () => {
  const raiz = repoFalso()
  const { correr, llamadas } = correrFalso({ raiz })
  const salida = procesar(
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: raiz, tool_input: { command: 'gh pr create --fill' }, tool_response: { stdout: 'https://github.com/otro/repo/pull/5\n' } },
    correr,
  )
  assert.match(salida.systemMessage, /no es un PR de este repo/)
  assert.ok(!llamadas.some((l) => l.cmd === 'gh'), 'ni consulta ni comenta un PR ajeno')
  assert.ok(!llamadas.some((l) => l.cmd === process.execPath), 'ni corre los checks')
})

test('procesar: PostToolUse toma la URL de la salida de gh pr create', () => {
  const raiz = repoFalso()
  const { correr, llamadas } = correrFalso({ raiz })
  procesar(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'PowerShell',
      cwd: raiz,
      tool_input: { command: 'gh pr create --base dev --body-file cuerpo.md' },
      tool_response: { stdout: 'https://github.com/o/r/pull/12\n' },
    },
    correr,
  )
  const vista = llamadas.find((l) => l.cmd === 'gh' && l.args[1] === 'view')
  assert.equal(vista.args[2], 'https://github.com/o/r/pull/12')
})

// --- Integracion: el hook y el script reales, como los corre Claude Code -----

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', '-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// Un repo con un origin real (bare, local): el hook ensaya cada push con
// `git push --dry-run`, asi que necesita un remoto que conteste.
function repoReal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness hook pr '))
  const remoto = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness hook remoto '))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', remoto])
  git(dir, 'init', '-q', '-b', 'dev')
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-pr-rules.mjs'))
  fs.mkdirSync(path.join(dir, 'src', 'modulo'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'modulo', 'a.js'), 'export {}\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: raiz')
  git(dir, 'remote', 'add', 'origin', remoto)
  git(dir, 'push', '-q', '-u', 'origin', 'dev')
  git(dir, 'switch', '-q', '-c', 'fix/algo')
  return dir
}

function correrHook(entrada) {
  return execFileSync(process.execPath, [HOOK], { input: JSON.stringify(entrada), encoding: 'utf8' })
}

function push(cwd, comando = 'git push -u origin fix/algo', toolName = 'Bash') {
  return correrHook({ hook_event_name: 'PreToolUse', tool_name: toolName, cwd, tool_input: { command: comando } })
}

test('hook real: un push que sube un .env.staging queda denegado', () => {
  const dir = repoReal()
  fs.writeFileSync(path.join(dir, '.env.staging'), 'TOKEN=x\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'feat: config')

  const salida = JSON.parse(push(dir))
  assert.equal(salida.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /\.env\.staging/)
})

test('hook real: una contrasena en el codigo y una nomina quedan denegadas, con ruta y motivo', () => {
  const dir = repoReal()
  fs.writeFileSync(path.join(dir, 'src', 'modulo', 'db.js'), 'export const db = { password: "Sup3rS3cr3t!" }\n') // coe:no-secreto (fixture)
  fs.mkdirSync(path.join(dir, 'rrhh'))
  fs.writeFileSync(path.join(dir, 'rrhh', 'nomina-2026.csv'), 'legajo,nombre\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'feat: datos')

  const salida = JSON.parse(push(dir))
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /src\/modulo\/db\.js:1 \(asignacion-de-secreto\)/)
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /rrhh\/nomina-2026\.csv \(nomina/)
})

test('hook real: tambien desde una subcarpeta y desde la tool PowerShell', () => {
  const dir = repoReal()
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{}\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'feat: credenciales')

  const desdeSub = JSON.parse(push(path.join(dir, 'src', 'modulo'), 'git push'))
  assert.equal(desdeSub.hookSpecificOutput.permissionDecision, 'deny')
  const powershell = JSON.parse(push(dir, 'git push origin HEAD', 'PowerShell'))
  assert.equal(powershell.hookSpecificOutput.permissionDecision, 'deny')
})

test('hook real: push limpio -> stdout vacio; push a main, --force y --all -> denegados aunque el contenido este limpio', () => {
  const dir = repoReal()
  fs.writeFileSync(path.join(dir, '.env.example'), 'TOKEN=\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'feat: plantilla de entorno')
  assert.equal(push(dir), '', 'check en verde: sin salida')
  assert.equal(push(dir, 'git push origin fix/algo:dev'), '', 'un push a dev se permite')

  for (const comando of [
    'git push origin HEAD:main',
    'git push origin HEAD:heads/main',
    'git push origin +HEAD:heads/main',
    'git push origin fix/algo:master',
    'git push origin :main',
    'git push origin --delete main',
    'git push --force origin fix/algo',
    'git push -f',
    'git push --all origin',
    'git push origin :',
    'git push upstream fix/algo',
    'git push https://github.com/otro/repo.git fix/algo',
    'git push origin fix/algo && git push origin HEAD:main',
  ]) {
    const salida = JSON.parse(push(dir, comando))
    assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny', comando)
  }
  assert.match(JSON.parse(push(dir, 'git push origin HEAD:main')).hookSpecificOutput.permissionDecisionReason, /`main`/)

  // Lo que el texto no resuelve pide confirmacion: expansiones del shell, git -c, --no-verify,
  // opciones abreviadas, variables de entorno, un cambio de rama o un commit antes del push.
  for (const [comando, tool] of [
    ['git push origin HEAD:ma{i,}n'],
    ['git push origin HEAD:$(printf main)'],
    ['git -c push.default=upstream push origin'],
    ['git push --no-verify origin fix/algo'],
    ['git push --recei=/tmp/x origin fix/algo'],
    ['GIT_CONFIG_PARAMETERS="\'push.default=upstream\'" git push origin'],
    ['git checkout main && git push origin'],
    ['git add -A && git commit -m "feat: x" && git push -u origin fix/algo'],
    ['git push --force-with-lease origin fix/algo'],
    ['$env:GIT_CONFIG_PARAMETERS="\'push.default=upstream\'"; git push origin', 'PowerShell'],
  ]) {
    const salida = JSON.parse(push(dir, comando, tool ?? 'Bash'))
    assert.equal(salida.hookSpecificOutput.permissionDecision, 'ask', comando)
  }

  // Un push que no tiene nada que subir (rama al dia) tambien se ensaya y pasa en silencio.
  git(dir, 'push', '-q', '-u', 'origin', 'fix/algo')
  assert.equal(push(dir, 'git push origin fix/algo'), '', 'rama al dia: sin salida')
  assert.equal(push(dir, 'git push -q origin fix/algo'), '', 'con -q el ensayo va sin -q')

  // Texto inocente, pero la configuracion del repo manda el push a main: lo descubre el ensayo de git.
  git(dir, 'push', '-q', 'origin', 'dev:main')
  git(dir, 'branch', '-q', '--set-upstream-to=origin/main', 'fix/algo')
  git(dir, 'config', 'push.default', 'upstream')
  const porUpstream = JSON.parse(push(dir, 'git push origin'))
  assert.equal(porUpstream.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(porUpstream.hookSpecificOutput.permissionDecisionReason, /segun git/)
  // Con -q el porcelain quedaria vacio: el ensayo va sin -q y lo descubre igual.
  assert.equal(JSON.parse(push(dir, 'git push -q origin')).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(JSON.parse(push(dir, 'git push --quiet origin')).hookSpecificOutput.permissionDecision, 'deny')
  git(dir, 'config', '--unset', 'push.default')
  git(dir, 'branch', '-q', '--unset-upstream', 'fix/algo')

  // Parado en main, un `git push` a secas tambien va a main.
  git(dir, 'switch', '-q', 'dev')
  git(dir, 'switch', '-q', '-c', 'main')
  assert.equal(JSON.parse(push(dir, 'git push')).hookSpecificOutput.permissionDecision, 'deny')
})

test('hook real: otro repo sin el script del harness no lleva check', () => {
  const dir = repoReal()
  const ajeno = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness ajeno '))
  git(ajeno, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(ajeno, '.env'), 'X=1\n')
  git(ajeno, 'add', '-A', '--force')
  git(ajeno, 'commit', '-q', '-m', 'chore: x')
  assert.equal(push(dir, `git -C "${ajeno}" push`), '')
  assert.equal(push(dir, `cd "${ajeno}" && git push`), '')
})

test('hook real: nunca ejecuta el check-pr-rules.mjs del repo destino (cd a un repo ajeno)', () => {
  const dir = repoReal()
  const ajeno = repoReal()
  const marca = path.join(ajeno, 'ejecutado.txt')
  // Un script "malicioso" en el repo ajeno: si el hook lo corriera, dejaria la marca.
  fs.writeFileSync(
    path.join(ajeno, 'scripts', 'check-pr-rules.mjs'),
    `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marca)}, 'x')\n`,
  )
  fs.writeFileSync(path.join(ajeno, '.env.staging'), 'X=1\n')
  git(ajeno, 'add', '-A')
  git(ajeno, 'commit', '-q', '-m', 'feat: x')

  const salida = JSON.parse(push(dir, `cd "${ajeno}" && git push`))
  assert.ok(!fs.existsSync(marca), 'se ejecuto el script del repo destino')
  // Igual se revisa, con el script confiable del proyecto del hook.
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
})

test('hook real: el push de un tag sobre un commit con secreto se deniega', () => {
  const dir = repoReal()
  fs.writeFileSync(path.join(dir, 'llave.pem'), 'x\n')
  git(dir, 'add', '-A', '--force')
  git(dir, 'commit', '-q', '-m', 'feat: llave')
  git(dir, 'tag', 'v9.9.9')
  git(dir, 'reset', '-q', '--hard', 'HEAD~1')
  const salida = JSON.parse(push(dir, 'git push origin v9.9.9'))
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /llave\.pem/)
})

// Las formas que la revision final encontro en silencio: carpeta mal resuelta,
// entorno o funciones cargados en el mismo comando, git envuelto, alias.
test('hook real: carpetas, envoltorios, entorno cargado y alias: nada pasa en silencio', () => {
  const dir = repoReal()
  fs.writeFileSync(path.join(dir, 'env.sh'), 'export GIT_CONFIG_COUNT=1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: entorno')
  const posix = process.platform === 'win32' ? `/${dir[0].toLowerCase()}${dir.slice(2).replace(/\\/g, '/')}` : dir
  for (const [comando, tool] of [
    ['cd .. && cd - && git push origin HEAD:main'],
    ['pushd .. && popd && git push origin HEAD:main'],
    [`cd "${posix}" && git push origin HEAD:main`],
    ['env git push origin HEAD:main'],
    ['cmd /c git push origin HEAD:main'],
    ['git -C "$PWD" push origin HEAD:main'],
    ['Set-Location ..; Set-Location -; git push origin HEAD:main', 'PowerShell'],
  ]) {
    assert.equal(JSON.parse(push(dir, comando, tool ?? 'Bash')).hookSpecificOutput.permissionDecision, 'deny', comando)
  }
  for (const [comando, tool] of [
    ['source env.sh; git push origin fix/algo'],
    ['. env.sh && git push origin fix/algo'],
    ['eval "$(cat env.sh)"; git push origin fix/algo'],
    ['git() { command git "$@"; }; git push origin fix/algo'],
    ["sh -c 'git push origin fix/algo'"],
    ['s=push; git $s origin fix/algo'],
    ['env git push origin fix/algo'],
    ['cd "$PWD" && git push origin fix/algo'],
    ['git -C "$PWD" push origin fix/algo'],
    ['cd /no/existe 2>/dev/null; git push origin fix/algo'],
    ['$a="push"; git $a origin fix/algo', 'PowerShell'],
    ['. .\\env.ps1; git push origin fix/algo', 'PowerShell'],
    ['function git { git.exe $args }; git push origin fix/algo', 'PowerShell'],
  ]) {
    assert.equal(JSON.parse(push(dir, comando, tool ?? 'Bash')).hookSpecificOutput.permissionDecision, 'ask', comando)
  }
  assert.equal(push(dir, `cd "${posix}" && git push -u origin fix/algo`), '', 'una ruta literal se resuelve y el push limpio pasa')

  // Un alias que hace push se analiza como push; uno que no, no molesta.
  git(dir, 'config', 'alias.p', 'push')
  git(dir, 'config', 'alias.st', 'status')
  assert.equal(JSON.parse(push(dir, 'git p origin HEAD:main')).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(JSON.parse(push(dir, 'git p origin fix/algo')).hookSpecificOutput.permissionDecision, 'ask')
  assert.equal(push(dir, 'git st'), '')
  assert.equal(push(dir, 'git st && git push -u origin fix/algo'), '')

  // Parado en main, las formas que esconden la carpeta o envuelven a git tambien se deniegan.
  git(dir, 'switch', '-q', '-c', 'main')
  assert.equal(JSON.parse(push(dir, 'cd .. && cd - && git push origin')).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(JSON.parse(push(dir, 'env git push origin')).hookSpecificOutput.permissionDecision, 'deny')
})

test('hook real: un pushurl o un pushInsteadOf que desvia origin a otro repo se deniega', () => {
  const dir = repoReal()
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-harness evil '))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', evil])
  git(dir, 'remote', 'set-url', '--push', 'origin', evil)
  const salida = JSON.parse(push(dir, 'git push -u origin fix/algo'))
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /pushurl|pushInsteadOf/)
  git(dir, 'config', '--unset', 'remote.origin.pushurl')
  assert.equal(push(dir, 'git push -u origin fix/algo'), '')
})

test('hook real: una autorizacion nueva en .datos-autorizados sube a la rama de trabajo pero no directo a dev', () => {
  const dir = repoReal()
  fs.writeFileSync(path.join(dir, '.datos-autorizados'), 'rrhh/nomina-2026.xlsx   # autorizado por Gerencia\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: autorizacion')
  assert.equal(push(dir, 'git push -u origin fix/algo'), '')
  const salida = JSON.parse(push(dir, 'git push origin HEAD:dev'))
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /datos-autorizados/)
})

test('hook real: comandos que no son push ni PR no producen nada', () => {
  const dir = repoReal()
  assert.equal(push(dir, 'npm test'), '')
  assert.equal(
    correrHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command: 'gh pr view 12' }, tool_response: {} }),
    '',
  )
})

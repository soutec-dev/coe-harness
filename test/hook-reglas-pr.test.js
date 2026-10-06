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

test('pushDelComando: --force, -f y +refspec se marcan forzados; --force-with-lease no', () => {
  assert.equal(pushDelComando('git push --force origin fix/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push -f origin fix/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push -uf origin fix/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push origin +fix/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push origin +HEAD:refs/heads/x', CWD).forzado, true)
  assert.equal(pushDelComando('git push --force-with-lease origin fix/x', CWD).forzado, false)
  assert.equal(pushDelComando('git push --force-with-lease=fix/x origin fix/x', CWD).forzado, false)
  assert.equal(pushDelComando('git push -u origin fix/x', CWD).forzado, false)
})

test('pushDelComando: tags, --all y --mirror revisan lo que de verdad suben, y --all/--mirror son masivos', () => {
  assert.deepEqual(pushDelComando('git push origin v1.2.0', CWD).cabezas, ['v1.2.0'])
  assert.deepEqual(pushDelComando('git push origin refs/tags/v1', CWD).cabezas, ['refs/tags/v1'])
  assert.deepEqual(pushDelComando('git push --tags', CWD).cabezas, ['--tags'])
  assert.deepEqual(pushDelComando('git push --follow-tags', CWD).cabezas, ['HEAD', '--tags'])
  assert.deepEqual(pushDelComando('git push --all origin', CWD).cabezas, ['--branches'])
  assert.equal(pushDelComando('git push --all origin', CWD).masivo, true)
  assert.equal(pushDelComando('git push --mirror origin', CWD).masivo, true)
  assert.equal(pushDelComando('git push --tags', CWD).masivo, false)
})

test('pushDelComando: los borrados se reconocen (sin cabezas que escanear) y los comandos sin push no llevan check', () => {
  const conDelete = pushDelComando('git push origin --delete fix/x', CWD)
  assert.deepEqual(conDelete.borrados, ['fix/x'])
  assert.deepEqual(conDelete.cabezas, [])
  assert.deepEqual(pushDelComando('git push origin :fix/x', CWD).borrados, ['fix/x'])
  assert.deepEqual(pushDelComando('git push origin :main', CWD).borrados, ['main'])
  assert.deepEqual(pushDelComando('git push origin -d main', CWD).borrados, ['main'])
  for (const comando of ['git commit -m "despues hago git push"', 'git status', 'echo git push']) {
    assert.equal(pushDelComando(comando, CWD), null, comando)
  }
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

function correrFalso({ raiz, ramaActual = 'fix/algo', grupos = {}, vista = { status: 0 }, comentario = { status: 0 }, dryRun }) {
  const llamadas = []
  const porcelain = dryRun ?? ensayo(['*\trefs/heads/fix/algo:refs/heads/fix/algo\t[new branch]'])
  const correr = (cmd, args, opciones = {}) => {
    llamadas.push({ cmd, args, opciones })
    if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${raiz}\n`, stderr: '' }
    if (cmd === 'git' && args[0] === 'symbolic-ref') return ramaActual ? { status: 0, stdout: `${ramaActual}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' }
    if (cmd === 'git' && args[0] === 'push') return porcelain
    if (cmd === 'git' && args[0] === 'remote') return { status: 0, stdout: `${URL_ORIGEN}\n`, stderr: '' }
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
  args: [],
  remoto: null,
  configs: [],
  riesgosas: [],
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
  // Borrar otra rama no sube commits: nada que escanear.
  assert.equal(prePush({ push: pushSimple({ cabezas: [], destinos: [], borrados: ['fix/vieja'] }), raiz, correr }), null)

  // Texto inocente (`git push origin`), pero git resuelve a main por push.default o el upstream: deny por el ensayo.
  const upstreamEnMain = correrFalso({ raiz, dryRun: ensayo([' \trefs/heads/fix/algo:refs/heads/main\t[ok]']) })
  const salida = prePush({ push: pushSimple({ remoto: 'origin', args: ['origin'] }), raiz, correr: upstreamEnMain.correr })
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /segun git/)
  const ensayado = upstreamEnMain.llamadas.find((l) => l.cmd === 'git' && l.args[0] === 'push')
  assert.deepEqual(ensayado.args.slice(0, 4), ['push', '--dry-run', '--porcelain', '--no-verify'])
})

test('prePush: lo que el hook no puede resolver pide confirmacion, nunca pasa en silencio', () => {
  const raiz = repoFalso()
  const { correr } = correrFalso({ raiz })
  for (const push of [pushSimple({ metacaracteres: true }), pushSimple({ configs: ['push.default=upstream'] }), pushSimple({ riesgosas: ['--no-verify'] })]) {
    const salida = prePush({ push, raiz, correr })
    assert.equal(salida.hookSpecificOutput.permissionDecision, 'ask', JSON.stringify(push))
    assert.match(salida.hookSpecificOutput.permissionDecisionReason, /no puedo asegurar/)
  }
  // git no pudo ensayar el push (sin upstream, sin red): tambien ask, con el motivo.
  const sinEnsayo = correrFalso({ raiz, dryRun: { status: 128, stdout: '', stderr: 'fatal: The current branch fix/algo has no upstream branch.\n' } })
  const salida = prePush({ push: pushSimple(), raiz, correr: sinEnsayo.correr })
  assert.equal(salida.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(salida.hookSpecificOutput.permissionDecisionReason, /no upstream/)
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

test('prDeEsteRepo: el modo manual solo acepta PRs del repo de origin', () => {
  assert.equal(prDeEsteRepo('https://github.com/org/app/pull/3', 'org/app'), true)
  assert.equal(prDeEsteRepo('https://github.com/Org/App/pull/3', 'org/app'), true)
  assert.equal(prDeEsteRepo('https://github.com/otra/org/pull/3', 'org/app'), false)
  assert.equal(prDeEsteRepo('https://github.com/org/app/pull/3', null), false)
  assert.equal(prDeEsteRepo('12', 'org/app'), true)
  assert.equal(prDeEsteRepo('http://evil.example/x', 'org/app'), false)
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
    'git push upstream fix/algo',
    'git push https://github.com/otro/repo.git fix/algo',
  ]) {
    const salida = JSON.parse(push(dir, comando))
    assert.equal(salida.hookSpecificOutput.permissionDecision, 'deny', comando)
  }
  assert.match(JSON.parse(push(dir, 'git push origin HEAD:main')).hookSpecificOutput.permissionDecisionReason, /`main`/)

  // Lo que el texto no resuelve pide confirmacion: expansiones del shell, git -c, --no-verify.
  for (const comando of ['git push origin HEAD:ma{i,}n', 'git push origin HEAD:$(printf main)', 'git -c push.default=upstream push origin', 'git push --no-verify origin fix/algo']) {
    const salida = JSON.parse(push(dir, comando))
    assert.equal(salida.hookSpecificOutput.permissionDecision, 'ask', comando)
  }

  // Texto inocente, pero la configuracion del repo manda el push a main: lo descubre el ensayo de git.
  git(dir, 'push', '-q', 'origin', 'dev:main')
  git(dir, 'branch', '-q', '--set-upstream-to=origin/main', 'fix/algo')
  git(dir, 'config', 'push.default', 'upstream')
  const porUpstream = JSON.parse(push(dir, 'git push origin'))
  assert.equal(porUpstream.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(porUpstream.hookSpecificOutput.permissionDecisionReason, /segun git/)
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

test('hook real: comandos que no son push ni PR no producen nada', () => {
  const dir = repoReal()
  assert.equal(push(dir, 'npm test'), '')
  assert.equal(
    correrHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command: 'gh pr view 12' }, tool_response: {} }),
    '',
  )
})

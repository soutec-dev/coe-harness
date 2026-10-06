# 03 — Resumen de la remediación

Tres ciclos de remediación, el máximo que admite la skill. El primero (`41100bf`
más un ajuste a `excepciones-nuevas`) cerró los hallazgos H-01 a H-14 del informe
inicial; la revisión final del ciclo 1 encontró un High nuevo (N-01) y varios
Medium/Low, y el segundo ciclo (`d9c52d8`, `1930816`, `3501be0`) los cerró; la
revisión final del ciclo 2 encontró otro High de la misma clase (R-01: pushes que
el hook no modelaba y dejaba pasar en silencio) y tres Medium, y el tercer ciclo
(`79e909d`) los cerró cambiando el principio del hook: **todo lo que no puede
analizar con certeza pide confirmación**. El detalle de cada ciclo está en las
secciones "Segundo ciclo" y "Tercer ciclo" al final. Suite tras el ciclo 3: **171
tests, 171 pass** (ver `04-test-evidence.md`).

## Ciclo 1

Commit principal: `41100bf` (rama `dev`), más un ajuste menor posterior a la regla
informativa `excepciones-nuevas` (ver "Ajuste posterior"). Suite tras el ciclo 1:
149 tests, 149 pass; `verify --strict` en verde; el propio check de secretos del
harness sobre los commits en verde.

## Archivos modificados (ciclo 1)

| Archivo | Hallazgos | Cambio |
|---|---|---|
| `templates/base/claude/hooks/reglas-pr.mjs` (y su copia `.claude/hooks/`) | H-01, H-02, H-10, H-11 | `pushDelComando` expone remoto, `args`, `-c`, opciones riesgosas, metacaracteres y borrados; `ramaDeDestino` normaliza `heads/x`; `prePush` deniega remotos distintos de `origin` y borrados de `main`, escanea secretos, pide confirmación (`ask`) ante metacaracteres/`-c`/opciones raras/errores, y ensaya el push con `git push --dry-run --porcelain --no-verify` (`destinosSegunGit`, `parsePorcelain`, `mismaUrl`) denegando si el destino real es `main` o la URL no es la de `origin`; el PostToolUse solo actúa sobre PRs de `origin`; un error interno del hook pide confirmación en vez de permitir |
| `templates/base/scripts/check-pr-rules.mjs` (y su copia `scripts/`) | H-06, H-07, H-08, H-12 | `.datos-autorizados` se lee de `origin/dev` (fallback al working tree solo si `origin/dev` no existe); regla `excepciones-nuevas`; pre-chequeos `requiere` y `includes('@')` antes de las regex cuadráticas, tope `MAX_LINEA = 20000` contado y avisado; `logSinPushear` con `--remerge-diff` (fallback `-m --first-parent`); `pareceSecreto` acepta `$` en medio y descarta solo expresiones |
| `templates/base/claude/settings.json` (y su copia) | H-01, H-06, H-13 | Hooks sin filtro `if` (timeouts 90/240 s); `deny` de `Edit` sobre `.claude/hooks/**`, `.claude/settings.json`, `scripts/check-pr-rules.mjs`, `.datos-autorizados`, `.github/workflows/**`; `ask` para `git -c`, `git push --no-verify`, `gh api -X/--method/-f/-F` |
| `src/core/plan.js`, `src/core/apply.js`, `src/core/verify.js`, `src/commands/_shared.js` | H-03 | `destSeguro()` filtra los `dest` del lockfile y de `manifest.obsolete` (`destsIgnorados`, reportados); `rutaSegura()` bloquea borrados, respaldos y escrituras fuera de `cwd`; `verify` falla ante un `dest` inseguro |
| `src/core/github-protect.js` | H-04, H-05 | `fusionarProteccion(existente)` lee la protección vigente y solo endurece; `protegeDev` deja `dev` sin force-push ni borrado (sin PR obligatorio, sin tocar una protección existente) |
| `templates/base/github/workflows/*.yml`, `.github/workflows/ci.yml`, `package.json` | H-09 | Acciones fijadas por SHA (`actions/checkout@11bd719…` v4.2.2, `actions/setup-node@49933ea…` v4.4.0); dependencias con versión exacta |
| `src/commands/_shared.js` | H-14 | `OWNER` por defecto `por definir` (ya no toma `git config user.name`) |
| Skills `coe-github`, `datos-sensibles`, `harness-upgrade`, plantilla `.datos-autorizados`, `README.md`, `CHANGELOG.md` | H-05, H-09, H-12, H-13, H-16 | Documentación honesta de límites y condiciones: solo `origin`, `ask` no se confirma a ciegas, autorizaciones valen en `dev`, qué no escanea, 0 aprobaciones ⇒ check controlado por el autor (recomendación de 1 aprobación + code owners), `#v1` móvil y cómo fijar versión |
| `.gitattributes` (nuevo) | — | `* text=auto eol=lf`: el motor escribe LF y los tests comparan copias byte a byte; con `core.autocrlf=true` el checkout dejaba CRLF |

## Pruebas agregadas o adaptadas (regresión y controles negativos)

- `test/hook-reglas-pr.test.js`: `heads/main`, `+HEAD:heads/main`, `:main`,
  `--delete main`, `upstream`/URL como remoto, `ma{i,}n`, `$(printf main)`,
  `git -c push.default=upstream`, `--no-verify`, destino real `main` por upstream
  (ensayo), URL del ensayo distinta de `origin`, error del script ⇒ `ask`,
  PostToolUse sobre un PR ajeno; los tests de integración usan un `origin` real
  (bare) para que el ensayo conteste.
- `test/check-pr-rules.test.js`: `pareceSecreto` con `$` en medio y expresiones;
  línea de 19 000 caracteres escaneada en < 1,5 s y línea de 120 000 contada;
  `excepcionesNuevas`; autorización que viaja en la misma rama ⇒ FAIL, en `dev` ⇒
  OK; evil merge (`--no-ff --no-commit` + `.env.staging` + contraseña) ⇒ FAIL.
- `test/migrate.test.js`: `dest` con `..` y `.git/HEAD` en el lockfile ⇒ ignorados y
  reportados, sin borrado ni copia; `apply` lanza ante una ruta fuera del repo.
- `test/unit.test.js`: `fusionarProteccion` (no rebaja; une checks; conserva
  restricciones), `proteccionDev`, `destSeguro`.
- `test/verify.test.js`: `findUnsafeDests`.

## Resultados

- `npm test`: 149/149 (antes 135). `node bin/cli.mjs verify --strict`: consistente.
- `node scripts/check-pr-rules.mjs --grupo secretos --sin-pushear` sobre el commit
  de remediación: `[OK]` en secretos, contenido y datos.
- `node bin/cli.mjs upgrade --yes` sobre este repo: la protección de `main` se
  reaplicó conservando lo existente y `dev` quedó sin force-push ni borrado
  (verificable en Settings > Branches del repo).

## Riesgos residuales tras la remediación

- **H-05 (riesgo aceptado con condiciones)**: con 0 aprobaciones obligatorias el
  autor de un PR controla el script del check requerido. Condición cumplida:
  documentado en README ("Seguridad: qué garantiza y qué no") y en
  `github-protect.js`; `init`/`upgrade` nunca rebajan una configuración más
  estricta.
- **H-09 (riesgo aceptado con condiciones)**: `#v1` sigue siendo móvil por diseño.
  Condiciones: acciones por SHA y dependencias exactas (hechas); opción de fijar
  `#vX.Y.Z` documentada en `harness-upgrade`; ruleset activo en el repo del
  harness (`tags inmutables vX.Y.Z`, id 24591508) que bloquea `update`,
  `deletion` y `non_fast_forward` sobre `refs/tags/v[0-9]*.[0-9]*.[0-9]*` — el
  tag móvil `v1` queda fuera a propósito para que `tag-release.yml` pueda moverlo.
- **Alias de git y `pre-push` del desarrollador**: fuera del alcance del hook
  (trabaja sobre el texto del comando y el ensayo de git). Mitigación: protección
  de `main` en GitHub donde el plan la ofrece. Mejora futura anotada: un
  `pre-push` instalado por el harness.
- **H-12**: las palabras de ejemplo siguen eximiendo valores (falsos positivos
  cuestan un push denegado); documentado en la skill.

## Ajuste posterior al inicio de la revisión final

La regla informativa `excepciones-nuevas` contaba como "marcador nuevo" toda línea
agregada que contuviera el texto `coe:no-secreto`, incluidas las que solo lo
mencionan (documentación, el propio script, estos informes): el autocheck del
commit de remediación listó 15 "marcadores", de los que ninguno eximía nada. Se
ajustó para contar solo las líneas donde el marcador exime de verdad un hallazgo
(`patronDeSecreto(l)`), con su test (una mención en `.md` no cuenta; un token con
marcador sí). Es un cambio de reporte, no de bloqueo; se registra aquí porque
entró después de lanzada la revisión final.

## Segundo ciclo — hallazgos de la revisión final del ciclo 1 (N-01 a N-13)

Commits: `d9c52d8` (remediación principal, 22 archivos), `1930816` (N-10 y cierres
de N-12), `3501be0` (regenera la copia dogfood del hook, que el commit anterior
había dejado desfasada de su plantilla; el test de dogfood lo detectó). Suite tras
el ciclo: 158 tests, 158 pass; `verify --strict` en verde; autocheck de secretos en
verde sobre los tres commits; `npm audit --omit=dev` sin vulnerabilidades.

| Hallazgo | Estado | Cambio |
|---|---|---|
| N-01 (High) caminos silenciosos a `main` | Cerrado | `reglas-pr.mjs`: el refspec `:`/`+:` se deniega como masivo; `queCambia()` marca los segmentos previos al push que cambian la rama, el remoto, la configuración o el entorno (`git checkout/switch/config/remote/branch/symbolic-ref/update-ref/worktree`, `export`, `set`, `VAR=…`, `$env:`, `SetEnvironmentVariable`) y los que cambian los commits (`git commit/merge/rebase/cherry-pick/am/apply/revert/stash/reset/pull/tag`) → `ask`; una asignación de entorno delante del propio push → `ask`; `argsDelEnsayo()` quita `-q`/`--quiet` (también dentro de un grupo corto) y el ensayo lleva `--verbose`; un ensayo con exit 0 sin `To` ni refs → `ask`; el retorno temprano sin cabezas se eliminó (el ensayo corre también para `--delete`); `pushesDelComando()` devuelve todos los `git push` del comando y `procesar` los evalúa todos (deny > ask > null). Costo asumido: `git commit … && git push` pide confirmación; la regla "el push va solo, en su propio comando" queda en la skill `coe-github` y en el `CLAUDE.md` distribuido |
| N-02 opciones abreviadas y grupos cortos | Cerrado | Lista cerrada `LARGAS_CONOCIDAS` de opciones completas: lo desconocido o abreviado (`--recei=`, `--forc`) → `desconocidas` → `ask`, y no llega al ensayo; en grupos cortos cualquier `f` fuerza (deny), cualquier `o` es push-option (ask), letra desconocida → ask; `--force-with-lease`/`--force-if-includes` → `ask`; `--git-dir`/`--work-tree`/`--namespace` → `ask` (y `--git-dir` resuelve el repo); `--` termina las opciones |
| N-03 sombra de `origin/dev` | Cerrado | `check-pr-rules.mjs`: `DEV_REMOTA = 'refs/remotes/origin/dev'` para `.datos-autorizados` y `refExiste`; `resuelveRef` → `refs/remotes/origin/<rama>`; test con `git tag origin/dev` |
| N-04 presupuesto vs timeout | Cerrado | `PRESUPUESTO_MS = 100_000` en `prePush`: cada llamada se acota al tiempo restante y, agotado, devuelve `ask`; varios push del mismo comando comparten el presupuesto; timeouts de `settings.json` 120 s (PreToolUse) / 300 s (PostToolUse); `MAX_LINEA` 20 000 → 8 000. El escaneo sigue siendo una invocación por cabeza (acotada por el presupuesto) |
| N-05 reglas sin espejo PowerShell | Cerrado | Cada regla `Bash(...)` de `settings.json` tiene su `PowerShell(...)` en deny/allow/ask; test que lo exige |
| N-06 claves con prefijo | Cerrado | `(?<![A-Za-z0-9])` en lugar de `\b` y variante camelCase sensible a mayúsculas; tests `DB_PASSWORD=`, `MYSQL_ROOT_PASSWORD=`, `db_password:`, `smtpPassword =` (y `maxTokens`/`isTokenValid` no) |
| N-07 GET fallido ≠ sin protección | Cerrado | `sinProteccion(err)` solo acepta 404/"Branch not protected"; otro error → no se hace PUT y el mensaje distingue plan/permiso/otro; `fusionarProteccion` conserva `app_id`, `bypass_pull_request_allowances`, `dismissal_restrictions.apps`, `lock_branch`, `block_creations`, `allow_fork_syncing` |
| N-08 validación léxica de rutas | Cerrado | `destSeguro` rechaza `.git` en cualquier segmento sin distinguir mayúsculas; `apply.js` compara la ruta real del directorio padre (`realpathSync.native` del primer ancestro existente) y protege también `plan.dirs`; `verify` valida `manifest.dirs`; tests (`.GIT/HEAD`, symlink/junction hacia fuera, `dirs` fuera del repo) |
| N-09 cuadraticidad bajo el tope | Mitigado (residual aceptado) | Tope de línea a 8 000 caracteres (~150 ms por línea con `@`/`://` frente a ~1,3 s a 19 000); la cuadraticidad bajo el tope persiste y, en el peor caso, degrada a `ask`, nunca a silencio. Documentado en README |
| N-10 última URL y host | Cerrado | `prDeEsteRepo` compara `host/owner/repo` (`repoDeUrl` normaliza https, ssh:// y `git@host:`); el PostToolUse toma la primera URL propia de la salida |
| N-11 formas de `gh api` | Cerrado | `ask` para `gh api -X*`, `--method*`, `-f*`, `-F*`, `--field*`, `--raw-field*`, `--input*` y sus espejos PowerShell |
| N-12 residuales | Cerrado en parte | `OWNER` del lockfile dogfood → `soutec-dev`; `npm-shrinkwrap.json` fija las transitivas para `npx github:`; README documenta el alcance de las cuentas admin y la recomendación de 2FA. **No** se deniega `Edit` sobre `templates/base/**` en este repo: es la fuente que mantienen los desarrolladores del harness y la revisión del PR es el control (riesgo aceptado). Los tags llegan con el release (H-15) |
| N-13 (Info) conjunto "sin pushear" | Abierto, aceptado | Un `update-ref`/`fetch .` sobre `refs/remotes/origin/*` encoge el conjunto escaneado; requiere comandos que no forman parte del flujo y CI vuelve a escanear el PR. Mejora futura anotada: comparar contra `git ls-remote origin` cuando haya red |

### Pruebas agregadas en el ciclo 2

- `test/hook-reglas-pr.test.js`: `:`/`+:` masivos; `-4fu`; `--force-with-lease`
  como reescritura; opciones abreviadas/desconocidas y `-uo`; `--`; `entorno`;
  `--git-dir`/`--work-tree`; `cambiosPrevios` (checkout, commit, merge, export,
  `$env:`); varios push por comando; `argsDelEnsayo`; el ensayo corre sin cabezas;
  `-q` fuera del ensayo y porcelain vacío ⇒ `ask`; nueve formas de duda ⇒ `ask`;
  secreto con destino dudoso ⇒ `deny`; presupuesto agotado ⇒ `ask` y timeouts
  acotados; `procesar` con dos push (deny > ask > null); hook real: `git push origin
  :`, `fix/algo && HEAD:main`, `--recei=`, variable de entorno, `git checkout main
  &&`, `git commit &&`, `--force-with-lease`, `$env:` en PowerShell ⇒ `ask`/`deny`;
  rama al día y `-q` ⇒ pasan; `-q`/`--quiet` con upstream en `main` ⇒ `deny`;
  `prDeEsteRepo`/`repoDeUrl` con host.
- `test/check-pr-rules.test.js`: tope 8 000; claves con prefijo y camelCase; tag
  `origin/dev` sombra ⇒ FAIL se mantiene.
- `test/unit.test.js`: `fusionarProteccion` conserva `app_id`, bypass, `lock_branch`,
  `block_creations`; `sinProteccion`; `destSeguro` con `.GIT` en cualquier segmento;
  espejo PowerShell de cada regla y de los matchers.
- `test/verify.test.js`: `manifest.dirs` inseguro. `test/migrate.test.js`: `dirs`
  fuera del repo y symlink/junction hacia fuera ⇒ bloqueados.

### Riesgos residuales tras el ciclo 2

- Los del ciclo 1 que siguen vigentes (H-05 con 0 aprobaciones, H-09 tag móvil,
  alias de git y `pre-push` del desarrollador, palabras de ejemplo en H-12).
- N-09 (cuadraticidad bajo el tope, degrada a `ask`), N-12 parcial (`Edit` sobre la
  fuente de las plantillas en este repo) y N-13 (refs locales bajo
  `refs/remotes/origin/*`), con las condiciones de arriba.
- Fricción asumida: un comando que encadena `git commit` (o un cambio de rama) con
  `git push` pide confirmación. Es deliberado: el hook solo puede garantizar lo que
  ve en el momento en que corre.

## Tercer ciclo — hallazgos de la revisión final del ciclo 2 (R-01 a R-09)

Commit: `79e909d`. Suite tras el ciclo: 171 tests, 171 pass; `verify --strict` en
verde; autocheck de secretos en verde; `npm audit --omit=dev` sin vulnerabilidades.
El principio que ordena el ciclo: el hook reconoce la forma canónica del push
(`git push [-u] origin <rama>`, con `cd <ruta literal> &&` o `git -C <ruta>` si hace
falta) y **todo lo demás que mencione git de una forma que no puede analizar termina
en `ask`**, nunca en silencio.

| Hallazgo | Estado | Cambio |
|---|---|---|
| R-01 (High) pushes no modelados | Cerrado | **Carpetas**: `aplicaCd`/`resuelveRuta` siguen `cd -` (carpeta anterior), `pushd`/`popd` y `Push-Location`/`Pop-Location` (pila), `cd` a secas y `~` (home) y traducen las rutas POSIX de Git Bash en Windows (`/c/…`, `/cygdrive/c/…`); una carpeta con variables, sustituciones o comodines, un `popd` sin `pushd`, un `cd -` sin anterior o una ruta `/tmp`-style en Windows queda **irresoluble**, y una carpeta irresoluble, inexistente o que no es un repo hace que `prePush` aplique los deny estáticos (masivo, forzado, remoto, `main` en el texto) y pida confirmación por lo demás ("no pude determinar en qué repositorio corre este push"); un repo git ajeno sin el script sigue omitiéndose. **Entorno**: `queCambia` marca como cambio previo `source`, `.`, `eval`, `exec`, `alias`/`unalias`, `Set-Alias`/`New-Alias`, `Invoke-Expression`, `Set-Variable`, `Set-Item`, `Import-Module`, definiciones de función (`git() {`, `function git`), variables de PowerShell, `SetEnvironmentVariable`, `-c alias.*` y subcomandos no literales. **Indirecciones**: un `git` en posición no inicial cuenta si la palabra siguiente es `push` o si va precedido de un envoltorio (`env`, `command`, `exec`, `nice`, `time`, `timeout`, `sudo`, `nohup`, `xargs`, `cmd /c`, `Start-Process`, `powershell`, `bash`, `sh`…), y un push envuelto pide confirmación; `invocacionesDeGit` devuelve `sospechas` que `procesar` convierte en `ask`: subcomando no literal (`git $s`), git sin subcomando dentro de un envoltorio (`xargs git`), `git push` dentro de una cadena, un script o una asignación (`sh -c '…'`, `cmd="git push …"`, `Invoke-Expression`, `node -e`), comando que es una variable; los alias de git se resuelven (`git --list-cmds=builtins` + `git config --get alias.<sub>`): un alias que es `push` se analiza como push (y pide confirmación), uno que contiene `push` pide confirmación, variables de entorno delante de un subcomando no nativo piden confirmación |
| R-02 (Medium) hooks duplicados | Cerrado | `seedMerge` identifica las entradas de `hooks` por matcher + comandos (`identidadDeHook`): la del harness reemplaza a la anterior y las copias duplicadas se funden; el test de dogfood exige hooks y permisos exactamente iguales a la plantilla; la copia dogfood volvió a dos entradas por evento |
| R-03 (Medium) `origin` desviado | Cerrado | La URL del ensayo se compara siempre con la de fetch de `origin` (`mismoRepo`: misma URL o mismo host/owner/repo, para admitir https de fetch y ssh de push); si difiere → deny con el motivo (`pushurl`/`pushInsteadOf`) |
| R-04 (Medium) autoexención por `dev` | Cerrado | Si el escaneo reporta líneas nuevas en `.datos-autorizados` y el destino (real o textual) incluye `dev` → deny; a la rama de trabajo se permite, porque la autorización entra a `dev` por PR |
| R-05 (Low) `GIT~1` | Cerrado | `dentroDelRepo` decide sobre la ruta real completa: `.git` en cualquier segmento de la ruta relativa real (nombres cortos 8.3 incluidos) y symlinks en la última componente quedan bloqueados; test con `GIT~1/HEAD` (se omite donde el volumen no tiene nombres 8.3) |
| R-06 (Info) motivo del ensayo | Cerrado | `motivoDelEnsayo` descarta `Pushing to`/`Done`/`To`/`Everything up-to-date` y prefiere `fatal:`/`error:` |
| R-07 (Info) comentario de `MAX_LINEA` | Cerrado | Corregido (~320 ms por línea mixta de 8 000; ~100 líneas largas por cabeza antes de agotar los 45 s) |
| R-08 (Low) documentación y arranque del shell | Cerrado | `settings.json` deniega `Edit` sobre `./.git/**`, `~/.gitconfig`, `~/.config/git/**` y los archivos de arranque de bash, zsh y PowerShell; README enumera lo que el hook no ve (scripts y programas que pushean sin `git push` en el comando, `npm run`, `node -e`, herramientas MCP de git, archivos de arranque editados fuera de las tools, pushes fuera de Claude Code) y la protección de `main` en GitHub como muro |
| R-09 (Info) falsos positivos | Cerrado | `set -e`/`set -o pipefail` ya no cuentan como cambio de entorno (`set X=1` sí); `git tag` previo se mantiene como cambio de contenido (deliberado) |

### Pruebas agregadas en el ciclo 3

- `test/hook-reglas-pr.test.js`: carpetas (`cd -`, `pushd`/`popd`, `cd` solo, `~`,
  `Set-Location -`, redirecciones, irresolubles con `$PWD`/`$OLDPWD`/`$(…)`/`-C
  "$PWD"`/`cd -` inicial/`popd` suelto/`~otro`, recuperación con ruta absoluta,
  rutas POSIX y `/cygdrive` en Windows); envoltorios (`env`, `timeout 60`, `cmd
  /c`, `sudo -u`), `grep -rn git` y `echo hola git status` no son invocaciones;
  sospechas (`git $s`, `$a="push"; git $a`, `sh -c`, asignación con `git push`,
  `Invoke-Expression`, `node -e`, `xargs git`, `$GIT push`, `-c alias.p=push`) y
  ausencia de sospechas en `git commit -m "feat: push notifications"` y `git log
  --grep=push`; `queCambia` con 17 formas de cambio y 8 que no cambian; `prePush`
  sin repo resuelto (deny estático / ask sin escaneo ni ensayo), envoltorio y alias
  → ask, `pushurl` → deny y mismo repo por ssh → pasa, autorización nueva a `dev`
  → deny y a la rama → pasa; `procesar` con alias `p=push` (deny a `main`, ask a la
  rama), `lg`, `sube='!git push…'`, y seis formas no analizables → ask; **hook
  real**: siete formas de llegar a `main` escondiendo la carpeta o envolviendo a
  git → deny, trece formas de entorno cargado, envoltorio, variable o carpeta
  irresoluble → ask, ruta POSIX literal → pasa, alias `p` (deny/ask) y `st`
  (pasa), parado en `main` con `cd .. && cd -` y `env git push` → deny; `pushurl`
  a otro bare → deny y al quitarlo → pasa; `.datos-autorizados` nuevo a la rama →
  pasa y `HEAD:dev` → deny.
- `test/unit.test.js`: `seedMerge` reemplaza por identidad y funde duplicados;
  `identidadDeHook`; las listas de permisos siguen siendo unión por valor.
- `test/dogfood.test.js`: hooks y permisos del `.claude/settings.json` del repo
  idénticos a la plantilla.
- `test/migrate.test.js`: `GIT~1/HEAD` bloqueado (Windows con nombres 8.3).

### Riesgos residuales tras el ciclo 3

- Lo que el hook no ve por diseño y queda documentado en README: programas y
  scripts que pushean sin que `git push` aparezca en el comando (`npm run deploy`,
  `node -e` sin la cadena literal, herramientas MCP de git), funciones o alias de
  shell definidos en archivos de arranque editados fuera de las tools de edición,
  alias de git definidos en comandos previos cuyo valor es un script sin la
  palabra `push`, y pushes hechos fuera de Claude Code. Mitigación: protección de
  `main` en GitHub donde el plan la ofrece, y revisión humana del PR.
- Pendientes de validación en una sesión real de Claude Code (dudas del revisor):
  que un `ask` del hook prompte aunque exista `allow Bash(git push:*)`, el estado
  de la tool PowerShell con las reglas espejo, y los modos sin prompt
  (`bypassPermissions`), donde ningún hook ni regla decide.
- Fricción asumida y documentada: envoltorios, alias, variables, `cd` no literal y
  comandos compuestos con `commit`/`checkout`/`source` antes del push piden
  confirmación; `echo git push` (sin comillas) también.
- Los residuales de los ciclos anteriores que siguen vigentes: H-05 (0
  aprobaciones), H-09 (`#v1` móvil), H-12 (palabras de ejemplo), N-09
  (cuadraticidad bajo el tope, degrada a `ask`), N-12 parcial (`Edit` sobre las
  plantillas en este repo), N-13 (refs locales bajo `refs/remotes/origin/*`).

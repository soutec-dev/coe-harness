# 03 — Resumen de la remediación

Dos ciclos de remediación (la skill admite hasta tres). El primero (`41100bf` más
un ajuste a `excepciones-nuevas`) cerró los hallazgos H-01 a H-14 del informe
inicial; la revisión final del ciclo 1 encontró un High nuevo (N-01) y varios
Medium/Low, y el segundo ciclo (`d9c52d8`, `1930816`, `3501be0`) los cerró. El
detalle del segundo ciclo está en la sección "Segundo ciclo" al final. Suite tras
el ciclo 2: **158 tests, 158 pass** (ver `04-test-evidence.md`).

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

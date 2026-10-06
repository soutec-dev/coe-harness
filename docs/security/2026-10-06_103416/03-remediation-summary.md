# 03 — Resumen de la remediación

Un solo ciclo de remediación. Commit principal: `41100bf` (rama `dev`), más un
ajuste menor posterior a la regla informativa `excepciones-nuevas` (ver al final).
Suite tras la remediación: **149 tests, 149 pass** (`npm test`); `verify --strict`
en verde; el propio check de secretos del harness sobre los commits en verde.

## Archivos modificados

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

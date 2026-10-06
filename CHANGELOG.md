# Changelog

Todas las versiones notables de `coe-harness`. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y el versionado,
[SemVer](https://semver.org/lang/es/).

## [1.0.0] — 2026-10-05

Primera versión. Harness de Claude Code para proyectos externos, derivado del motor
del harness interno de la organización pero sin ninguna dependencia de sus
herramientas (tablero, trackers, monitor, modos). Ver
`docs/decisions/20261005-coe-harness-para-proyectos-externos.md`.

### Agregado

- **CLI** `init` / `upgrade` / `status` / `adopt` / `verify`, con el mismo motor de
  plan + lockfile (un archivo del usuario nunca se pisa en silencio) y la protección
  de `main` en GitHub vía `gh api` (PR obligatorio, check `reglas-pr`, sin force-push).
- **Flujo Git simple** (skill `coe-github`): dos ramas `dev`/`main`, ramas
  `tipo/slug`, commits convencionales, PR con plantilla, squash & merge del
  coordinador, release `dev` → `main` con tags `vX.Y.Z` + `vX`.
- **Secretos y datos sensibles** (skill `datos-sensibles`, `.datos-autorizados`,
  sección "Datos sensibles" de la plantilla de PR): ninguna credencial ni dato de
  la organización entra al repo; los datos solo con autorización previa registrada
  por el usuario.
- **Hook `reglas-pr`** de Claude Code: antes de cada `git push` deniega el destino
  `main`/`master`, `--force`/`-f`/`+refspec`, `--all`/`--mirror`, y el grupo
  `secretos` sobre los commits que subirían; al crear o editar el PR corre los tres
  grupos y publica el resultado como comentario.
- **`check-pr-rules.mjs`** con escaneo de credenciales por nombre de archivo y por
  contenido (llaves privadas, tokens de AWS/GitHub/Slack/Google/Stripe/OpenAI,
  JWTs, URLs con credenciales, connection strings, `_authToken`, asignaciones de
  contraseña con filtro de placeholders) y heurísticas de datos personales y de
  nómina (documentos de identidad, IBAN/CBU, tarjetas con Luhn, listados de
  correos, nombres de archivo de nómina/clientes/volcados), con `.datos-autorizados`
  y `coe:no-secreto` como vías de excepción del usuario. Reglas nuevas de
  `pr-metadata`: `security-review-declarado` (y el estado de `security-audit` en
  los PRs a `main`) y `datos-sensibles-declarados`.
- **Auditoría de seguridad gateada** (skills `security-audit` y
  `security-report-standard`): `/security-review` nativo, remediación de
  Critical/High, re-review e informe Markdown en `docs/security/`, obligatoria
  antes de cada release.
- **Workflows**: `reglas-pr.yml` (los tres grupos en un solo job, check requerido)
  y `tag-release.yml` (solo repos Node).
- **`settings.json`** con deny de lectura de credenciales (repo y home), deny de
  push a `main` y de `gh pr merge/review`, `gh release` y `gh repo create/delete`.
- **Cuentas gratuitas de GitHub**: `init`/`upgrade` distinguen la limitación de
  plan (repo privado en Free, donde GitHub no ofrece branch protection) de un
  permiso faltante y lo explican en una línea sin frenar nada; el README documenta
  qué funciona en cada plan.
- **Tests**: motor, CLI, checks, hook (contra repos git reales), tags,
  transferibilidad (ningún archivo emitido menciona herramientas internas) y
  dogfood (las copias locales son idénticas a las distribuidas).

### Seguridad (remediaciones de la auditoría previa al release, `docs/security/2026-10-06_103416/`)

- **H-01 (High)** El hook resuelve el destino del push como git: normaliza
  `heads/x`, deniega los borrados de `main`, ensaya el push con
  `git push --dry-run --porcelain` y deniega si el destino real es `main`
  (upstream, `push.default`, `remote.*.push`). Metacaracteres del shell, `git -c`,
  `--no-verify` y opciones raras piden confirmación en vez de pasar en silencio.
  Los hooks de `settings.json` ya no llevan filtro `if` (así `git -C`, `git -c` y
  comandos compuestos llegan al hook) y `git -c` está en `ask`.
- **H-02** Solo se pushea a `origin`: otro remoto o una URL se deniegan, y sin
  remoto explícito la URL que ensaya git tiene que ser la de `origin`.
- **H-03** `plan.js` ignora (y reporta) los `dest` del lockfile fuera del repo
  (`..`, absolutos, `\`, `.git/`); `apply.js` bloquea borrados, respaldos y
  escrituras fuera de `cwd`; `verify` falla ante un `dest` inseguro.
- **H-04** `init`/`upgrade` leen la protección vigente de `main` y solo la
  endurecen: aprobaciones, code owners, dismiss stale, conversation resolution,
  restricciones y checks extra se conservan.
- **H-05** `dev` queda protegida contra force-push y borrado (sin PR obligatorio);
  la limitación del check autoeditable con 0 aprobaciones queda documentada.
- **H-06** `settings.json` deniega la edición de los guardarraíles con las tools
  de edición; `.datos-autorizados` se lee de `origin/dev`; la regla informativa
  `excepciones-nuevas` lista marcadores y autorizaciones que llegan en el diff.
- **H-07** Pre-chequeos baratos antes de las regex cuadráticas (`@`, `://`,
  `Bearer`, `eyJ`…), tope de 20 000 caracteres por línea (se cuenta y se avisa) y
  `ask` ante timeout o error del script.
- **H-08** El escaneo de commits sin pushear usa `--remerge-diff` (fallback
  `-m --first-parent`): un secreto agregado a mano en un merge commit se detecta.
- **H-09** Acciones de los workflows fijadas por SHA, dependencias con versión
  exacta y nota en `harness-upgrade` para fijar `#vX.Y.Z`.
- **H-10** El PostToolUse solo verifica y comenta PRs del repo de `origin`.
- **H-11** Ninguna ruta de error del pre-push permite el push: todas piden
  confirmación con el motivo.
- **H-12** `pareceSecreto` acepta `$` en medio de un valor (solo descarta
  expresiones `${}`, `$()`, `{{}}` y valores que empiezan con `$`/`%`/`{`).
- **H-13** La skill `datos-sensibles` describe con honestidad la capa de lectura;
  las mutaciones por `gh api` piden confirmación.
- **H-14** `OWNER` ya no toma el `user.name` de git por defecto.

Segundo ciclo (hallazgos de la revisión final, N-01 a N-12):

- **N-01 (High)** Cuatro caminos silenciosos a `main` cerrados: el refspec `:`
  (matching) se deniega como masivo; un `git checkout`/`switch`/`config`/
  `remote`/`branch`, un `export`, una asignación `VAR=…` o `$env:` antes del push
  en el mismo comando, y las variables de entorno delante del push, piden
  confirmación (el hook solo puede ensayar el estado actual); `-q`/`--quiet` se
  quitan del ensayo (y se agrega `--verbose`), y un ensayo sin destino informado
  pide confirmación; el ensayo corre también sin cabezas (`--delete`). Además un
  `git commit`/`merge`/`rebase`/`reset`… antes del push pide confirmación (el
  escaneo de secretos solo ve los commits que ya existen) y el hook revisa
  **todos** los `git push` del comando, no solo el primero.
- **N-02** Lista cerrada de opciones de `git push` escritas completas: una opción
  desconocida o abreviada (`--recei=`, `--forc`) pide confirmación; cualquier
  grupo corto con `f` fuerza (deny) y con `o` lleva push-option (ask);
  `--force-with-lease`/`--force-if-includes` piden confirmación; `--git-dir`,
  `--work-tree` y `--namespace` también.
- **N-03** `.datos-autorizados` y la base se leen por el nombre completo
  `refs/remotes/origin/dev`: un tag o rama local llamado `origin/dev` ya no la
  sombrea.
- **N-04** Presupuesto global de 100 s en el PreToolUse (timeout del hook 120 s):
  cada llamada queda acotada y, agotado, pide confirmación; tope de línea bajado
  a 8 000 caracteres.
- **N-05** Cada regla `Bash(...)` de `settings.json` tiene su espejo
  `PowerShell(...)`, con test.
- **N-06** `asignacion-de-secreto` detecta claves con prefijo (`DB_PASSWORD=`,
  `db_password:`) y en camelCase (`smtpPassword =`).
- **N-07** Un GET fallido de la protección de `main` (que no sea 404) ya no se
  trata como "sin protección": no se escribe encima; se conservan además
  `app_id` de los checks, `bypass_pull_request_allowances`, `lock_branch`,
  `block_creations` y `allow_fork_syncing`.
- **N-08** `destSeguro` rechaza `.git` en cualquier segmento sin distinguir
  mayúsculas; `apply` compara la ruta real (symlinks) y protege también la
  creación de directorios; `verify` valida `manifest.dirs`.
- **N-11** `ask` para más formas de mutación con `gh api` (`--field`,
  `--raw-field`, `--input`).
- **N-12** Documentado el alcance de las cuentas admin (README).

Tercer ciclo (hallazgos de la revisión final del ciclo 2, R-01 a R-09):

- **R-01 (High)** El hook ya no se calla ante lo que no modela. Carpetas: `cd -`,
  `pushd`/`popd`, `cd` a secas, rutas POSIX de Git Bash en Windows (`/c/…`), y
  cuando la carpeta no se puede resolver (`cd "$PWD"`, `git -C "$PWD"`, rutas que
  no existen) lo estático se deniega y el resto pide confirmación. Entorno:
  `source`, `.`, `eval`, `exec`, definiciones de funciones y alias (`git() {…}`,
  `function git`, `Set-Alias`), variables de PowerShell y `-c alias.*` cuentan
  como cambio de estado previo (`ask`). Indirecciones: un `git` envuelto en otro
  programa (`env`, `command`, `timeout`, `sudo`, `cmd /c`…) se analiza como push
  y pide confirmación; un subcomando no literal (`git $s`), `git push` dentro de
  una cadena o un script (`sh -c '…'`, `eval`, `Invoke-Expression`, una
  asignación) o un comando que es una variable piden confirmación; un alias de
  git que es `push` se analiza como push (y pide confirmación), uno que puede
  pushear también.
- **R-02** `seedMerge` identifica las entradas de hooks por matcher + comando: la
  del harness se reemplaza en el upgrade en vez de duplicarse (la copia dogfood
  tenía cuatro entradas por evento); test de dogfood que exige los hooks y
  permisos exactos de la plantilla.
- **R-03** La URL a la que git mandaría el push se compara siempre con la de
  fetch de `origin` (mismo repo aunque cambie el protocolo): un `pushurl` o un
  `pushInsteadOf` hacia otro repo se deniega.
- **R-04** Un push directo a `dev` con líneas nuevas en `.datos-autorizados` se
  deniega: una autorización entra por PR.
- **R-05** `apply` decide sobre la ruta real completa: `.git` por su nombre corto
  8.3 (`GIT~1`) o por symlink queda bloqueado; la última componente no puede ser
  un symlink.
- **R-06** El motivo de un ensayo fallido ya no es "Pushing to …" sino el error
  real de git.
- **R-08** `settings.json` deniega editar `.git/`, `~/.gitconfig`, `~/.config/git`
  y los archivos de arranque del shell; el README enumera lo que el hook no ve.
- **R-09** `set -e`/`set -euo pipefail` ya no cuentan como cambio de entorno.

[1.0.0]: https://github.com/soutec-dev/coe-harness/releases/tag/v1.0.0

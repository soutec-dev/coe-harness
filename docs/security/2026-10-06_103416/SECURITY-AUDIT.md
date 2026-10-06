# Auditoría de seguridad — coe-harness

> **Resumen general**: tras una revisión inicial y tres ciclos de remediación, cada uno con su propia revisión final independiente, el gate de la skill `security-audit` se cumple: **no queda ningún hallazgo Critical ni High abierto**. Estado **READY WITH CONDITIONS**. Las dos condiciones técnicas del revisor (S-01, S-02, ambas Medium y de circunvención deliberada) se cerraron en `2666c42` antes del PR; quedan como condiciones las validaciones en una sesión real de Claude Code y los riesgos aceptados que la sección 11 enumera, todos documentados en el README del harness.

## 1. Estado de la auditoría

| Campo | Valor |
|---|---|
| Proyecto | coe-harness — https://github.com/soutec-dev/coe-harness |
| Estado | **READY WITH CONDITIONS** |
| Fecha de la auditoría | 2026-10-06 |
| Rama | `dev` (release `dev` → `main`, v1.0.0) |
| Commit inicial | `0939109` |
| Commit final | `2666c42` (código; la evidencia `03`–`05` y este informe entran en el commit de documentación siguiente, que no toca código) |
| Alcance | `full`: todo el repositorio — motor y CLI (`src/`, `bin/`), todo lo que se distribuye (`templates/`: hook, script de checks, settings, workflows, skills), las copias dogfood (`.claude/`, `scripts/`, `.github/`) y la configuración del repo en GitHub |
| Aprobación (responsable de seguridad / coordinador) | PENDING |

## 2. Resumen ejecutivo

coe-harness es un generador de línea de comandos (`npx github:soutec-dev/coe-harness#v1 init|upgrade|status|adopt|verify`) que instala en repositorios de proyectos externos una superficie de Claude Code con tres compromisos: `main` solo recibe merges desde `dev` por Pull Request, ninguna credencial ni dato sensible de la organización sale del repo desde la sesión del agente, y cada PR y cada release pasan por una revisión de seguridad. La auditoría previa al primer release revisó el generador, lo que instala y la configuración del repositorio en GitHub, con una pasada inicial de `/security-review` y tres revisiones finales (una por ciclo de remediación), todas con laboratorios contra repos git reales.

La revisión inicial encontró 16 hallazgos (1 High, 8 Medium, 4 Low, 3 Info), concentrados en el control central: el hook que deniega el push a `main` y el escaneo de secretos se podían evadir con variantes del comando, el `PUT` de branch protection podía rebajar una configuración existente, un lockfile manipulado permitía borrar fuera del repo y la cadena de suministro dependía de tags móviles. Cada ciclo de remediación cerró lo que su revisión encontró, y cada revisión final encontró un High nuevo de la misma clase que el anterior, cada vez más estrecho: en el ciclo 1, cuatro caminos a `main` que el ensayo de git no cubría (refspec `:`, cambio de rama en el mismo comando, configuración por variables de entorno, `-q`); en el ciclo 2, pushes que el hook directamente no modelaba (carpeta mal resuelta con `cd -` o rutas POSIX, entorno cargado por `source` o funciones, `git` envuelto en otro programa o con subcomando variable, alias). El tercer ciclo cambió el principio del hook —reconoce la forma canónica del push y **todo lo que no puede analizar con certeza pide confirmación al usuario**— y la revisión final del ciclo 3 verificó, con la regresión completa de los laboratorios anteriores, que todo lo que antes pasaba en silencio pasa a `deny` o `ask` sin falsos positivos en el flujo normal, y dejó dos residuales Medium de circunvención deliberada (`Start-Process git -ArgumentList …` en PowerShell y un alias de git usado antes del push), cerrados en `2666c42` antes del PR.

Al cierre no queda ningún hallazgo Critical ni High abierto. Quedan riesgos Medium/Low/Info aceptados con condiciones explícitas (sección 11): con 0 aprobaciones obligatorias el autor de un PR controla el check requerido; el tag `#v1` es móvil por diseño; el escaneo de líneas largas degrada a una confirmación humana, nunca a silencio; el conjunto de commits "sin pushear" se calcula con las refs locales de `origin`; y lo que el hook no ve por diseño (programas que pushean sin `git push` en el comando, archivos de arranque del shell editados fuera de las tools, pushes fuera de Claude Code) lo cubre la protección de `main` en GitHub donde el plan la ofrece.

> **Importante.** Este informe no reemplaza un pentest formal, una auditoría externa
> ni la validación de infraestructura de producción. Es un insumo para que el
> responsable de seguridad y el coordinador tomen su propia decisión informada
> sobre el paso a producción.

## 3. Sobre el proyecto

- **Qué es**: un CLI Node.js (≥ 22.4, sin dependencias de testing; `@clack/prompts` y `picocolors` como únicas dependencias de ejecución, fijadas con `npm-shrinkwrap.json`) con un manifest (`templates/harness.manifest.json`) que describe lo que se instala, un motor plan/apply con lockfile (`.claude/harness.json`) y políticas por archivo (managed, user-owned, append-block, merge-json).
- **Qué instala en el repo consumidor**: `CLAUDE.md`, `README.md`, `notes.md`, `.env.example`, `.gitignore` (bloque por stack), `.datos-autorizados`, `.claude/settings.json` (reglas `deny`/`allow`/`ask` y hooks), `.claude/hooks/reglas-pr.mjs`, `scripts/check-pr-rules.mjs`, `scripts/tag-release.mjs`, `.github/pull_request_template.md`, `.github/CODEOWNERS`, workflows `reglas-pr.yml` y `tag-release.yml`, y las skills `coe-github`, `datos-sensibles`, `security-audit`, `security-report-standard`, `adr-new` y `harness-upgrade`. Además configura la branch protection de `main` y `dev` vía `gh api` donde el plan de GitHub lo permite.
- **Dónde corre**: en la máquina del desarrollador (sesión de Claude Code) y en GitHub Actions (check `reglas-pr` sobre cada PR; `tag-release` al mergear el release). No hay servicios desplegados ni datos de usuarios finales.
- **Quién lo opera**: equipos mixtos (personal propio y de otras empresas) sobre repos que pueden transferirse; por eso el harness no referencia herramientas internas.

## 4. Qué se revisó y metodología

Superficie de ataque considerada:

- **La sesión del agente**: comandos `git`/`gh`/`node` que el agente puede ejecutar, y cómo el hook `reglas-pr` (PreToolUse/PostToolUse de Claude Code) y las reglas de `settings.json` deciden qué pasa, qué se deniega y qué pide confirmación. Vectores: push directo a `main` por cualquier forma del comando (refspecs, DWIM, `push.default`, upstream, `-c`, variables de entorno, comandos compuestos, `-q`, opciones abreviadas, varios push por comando, carpetas con `cd -`/`pushd`/rutas POSIX, `source`/funciones/alias, envoltorios y lanzadores, subcomandos variables, `git push` dentro de cadenas), force-push, remotos ajenos (también `origin` desviado por `pushurl`), borrados, y el escaneo de credenciales y datos sensibles en los commits que subirían (incluidos merges y "evil merges") y las excepciones (`.datos-autorizados`, `coe:no-secreto`).
- **El script de checks** (`check-pr-rules.mjs`) en la sesión y en CI: regex de secretos (ReDoS, falsos negativos por prefijos/camelCase, placeholders), lectura de `.datos-autorizados` y de la base del diff (sombras de `origin/dev`), excepciones nuevas en el mismo diff.
- **El generador**: escrituras y borrados a partir del lockfile y del manifest (traversal, `.git` y sus nombres cortos 8.3, symlinks, `manifest.dirs`), fusión de `settings.json` (duplicación de hooks), `PUT` de branch protection (degradación, errores de lectura, campos perdidos).
- **El repositorio en GitHub**: branch protection de `main`/`dev`, ruleset de tags inmutables, workflows (`pull_request` sin `pull_request_target`, permisos mínimos, acciones fijadas por SHA), plan Free vs. Pro/Team.
- **Cadena de suministro**: instalación vía `npx` desde un tag móvil de GitHub, dependencias directas y transitivas.

- **Método de revisión**: comando nativo `/security-review` de Claude Code, delegado a un subagente revisor independiente de la sesión que remedia, en cuatro pasadas: inicial (`01`) y finales de los ciclos 1, 2 y 3 (`05`), más una re-verificación acotada de las condiciones del ciclo 3 (anexo de `05`). Cada pasada combinó lectura de código con laboratorios reproducibles: repos git temporales con un `origin` bare local, el hook invocado como lo invoca Claude Code (JSON por stdin; más de 230 invocaciones solo en la revisión del ciclo 2 y la regresión completa de esos guiones en la del ciclo 3) y el script de checks sobre commits preparados.
- **Ciclos de remediación ejecutados**: 3 de un máximo de 3 (`02-remediation-plan.md`, `03-remediation-summary.md`), más el cierre de las dos condiciones de la revisión final 3 en `2666c42`.
- **Pruebas obligatorias**: `npm test` (171 tests, 171 pass sobre `79e909d` y sobre `2666c42`), `node bin/cli.mjs verify --strict`, `npm audit --omit=dev` (0 vulnerabilidades), `node bin/cli.mjs upgrade --yes` sobre el propio repo (dogfood) — detalle en `04-test-evidence.md`.
- **Secretos y datos sensibles**: `node scripts/check-pr-rules.mjs --grupo secretos` sobre todo lo que entra al release y `--sin-pushear` sobre cada commit de remediación: `[OK]` en archivos de credenciales, contenido y datos sensibles; las únicas excepciones son fixtures sintéticos marcados `coe:no-secreto (fixture)` y los dos archivos de test listados en `.datos-autorizados` (check `scripts/check-pr-rules.mjs --grupo secretos` y revisión manual).

## 5. Alcance y limitaciones

- No existe entorno de producción ni despliegue: la "producción" de un proyecto consumidor es su rama `main`, y el control auditado es el que impide llegar a ella sin PR y sin revisión.
- El hook trabaja sobre el texto del comando y sobre el ensayo de git (`git push --dry-run --porcelain --verbose`). Reconoce la forma canónica `git push [-u] origin <rama>` (con `cd <ruta literal> &&` o `git -C <ruta>`) y pide confirmación ante todo lo demás que mencione git de una forma que no puede analizar. No ve programas y scripts que pushean sin que `git push` aparezca en el comando (`npm run deploy`, `node -e` sin la cadena literal, herramientas MCP de git), funciones o alias de shell definidos en archivos de arranque editados fuera de las tools de edición, ni pushes hechos fuera de Claude Code; para eso está la branch protection de GitHub, que en repos privados de planes Free no existe (el harness lo detecta y lo dice).
- Las reglas `Read(...)` de `settings.json` frenan la tool `Read`, no `cat` en Bash: la capa de lectura es una traba, no un muro; el control real es el gate de push más la revisión humana.
- El escaneo de secretos es heurístico: no detecta nombres sueltos, datos sin forma de patrón, binarios, `.svg`, `.map`, lockfiles, líneas de más de 8 000 caracteres (se cuentan y se avisan), secretos codificados ni valores con palabras de ejemplo.
- Con 0 aprobaciones obligatorias (valor por defecto para no trabar equipos de dos personas), el autor de un PR controla el script del check requerido.
- Tres comportamientos de la plataforma no se validaron en una sesión real de Claude Code y quedan como condiciones (sección 11): que un `ask` del hook prompte aunque exista `allow Bash(git push:*)`; el estado de la tool PowerShell con las reglas espejo; y los modos sin prompt (`bypassPermissions`), donde no se verificó qué reglas y hooks siguen decidiendo.
- Los pushes de los laboratorios que debían fallar en el servidor se validaron contra un bare local (sin protección) y con `--dry-run`; no se hicieron pushes reales contra GitHub.
- La auditoría la ejecutó un agente de Claude Code desde otra sesión (la del harness interno), siguiendo a mano la skill `security-audit` de este repo; no se instalaron herramientas nuevas (lint, SAST, escáneres externos).
- Las credenciales presentes en `test/` son fixtures falsos; en esta evidencia no se copia ningún valor.

## 6. Resultado de la revisión final

La revisión final del ciclo 3 (informe íntegro en `05-final-security-review.md`, tercera sección) corrió sobre `79e909d`, con el hook real invocado por stdin desde Bash y PowerShell y con la regresión completa de los laboratorios de los ciclos 1 y 2:

- **Veredicto del gate: SÍ** (sin Critical ni High abiertos). Estado recomendado: `READY WITH CONDITIONS`.
- **R-02 a R-09 cerrados con evidencia**: la unión por identidad de los hooks de `settings.json` deja una sola entrada por tool y evento y además sana a los consumidores que ya tenían duplicados; un `pushurl` o `pushInsteadOf` que desvía `origin` se deniega siempre; una autorización nueva en `.datos-autorizados` hacia `dev` se deniega en todas sus formas y a la rama de trabajo pasa; `GIT~1` y los symlinks quedan bloqueados en `apply`; el motivo de un ensayo fallido es el error real de git; `set -e` ya no es falso positivo; las reglas `deny` de `Edit` sobre `.git/`, `~/.gitconfig` y los archivos de arranque del shell están en la plantilla y en el dogfood.
- **R-01 parcial → dos residuales Medium**: S-01, un lanzador de PowerShell con el subcomando empacado en `-ArgumentList` (`Start-Process git -ArgumentList "push","origin","HEAD:main"`) no se marcaba; S-02, un alias de git para un subcomando que cambia de rama usado antes del push (`git co main && git push origin`, con `co = checkout`) no contaba como cambio de estado. Ambos reproducidos como pushes reales a `main` en un bare local; ambos de circunvención deliberada (ninguna forma del flujo normal los produce) y con la protección de `main` en GitHub como muro, por eso Medium y no High. Todo lo demás que en el ciclo 2 pasaba en silencio pasa ahora a `deny` o `ask`: carpetas (`cd -`, `pushd`/`popd`, `cd -P/-L/--`, rutas POSIX `/c/…`, `cd "$PWD"`, `git -C "$PWD"`, `Set-Location -Path`), entorno (`source`, `.`, `eval`, `exec`, funciones, dot-sourcing), envoltorios (`env`, `command`, `exec`, `nice`, `time`, `timeout`, `sudo -u`, `nohup`, `winpty`, `strace`, `cmd /c`, `xargs`), cadenas (`sh -c`, `bash -c`, `node -e`, `python -c`, `printf | sh`, `Invoke-Expression`, `iex`, scriptblocks, `$cmd`, `powershell -Command`), subcomandos no literales (`git $s`, `git ${x:-push}`, `git "$p"`) y alias que pushean (`p`, `pp`, `!git push`, `-c alias.*`, `GIT_CONFIG_PARAMETERS`).
- **Sin falsos positivos en el flujo normal**: `git push -u origin <rama>`, rama al día, `cd "<ruta literal>" && git push`, `git -C <ruta> push`, `git st && git push` (con `st = status`), `git log --grep=push`, `git commit -m "feat: push notifications"`, tuberías y redirecciones, `&& gh pr create --fill`, `which git`, `npm run push` → silencio o `ask` correcto. Tiempo del hook en un push normal: ~4 s.
- **Condiciones del revisor**: cerrar S-01 y S-02 (preferido a documentarlos, porque el README promete que un git envuelto y los alias piden confirmación). Se cerraron en `2666c42` con tests que reproducen sus casos (sección 8 y `03-remediation-summary.md`). Re-verificación del revisor sobre `2666c42` (anexo de `05`): **S-01 y S-02 cerrados** — los lanzadores de PowerShell con el subcomando empacado (`Start-Process`/`saps` con `-ArgumentList`, `-FilePath`, `@(...)`) piden confirmación o se deniegan, los alias previos al push se resuelven también cuando viven solo en `~/.gitconfig` (`co`, `sw`, `ci`, `!git checkout`, `config remote.origin.push`, `branch -u`) y los alias inofensivos (`lg`, `st`) siguen pasando; sin regresiones en los casos legítimos; 51/51 en el test del hook. R-01 pasa de parcial a **cerrado en lo que el modelo del hook puede ver**; el único silencio residual (`alias g=git; g push …`) es inerte en el Bash no interactivo de la sesión. Conteo abierto tras la re-verificación: Critical 0, High 0, Medium 0.
- **Dudas del revisor** (validaciones que solo una sesión real de Claude Code puede dar): precedencia de un `ask` del hook sobre un `allow` de settings; estado de la tool PowerShell con reglas espejo; modos sin prompt; push real contra GitHub con `main` protegido. Quedan como condiciones en la sección 11.

## 7. Hallazgos por severidad

| Severidad | Iniciales (`01`) | Nuevos rev. final 1 | Nuevos rev. final 2 | Nuevos rev. final 3 | Remediados | Abiertos al cierre |
|---|---:|---:|---:|---:|---:|---:|
| Critical | 0 | 0 | 0 | 0 | 0 | 0 |
| High | 1 (H-01) | 1 (N-01) | 1 (R-01) | 0 | 3 | 0 |
| Medium | 8 (H-02–H-09) | 5 (N-02–N-06) | 3 (R-02–R-04) | 2 (S-01, S-02) | 16 | 2 (H-05, H-09: riesgo aceptado con condiciones) |
| Low | 4 (H-10–H-13) | 5 (N-07–N-11) | 2 (R-05, R-08) | 0 | 9 | 2 (H-12, N-09: mitigados y documentados) |
| Informativo | 3 (H-14–H-16) | 2 (N-12, N-13) | 3 (R-06, R-07, R-09) | 0 | 5 (H-14, R-06, R-07, R-09; H-15 se cierra con los tags de este release) | 3 (H-16 documentado, N-12 parcial, N-13 aceptado) |

Los prefijos de los IDs indican la pasada que los encontró: H-xx revisión inicial, N-xx revisión final 1, R-xx revisión final 2, S-xx revisión final 3. "Remediados" incluye lo cerrado en los tres ciclos y en `2666c42`.

> Ningún hallazgo `Critical` o `High` queda abierto al cierre de esta auditoría.

## 8. Trazabilidad Critical/High

Registro técnico de cada hallazgo grave detectado y su remediación. No se elimina un
hallazgo de esta tabla por haber sido corregido — el historial de corrección es parte
de la evidencia.

| ID | Severidad | Activo afectado | Requisito del plan | Cambio aplicado | Prueba | Estado |
|---|---|---|---|---|---|---|
| H-01 | High | Hook `reglas-pr.mjs` y `settings.json` del harness: el deny de push a `main` se evadía con `heads/main`, metacaracteres del shell, `git -c`, push sin refspec con upstream en `main` | `02-remediation-plan.md` H-01: ningún push cuyo destino efectivo sea `main` pasa en silencio | `ramaDeDestino` normaliza `heads/x`; deny de borrados de `main`; ensayo con `git push --dry-run --porcelain --no-verify` y deny si git resuelve `main`; `ask` ante metacaracteres, `-c`, opciones raras; hooks sin filtro `if` (`41100bf`) | `test/hook-reglas-pr.test.js`; laboratorio B del ciclo 1 | REMEDIATED (reabierto como N-01 por la revisión final 1) |
| N-01 | High | Hook `reglas-pr.mjs`: cuatro caminos silenciosos que el ensayo no cubría — refspec `:` sin cabezas, cambio de rama/configuración en el mismo comando, configuración por variables de entorno y `-q` | Revisión final 1, N-01: ensayar siempre, tratar `:` como masivo, pedir confirmación cuando el push depende del estado o del entorno, neutralizar `-q` | `:`/`+:` → deny masivo; `queCambia()` marca los segmentos previos que cambian rama/config/entorno o commits → `ask`; asignaciones de entorno delante del push → `ask`; `argsDelEnsayo()` quita `-q`/`--quiet`, el ensayo lleva `--verbose` y un ensayo sin destino → `ask`; el ensayo corre también sin cabezas; todos los `git push` del comando se evalúan (`d9c52d8`, copia dogfood en `3501be0`) | `test/hook-reglas-pr.test.js`; laboratorios B+, G, H, I, J de la revisión final 2 | REMEDIATED (reabierto como R-01 por la revisión final 2) |
| R-01 | High | Hook `reglas-pr.mjs`: pushes que el hook no modelaba y dejaba pasar en silencio — carpeta mal resuelta (`cd -`, `popd`, rutas POSIX de Git Bash en Windows, `cd "$PWD"`), entorno cargado en el mismo comando (`source`, `eval`, funciones `git()`), indirecciones (`env git push`, `sh -c '…'`, `git $s`, alias de git) | Revisión final 2, R-01: pedir confirmación cuando no se pueda resolver la carpeta; modelar `cd -`/`popd`/rutas POSIX; tratar `source`/`eval`/funciones como cambio de destino; pedir confirmación ante cualquier `git` fuera de la posición canónica o con subcomando no literal | Seguimiento de carpetas (`cd -`, pila de `pushd`/`popd`, `cd` solo, POSIX → Windows) y carpeta irresoluble → deny estático + `ask`; `queCambia` ampliado a `source`, `.`, `eval`, `exec`, alias, funciones, variables de PowerShell, `-c alias.*`; `git` envuelto (`ENVOLTORIOS`) analizado como push + `ask`; sospechas → `ask` (subcomando no literal, `git push` en cadenas/scripts/asignaciones, comando variable, `xargs git`); alias de git resueltos con `git --list-cmds=builtins` + `git config --get alias.*` (`79e909d`); residuales S-01 (lanzador con `-ArgumentList`) y S-02 (alias previo al push) cerrados en `2666c42` | `test/hook-reglas-pr.test.js` (carpetas, envoltorios, sospechas, `queCambia`, `prePush` sin repo, alias; hook real: 7 formas a `main` → deny, 13 formas → ask, alias `p`/`st`/`co`, lanzadores de PowerShell, parado en `main`); regresión completa de los laboratorios del ciclo 2 en la revisión final 3 y re-verificación de S-01/S-02 | REMEDIATED |

> Los tres High son de la misma clase (evasión del control de destino del push) y se cerraron con el mismo principio, cada vez aplicado con más alcance: la palabra final la tiene el ensayo de git, y todo lo que el hook no puede verificar con certeza pide confirmación al usuario en vez de dejarse pasar. La fricción resultante (un `git commit … && git push`, un `env git push`, un `git co main && git push` o un `cd "$PWD" && git push` piden confirmación) es deliberada y está documentada en la skill `coe-github`, en el `CLAUDE.md` distribuido y en el README.

## 9. Evidencia de pruebas

| Comando | Propósito | Resultado | Evidencia |
|---|---|---|---|
| `npm test` | Suite completa: motor plan/lockfile, CLI, checks de PR, hook contra repos git reales, tags, transferibilidad, dogfood | PASSED | 171 tests, 171 pass, 0 fail sobre `79e909d` y sobre `2666c42` (`04-test-evidence.md`) |
| `node bin/cli.mjs verify --strict` | Integridad del manifest frente a `templates/` y rutas seguras | PASSED | "Manifest consistente: sin huerfanos, sin rutas rotas, sin duplicados, sin criticos faltantes" |
| `node scripts/check-pr-rules.mjs --grupo secretos` / `--sin-pushear` | El propio gate del harness sobre todo lo que entra al release y sobre cada commit de remediación | PASSED | `[OK]` sin-secretos, sin-secretos-en-contenido, sin-datos-sensibles; `excepciones-nuevas` listó solo fixtures de test |
| `npm audit --omit=dev` | Dependencias de ejecución (`@clack/prompts@0.11.0`, `picocolors@1.1.1` y transitivas fijadas en `npm-shrinkwrap.json`) | PASSED | found 0 vulnerabilities |
| `node bin/cli.mjs upgrade --yes` (dogfood) | El CLI sobre un repo real: regenera las copias y reaplica la branch protection sin rebajar lo existente; tras el ciclo 3 la copia de `settings.json` volvió a tener una sola entrada de hook por tool y evento | PASSED | Protección de `main`: PR obligatorio + check `reglas-pr`, sin force-push ni borrado, también para admins; `dev` sin force-push ni borrado |
| Laboratorios del revisor (hook por stdin, repos temporales) | Reproducción de cada vector de H-01 a S-02 y de los casos legítimos, en las tres revisiones finales y la re-verificación | PASSED | `05-final-security-review.md`: en la revisión 3, todo lo que antes pasaba en silencio pasa a `deny`/`ask` y los casos legítimos siguen sin falsos positivos; S-01/S-02 re-verificados sobre `2666c42` (anexo) |

## 10. Hallazgos Medium/Low/Info

Abiertos al cierre, todos con su condición o su mitigación documentada:

| ID | Severidad | Estado | Qué queda y por qué se acepta |
|---|---|---|---|
| H-05 | Medium | Riesgo aceptado con condiciones | Con 0 aprobaciones obligatorias el autor de un PR controla el script del check requerido (`reglas-pr` corre el script del propio PR). Es la contrapartida de no trabar equipos de dos personas. Condición: equipos con dos o más revisores suben a 1 aprobación y activan "require review from code owners"; `init`/`upgrade` nunca rebajan lo endurecido a mano (verificado). Documentado en README y `github-protect.js` |
| H-09 | Medium | Riesgo aceptado con condiciones | `#v1` es un tag móvil por diseño (parches sin intervención). Condiciones cumplidas: acciones de los workflows fijadas por SHA, dependencias exactas y `npm-shrinkwrap.json`, ruleset "tags inmutables vX.Y.Z" activo en el repo (id 24591508, sin actores de bypass), opción de fijar `#vX.Y.Z` documentada en la skill `harness-upgrade`. Condición pendiente del coordinador: 2FA obligatorio en la organización y pocas cuentas admin (sección 11) |
| H-12 | Low | Mitigado y documentado | `pareceSecreto` exime valores con palabras de ejemplo (`changeme`, `your-…`, `example`): un falso negativo posible a cambio de menos pushes denegados por error. Documentado en la skill `datos-sensibles` y en README ("lo que el escaneo no detecta") |
| N-09 | Low | Mitigado y documentado | Las regex de correos y URLs siguen siendo cuadráticas por debajo del tope de 8 000 caracteres (~320 ms por línea larga con `@`/`://`); un diff con más de ~100 líneas así por cabeza agota el escaneo y el hook **pide confirmación** (nunca deja pasar). Documentado en README |
| H-16 | Info | Documentado | El check `security-review-declarado` evidencia una declaración, no la ejecución del review, y el push directo a `dev` está permitido por diseño (el bump de versión se commitea ahí). R-04 cerró la consecuencia más grave (autoexención en `.datos-autorizados` por push directo a `dev`) |
| N-12 | Info | Parcial, aceptado | En el repo del propio harness, el agente puede editar con sus tools la **fuente** de los guardarraíles (`templates/base/**`), porque es el trabajo de quien mantiene el harness; el control es la revisión del PR. En los repos consumidores las copias instaladas sí están denegadas |
| N-13 | Info | Aceptado | El conjunto de commits "sin pushear" (`--not --remotes=origin`) se calcula con las refs locales de `origin`, que un `update-ref`/`fetch .` podría mover; requiere comandos ajenos al flujo y CI vuelve a escanear el PR. Mejora futura anotada: comparar contra `git ls-remote origin` cuando haya red |
| — | — | Límite declarado | Lo que el hook no ve por diseño (README, "Seguridad: qué garantiza y qué no"): programas y scripts que pushean sin que `git push` aparezca en el comando (`npm run deploy`, `node -e` sin la cadena literal, herramientas MCP de git), funciones o alias de shell en archivos de arranque editados fuera de las tools de edición (las tools los tienen denegados), pushes fuera de Claude Code. Mitigación: protección de `main` en GitHub y revisión humana del PR |

## 11. Riesgo residual y condiciones

El riesgo residual es bajo para la exposición *accidental* (ramas equivocadas, comandos compuestos, carpetas, envoltorios comunes, alias): todo termina en `deny` o en una confirmación con el motivo a la vista. Para un agente deliberadamente adversarial dentro de la sesión, el hook es una capa de texto más el ensayo de git, y el muro es la protección de `main` en GitHub. Condiciones para operar con este estado:

1. **Validar en una sesión real de Claude Code, al adoptar el harness en el primer proyecto** (responsable de seguridad o coordinador; media hora): (a) que un `ask` del hook prompte aunque exista `allow Bash(git push:*)` — por ejemplo con `env git push origin <rama>` o `git push --no-verify origin <rama> --dry-run`, que deben pedir confirmación; (b) que con las reglas espejo `PowerShell(...)` la tool PowerShell quede activa y `git push origin HEAD:main` desde ella quede denegado; (c) que un push a `main` desde fuera de la sesión lo rechace GitHub con la protección aplicada por `init`. Los modos sin prompt (`bypassPermissions`, `--dangerously-skip-permissions`) no se verificaron: no usarlos en repos con este harness hasta validarlos.
2. **Protección de `main` en GitHub como muro**: para proyectos externos con datos sensibles, usar repos públicos o un plan con branch protection en privados (Pro/Team). En un repo privado Free la regla se sostiene solo en el hook y en la revisión del coordinador, y el harness lo avisa.
3. **Aprobaciones** (H-05): equipos con dos o más revisores suben a 1 aprobación obligatoria y activan code owners; el harness no lo rebaja.
4. **Cuentas y 2FA** (H-09): 2FA obligatorio en la organización, pocas cuentas admin, y revisión de la protección y de los admins al transferir el repositorio.
5. **Versión fijada** (H-09): quien no quiera parches automáticos instala `#vX.Y.Z` en vez de `#v1`.
6. **Regla de uso** (fricción asumida): el push va solo, en su propio comando y en su forma canónica; `git commit … && git push`, `env git push`, `git co main && git push`, `cd "$PWD" && git push` y similares piden confirmación, y la confirmación no se da a ciegas (skill `coe-github`).
7. **Residuales técnicos aceptados**: H-12, N-09, N-12, N-13 y H-16 según la sección 10; `--remerge-diff` no cubre merges octopus.

## 12. Recomendación

Proceder con el PR de release `dev` → `main` v1.0.0 en estado **READY WITH CONDITIONS**. Ningún hallazgo Critical ni High queda abierto; las dos condiciones técnicas del revisor están cerradas en `2666c42` y re-verificadas; las condiciones restantes (sección 11) son del coordinador y del responsable de seguridad: la validación en una sesión real al adoptar el harness, el plan de GitHub para repos privados, las aprobaciones, 2FA/admins y la versión fijada. No bloquean el merge del release, pero conviene cerrar la condición 1 antes de instalar el harness en el primer proyecto externo que maneje datos sensibles de la organización. El merge lo decide el coordinador; al mergear, `tag-release.yml` publica `v1.0.0` y el tag móvil `v1`.

## 13. Índice de evidencia

Todo en `docs/security/2026-10-06_103416/`:

| Archivo | Contenido |
|---|---|
| `00-run-metadata.md` | Fecha, commit inicial (`0939109`), alcance, entorno y limitaciones de la ejecución |
| `01-initial-security-review.md` | Revisión inicial (`/security-review` delegado): informe íntegro y tabla normalizada H-01–H-16 |
| `02-remediation-plan.md` | Plan de remediación por hallazgo: requisito, cambio, prueba, riesgo residual |
| `03-remediation-summary.md` | Qué se cambió en cada ciclo (`41100bf`/`6776d09`; `d9c52d8`/`1930816`/`3501be0`; `79e909d`; condiciones en `2666c42`), pruebas agregadas, riesgos residuales |
| `04-test-evidence.md` | Pruebas obligatorias con resultado y commit evaluado, por corrida |
| `05-final-security-review.md` | Las tres revisiones finales: ciclo 1 (gate NO, N-01–N-13), ciclo 2 (gate NO, R-01–R-09), ciclo 3 (gate SÍ, S-01–S-02) y el anexo de re-verificación de S-01/S-02 sobre `2666c42` |
| `SECURITY-AUDIT.md` | Este informe |

## 14. Declaración de assurance

> En la revisión final automatizada no se identificaron hallazgos Critical o High
> dentro del alcance y las limitaciones declaradas. Este informe habilita la
> evaluación final del responsable de seguridad y del coordinador del proyecto,
> pero no sustituye un pentest formal, la validación de infraestructura de
> producción ni la aprobación corporativa de despliegue.

# 02 — Plan de remediación

Gate de la skill `security-audit`: ningún `Critical`/`High` abierto, pruebas
obligatorias en verde, trazabilidad hallazgo → cambio → prueba. Se remedia el
High (H-01) y, por ser baratos y verificables, los Medium H-02, H-03, H-04, H-06,
H-07, H-08 y la parte mecánica de H-09, más los Low H-10/H-11/H-12/H-13 y el Info
H-14. H-05 y el resto de H-09 quedan como riesgo aceptado con condiciones (ver
§Riesgo residual).

| ID | Requisito verificable | Cambio propuesto | Prueba que lo valida | Riesgo residual |
|---|---|---|---|---|
| H-01 | Ningún `git push` cuyo destino **efectivo** sea `refs/heads/main|master` pasa en silencio: se deniega, o se pide confirmación (`ask`) cuando el hook no puede resolverlo con certeza | (1) `ramaDeDestino` normaliza `heads/<x>` y `refs/heads/<x>`; (2) tras los chequeos estáticos, el hook resuelve el destino real con `git push --dry-run --porcelain <mismos args>` y deniega si alguna línea apunta a `refs/heads/main|master`; (3) metacaracteres de shell (`$`, backtick, `{}`, globs), `git -c`, `--push-option`, `--receive-pack`, `--exec`, `--no-verify`, o un dry-run que falla → `permissionDecision: "ask"` con el motivo; (4) `settings.json` sin filtro `if` en los hooks (así `git -C`, `git -c` y comandos compuestos llegan al hook) y `Bash(git -c *)` en `ask` | Tests del hook: `HEAD:heads/main`, `+HEAD:heads/main`, `-c push.default=upstream`, `ma{i,}n`, `$(…)` → deny/ask; integración con dry-run contra remoto local | Un alias de git o un `pre-push` deshabilitado quedan fuera del texto del comando; mitigación documentada: la protección de `main` en GitHub donde el plan lo permite |
| H-02 | Un push a un remoto que no sea `origin` (nombre o URL) se deniega | `pushDelComando` expone el remoto; `prePush` deniega si el remoto explícito no es `origin`; sin remoto explícito, la URL `To <url>` del dry-run debe coincidir con `git remote get-url --push origin` | Test: `git push <url> HEAD:x` y `git push upstream x` → deny; `git push origin x` → sigue | El usuario puede pushear a mano a otro remoto (ese es el diseño) |
| H-03 | `upgrade --prune` nunca borra ni copia fuera del repo; un `dest` con `..`, absoluto, con `\` o bajo `.git/` se ignora con aviso | `destSeguro()` en `plan.js` aplicado a `lock.files` y `manifest.obsolete`; `apply.js` comprueba que la ruta a borrar y la del backup resuelven dentro de `cwd` (write guard también para borrados) | Test: lockfile con `../fuera/victima.txt` (hash correcto) → no se borra, no se copia, el plan lo descarta | Ninguno relevante |
| H-04 | `init`/`upgrade` nunca rebajan una protección de `main` existente | `GET` previo y `fusionarProteccion(existente, deseada)`: aprobaciones = máximo, `require_code_owner_reviews`/`dismiss_stale_reviews`/`required_conversation_resolution` se conservan si estaban, checks = unión | Test unitario de `fusionarProteccion` | Rulesets (no branch protection clásica) no se leen; se documenta |
| H-05 | `dev` protegida contra force-push y borrado; la limitación del check autoeditable queda documentada | `protegeRamaDev` (sin PR obligatorio: el bump de versión se commitea en `dev`); README/ADR documentan que con 0 aprobaciones el check lo controla el autor del PR y recomiendan 1 aprobación + code owners donde el equipo lo permita | Test del cuerpo de protección de `dev` | **Riesgo aceptado**: equipos de dos personas; mitigable con 1 aprobación |
| H-06 | El agente no puede editar los guardarraíles con sus tools de edición; una autorización de datos solo vale cuando ya está en `origin/dev`; las excepciones nuevas se reportan | `settings.json`: deny de `Edit`/`Write` sobre `.claude/hooks/**`, `.claude/settings.json`, `scripts/check-pr-rules.mjs`, `.datos-autorizados`, `.github/workflows/**`; `check-pr-rules.mjs` lee `.datos-autorizados` de `origin/dev` (fallback al working tree solo si `origin/dev` no existe); regla informativa `excepciones-nuevas` (líneas nuevas con `coe:no-secreto` o en `.datos-autorizados`) | Tests: autorización solo en el working tree → FAIL; en `origin/dev` → OK; `excepciones-nuevas` cuenta marcadores | `coe-harness upgrade` sigue escribiendo esos archivos por Bash (es su trabajo) |
| H-07 | Una línea de 100 K caracteres se escanea en < 1 s; un timeout no permite el push | Pre-chequeos baratos (`@`, `://`) antes de las regex caras, tope de 20 000 caracteres por línea (más allá se omite y se avisa), `ask` ante timeout/error del script | Test de tiempo con línea de 100 K `a.a.a…`; test de línea truncada | Secretos al final de líneas > 20 K no se escanean (documentado) |
| H-08 | Un "evil merge" que agrega un secreto se detecta en el pre-push | `git log … --remerge-diff` (git ≥ 2.36) en `diffSinPushear`/`archivosSinPushear`, con fallback a `-m --first-parent` | Test de integración: merge `--no-ff --no-commit` + `.env.staging` → FAIL | Git < 2.36 usa el fallback (más ruidoso, no menos seguro) |
| H-09 | Acciones fijadas por SHA; dependencias exactas; tags inmutables protegidos contra actualización/borrado | `actions/checkout` y `actions/setup-node` por SHA (comentando la versión), `package.json` con versiones exactas, ruleset en el repo del harness sobre `refs/tags/v*.*.*` (sin update ni delete), nota en `harness-upgrade` sobre fijar `#vX.Y.Z` en entornos estrictos | `verify`/tests existentes (los workflows son managed e idénticos) + lectura del ruleset creado | **Riesgo aceptado**: el tag móvil `v1` sigue siendo móvil por diseño; mitigado por 2FA/admins y por la opción de fijar versión |
| H-10 | El PostToolUse solo actúa sobre PRs del repo de `origin` | `prDeEsteRepo` también en `procesar` (PostToolUse) | Test: URL de otro repo en `tool_response` → no corre ni comenta | — |
| H-11 | "No se pudo verificar" nunca equivale a permitir | `ask` con motivo en lugar de `systemMessage` en todas las rutas de error del pre-push | Tests existentes adaptados (`status 2` → `ask`) | — |
| H-12 | Valores con `$` en el medio se consideran secretos; los límites del escaneo están documentados | `pareceSecreto` rechaza solo valores que **empiezan** con `$`/`${`/`$(`/`{{`/`<`/`%`; skill `datos-sensibles` lista lo que no se escanea | Tests de `pareceSecreto` | Palabras de ejemplo siguen eximiendo el valor (falsos positivos cuestan un push denegado) |
| H-13 | Texto honesto sobre la capa de lectura; mutaciones por `gh api` piden confirmación | Skill `datos-sensibles` corregida; `Bash(gh api -X *)`, `Bash(gh api --method *)` en `ask` | Lectura | Prefijos de permisos: cobertura parcial por diseño de Claude Code |
| H-14 | El nombre de la persona no se commitea por defecto | `OWNER` por defecto `por definir` (se completa a mano) | Test de transferibilidad | — |

## Riesgo residual tras la remediación

- **H-05 (aceptado con condiciones)**: con `required_approving_review_count: 0`
  el autor de un PR controla el script del check requerido y puede mergear él
  mismo. Es la contrapartida deliberada de no trabar equipos de dos personas
  (ADR §5). Condición: documentar en README que los equipos con dos o más
  revisores deben subir a 1 aprobación y activar "require review from code
  owners"; `init`/`upgrade` ya no rebajan esa configuración (H-04).
- **H-09 (aceptado con condiciones)**: `#v1` es un tag móvil por diseño (parches
  sin intervención). Condición: ruleset de tags inmutables en el repo del harness,
  2FA obligatorio en la organización, lista corta de admins, y la opción
  documentada de fijar `#vX.Y.Z` para entornos que lo exijan.
- **Alias de git y `pre-push` del propio desarrollador**: el hook de Claude Code
  trabaja sobre el texto del comando; un alias definido en `.gitconfig` no se ve.
  Condición: protección de `main` en GitHub (donde el plan lo permite) como
  segunda línea; se deja anotado como mejora futura el `pre-push` git instalado
  por el harness.

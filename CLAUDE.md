# CLAUDE.md — coe-harness

## Contexto

Proyecto de automation. Stack: Node.js.
Dominio: el generador de `coe-harness` — un CLI (`npx github:soutec-dev/coe-harness#v1`)
que instala y actualiza la superficie Claude (skills, settings, hook `reglas-pr`,
checks de PR, workflows) en repos de **proyectos externos**: repos que se trabajan
con otras empresas o que van a transferirse, y que por eso no dependen de ninguna
herramienta interna. Este repo se instala el harness a sí mismo (dogfood).

## Harness

Harness `coe-harness 1.0.0`. Sin agentes ni flujos fijos: el modelo
trabaja directo. Las skills viven en `.claude/skills/` y se aplican solas cuando el
contexto lo amerita (se eligen al instalar con `npx github:soutec-dev/coe-harness#v1`;
las cuatro primeras son obligatorias y siempre están):

- `coe-github` — flujo Git/GitHub: dos ramas, `main` protegido, PR obligatorio.
- `datos-sensibles` — credenciales y datos de la organización fuera del repo.
- `security-audit` — auditoría de seguridad gateada sobre `/security-review`.
- `security-report-standard` — estándar del informe de seguridad.
- `adr-new` — documentar decisiones con ADRs (si está instalada).
- `harness-upgrade` — actualizar el harness (si está instalada).

Este repo no depende de ninguna herramienta interna de la organización que lo
creó: todo lo que necesita está en el propio repo. Se puede transferir a otro
equipo u otra empresa tal cual, sin desconectar nada.

## Git — reglas duras

Hay **dos ramas permanentes**: `dev` (integración) y `main` (producción / lo que se
despliega).

**Nunca** hagas commit, push ni merge directo a `main`. Todo pasa por rama + PR. Los
hotfixes también. **`main` solo recibe merges desde `dev`**: las ramas de trabajo
nacen de `dev` y su PR apunta a `dev`; el paso `dev` → `main` es el release, también
por PR. El hook `reglas-pr` deniega cualquier `git push` a `main` desde la sesión, y
la branch protection de GitHub lo rechaza del otro lado.

- Ramas: `tipo/<slug>` (`feature/captura-lead`). Tipos: `feature` `fix` `hotfix`
  `docs` `chore` `refactor` `experiment`. Si hay un ID rastreable de un tracker
  (`feature/ABC-123-captura-lead`) va como prefijo del slug, pero **no inventes IDs**.
- Commits: `tipo: descripción breve` (sin scope). Tipos: `feat` `fix` `docs` `chore`
  `refactor` `test` `style` `build` `ci` `perf` `revert`. Un hotfix se commitea como
  `fix:`. Prohibidos: `update`, `cosas`, `ahora sí`.
- Sincronizar la rama: `git fetch origin && git merge origin/dev`. **Nunca
  `git push --force`** (el hook lo deniega; `--force-with-lease` solo sobre rama
  propia y con confirmación del usuario).
- **Yo no mergeo PRs, no los apruebo y no creo repositorios.** Eso es del
  coordinador del proyecto. Los **tags de versión** (`vX.Y.Z` + tag móvil por major)
  los crea el workflow `tag-release.yml` al mergear el release; si el repo no tiene
  Actions, los creo yo después del merge con `git fetch origin && node
  scripts/tag-release.mjs --ref origin/main`.
- **El PR se abre solo con el visto bueno del usuario**: cuando lo pide, dice que
  quiere mergear o responde que sí a tu pregunta. **Pregúntale una sola vez, cuando
  ya sea hora de cerrar** (el feature está terminado y verificado), si abres el PR;
  no lo menciones antes ni lo repitas en cada avance. Sin esa respuesta no lo abras:
  push a la rama y reportar.
- **Antes de abrir cualquier PR corre el security review**: `/security-review`
  sobre el diff de la rama, delegado a un subagente, y documenta el resultado en la
  sección "Security review" de la plantilla. Si el pedido de PR incluye correrlo,
  terminado el review no te detengas: sigue directo con push/PR si no hay hallazgos
  bloqueantes; si los hay, para y reporta. **Antes del PR de release `dev` → `main`**
  corre además la skill `security-audit` y adjunta su estado e informe.
- Al abrir el PR: completar `.github/pull_request_template.md` de verdad, con
  `gh pr create --body-file <archivo>`. Si piden correcciones, push a la **misma**
  rama — nunca un PR nuevo.
- **Checks de PR**: el hook `reglas-pr` de Claude Code corre `scripts/check-pr-rules.mjs`
  antes de cada `git push` (secretos y datos sensibles en los commits que subirían,
  destino `main`, `--force`) y al crear o editar el PR con `gh pr create`/`gh pr edit`
  (los tres grupos, con el resultado publicado como comentario en el PR). Los mismos
  checks corren en CI (`.github/workflows/reglas-pr.yml`). Un FAIL de `secretos` o
  `pr-metadata` se corrige antes de dar el PR por listo, y el hook **no se rodea**
  (skill `coe-github`).
- **GitHub Actions: solo los workflows que instala el harness** (`reglas-pr.yml`,
  `tag-release.yml`). No crees ni modifiques workflows por proyecto ni por
  funcionalidad; si el proyecto necesita CI propia, se acuerda con el coordinador.

## Secretos y datos sensibles — la regla más importante

**Ninguna credencial ni dato sensible entra al repositorio. Nunca. Ni en código, ni
en tests, ni en fixtures, ni en docs, ni en commits, ni en nombres de rama, ni en el
cuerpo de un PR, ni en capturas de pantalla.** Ante la duda, no se sube y se pregunta.

- **Credenciales**: `.env` (salvo `.env.example` sin valores), `*.pem`, `*.key`,
  `*.pfx`, `*.p12`, `credentials.json`, `secrets.json`, cuentas de servicio, tokens,
  contraseñas, connection strings con contraseña, llaves privadas, cookies de sesión,
  JWTs. Van en el gestor de secretos o en variables de entorno locales, jamás en git.
- **Datos de la organización**: nombres y datos personales de empleados o clientes,
  datos de nómina, salarios, legajos, evaluaciones, documentos de identidad, datos
  bancarios o de tarjetas, datos de salud, contratos, listados de clientes o
  proveedores, precios y condiciones comerciales no públicas, infraestructura
  interna (IPs, hostnames, diagramas detallados), volcados o logs de bases de datos
  reales. **No se suben sin autorización previa y explícita** del responsable de la
  información. La autorización la registra **el usuario** (nunca el agente) en
  `.datos-autorizados`, y el PR la declara en su sección "Datos sensibles". Para
  desarrollar y probar se usan datos sintéticos o anonimizados (skill
  `datos-sensibles`).
- Defensa en profundidad: `.claude/settings.json` deniega la lectura de archivos de
  credenciales, `.gitignore` los excluye, el hook `reglas-pr` deniega el `git push`
  que subiría un archivo o un contenido sospechoso (por nombre y por patrón: llaves,
  tokens, contraseñas, documentos de identidad, tarjetas, nóminas) y el mismo check
  corre en CI. **Nada de eso reemplaza el criterio**: el hook es una red, no un
  permiso. Nunca agregues `coe:no-secreto` ni líneas a `.datos-autorizados` por tu
  cuenta: eso lo decide el usuario.
- **Si una credencial o un dato se expuso** (aunque sea en un commit sin pushear):
  no basta con borrarlo. Avisa de inmediato al usuario: la credencial se rota y el
  dato se trata como filtrado; limpiar el historial es decisión del coordinador.
- Al reportar, pegar logs o adjuntar evidencia: **redacta** valores sensibles.

## Language

Responder siempre en español.

Cuando el idioma sea español, usar **español neutro** (estándar panhispánico): tuteo
(`usa`, `ten`, `fíjate`), sin voseo ni localismos regionales. Vocabulario entendible
en toda Hispanoamérica.

**El dominio se nombra en el lenguaje del negocio**; adaptadores, infraestructura y
todo lo que toca frameworks, en inglés.

## Reglas técnicas críticas

### Generador (este repo)
- El manifest (`templates/harness.manifest.json`) es la fuente de verdad de lo que se
  instala. Todo archivo nuevo en `templates/base/` necesita su entry —
  `node bin/cli.mjs verify --strict` y el test de dogfood lo vigilan.
- Este repo se instala el harness a sí mismo: tras editar un template `managed`,
  corre `node bin/cli.mjs upgrade --yes` para refrescar la copia local
  (`.claude/`, `scripts/`, `.github/`); los tests exigen que ambas sean idénticas.
- **Nada de lo que se emite puede mencionar herramientas internas de la
  organización** (tablero de milestones, trackers, vault de documentación,
  monitor): `test/transferencia.test.js` lo vigila. La única referencia externa
  permitida es la URL de este repo, para `upgrade`.
- Los archivos de skills con assets binarios llevan `"binary": true` en el manifest:
  sin eso, la lectura utf8 y la normalización LF corrompen los bytes.
- Escritura de archivos: siempre plana (nada de write-temp-then-rename): OneDrive y
  antivirus rompen el patrón "atómico" con EPERM.
- Las heurísticas de `check-pr-rules.mjs` **deniegan pushes**: cada patrón nuevo lleva
  un caso positivo y uno negativo en los tests, y nunca se agregan vías de escape
  automáticas (las dos que existen, `.datos-autorizados` y `coe:no-secreto`, son
  del usuario).
- Tests: `npm test` (Node >= 22.4). Guía de mantenimiento: `MAINTAINERS.md`.

## Behavior expectations

- Si algo es ambiguo o parece mal: **para y pregunta.** No adivines ni reinterpretes.
- No modificar archivos fuera del scope pedido.
- No instalar dependencias sin confirmar.
- Reportar honestamente si algo falla. **Sin workarounds silenciosos.**
- No modificar un test para que pase. Si el test está mal, dilo y para.
- Cambios chicos y quirúrgicos: lo más simple que resuelva el pedido, sin
  refactors de regalo ni archivos fuera de scope.

## Memoria

| Qué | Dónde |
|---|---|
| Learning del día, gotcha fresco | `notes.md` |
| Decisión con trade-off | `docs/decisions/` (`/adr-new`, si está instalada) |

## Referencias

`MAINTAINERS.md` · `docs/decisions/` · `notes.md` · `.github/pull_request_template.md` · `.datos-autorizados`

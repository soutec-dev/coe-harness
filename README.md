# coe-harness

**v1.0.0**

CLI para instalar y actualizar el harness de Claude Code pensado para **proyectos
externos**: repos que se trabajan junto a personas de otras empresas, o que en algún
momento van a transferirse, y que por eso **no pueden depender de ninguna
herramienta interna** de la organización que los creó. Todo lo que el harness
instala vive entero dentro del repo; se puede entregar el repositorio tal cual, sin
desconectar nada.

Tres reglas duras, y nada más:

1. **Dos ramas** — `dev` (integración) y `main` (producción). Todo pasa por Pull
   Request; nadie pushea a `main`, ni el coordinador.
2. **Ninguna credencial ni dato sensible de la organización entra al repo.** Nunca.
   Los datos de la organización solo entran con autorización previa, registrada.
3. **Seguridad siempre**: `/security-review` antes de cada PR y la auditoría gateada
   `security-audit` antes de cada release `dev` → `main`.

```bash
npx github:soutecdev/coe-harness#v1
```

Sin registry, sin `.npmrc`, sin token. Solo hace falta git y Node ≥ 22.4.

## Qué instala

```
CLAUDE.md                     contexto y reglas del proyecto para Claude
notes.md                      scratchpad persistente
.datos-autorizados            rutas con datos de la organización autorizados (lo edita el coordinador)
docs/decisions/               ADRs + su template (skill adr-new)
.claude/
  settings.json               deny de lectura de credenciales, deny de push a main y de
                              acciones del coordinador, registro del hook reglas-pr
  harness.json                lockfile: versión + hash + skills elegidas
  hooks/reglas-pr.mjs         hook de Claude Code: checks antes del push y al crear el PR
  skills/
    coe-github                flujo Git/GitHub (obligatoria)
    datos-sensibles           credenciales y datos de la organización fuera del repo (obligatoria)
    security-audit            auditoría de seguridad gateada sobre /security-review (obligatoria)
    security-report-standard  estándar del informe de seguridad (obligatoria)
    adr-new                   documentar decisiones con ADRs
    harness-upgrade           actualizar el harness desde Claude
.github/
  pull_request_template.md    con secciones de security review y datos sensibles
  CODEOWNERS                  el coordinador revisa la superficie de seguridad
  workflows/reglas-pr.yml     los tres grupos de checks en un solo job (check requerido)
  workflows/tag-release.yml   tags vX.Y.Z + vX al mergear el release (solo repos Node)
scripts/
  check-pr-rules.mjs          las reglas deterministas de PR, secretos y datos
  tag-release.mjs             (solo repos Node)
.gitignore                    bloque gestionado con credenciales y volcados, tus líneas intactas
```

Las skills opcionales se eligen al instalar (`init` muestra un checkbox con todas
marcadas; sin modo interactivo, `--skills adr-new,harness-upgrade`). Las cuatro
obligatorias entran siempre. La selección queda en el lockfile y los upgrades la
respetan.

Las skills son **project-local**: se commitean con el repo. Quien clona, las tiene.

## Las tres reglas y cómo se hacen cumplir

| Regla | En la sesión de Claude Code | En GitHub |
|---|---|---|
| `main` solo recibe merges desde `dev`, por PR | `settings.json` deniega `git push` a `main`; el hook `reglas-pr` deniega además cualquier refspec que apunte a `main`/`master`, `--force`/`-f`/`+refspec` y `--all`/`--mirror` | `init`/`upgrade` configuran la branch protection de `main` vía `gh api`: PR obligatorio, check `reglas-pr` en verde, sin force-push ni borrado, también para admins |
| Ninguna credencial ni dato sensible | `settings.json` deniega la lectura de `.env`, llaves y credenciales; el hook corre el grupo `secretos` sobre cada commit que un push subiría: archivos de credenciales por nombre, llaves/tokens/contraseñas por contenido, y datos personales o de nómina (documentos de identidad, tarjetas, listados de correos, nombres de archivo de nómina o clientes) | El mismo check corre en CI (`reglas-pr.yml`); la plantilla de PR obliga a declarar los datos y el check `pr-metadata` lo valida; `.gitignore` excluye lo típico |
| Security review por PR, auditoría por release | La skill `coe-github` exige delegar `/security-review` a un subagente antes de abrir el PR; `security-audit` corre antes del release | `pr-metadata` falla si la casilla del review no está marcada o si el PR de release no declara el estado `READY` de la auditoría |

Los checks son los mismos en los dos lados (`scripts/check-pr-rules.mjs`, tres
grupos): `rama-commits` es informativo; `secretos` y `pr-metadata` bloquean.

## Datos de la organización: autorización previa

Nombres y datos personales de empleados o clientes, nóminas, documentos de identidad,
datos bancarios, listados, volcados, infraestructura interna: **no entran al repo sin
autorización previa y explícita del responsable de la información**. La autorización
la registra el usuario (nunca el agente) en `.datos-autorizados` — una ruta o glob por
línea, con quién autorizó, cuándo y para qué — y el PR la declara en su sección
"Datos sensibles". Cambiar `.datos-autorizados` exige revisión del coordinador
(CODEOWNERS). Los fixtures sintéticos que las heurísticas confunden con datos reales
se registran ahí mismo, anotando que son sintéticos. Un falso positivo del escaneo de
secretos se resuelve marcando esa línea con `coe:no-secreto` — también decisión del
usuario. Detalle en la skill `datos-sensibles`.

## Comandos

| | |
|---|---|
| `coe-harness init` | Instala. Sirve igual en un repo vacío y en uno con código. |
| `coe-harness upgrade` | Actualiza a la última versión. Aplica migraciones. Reaplica la protección de `main`. |
| `coe-harness status` | Solo lectura. Exit 0 = al día · 1 = hay upgrade · 2 = drift. |
| `coe-harness adopt` | Para una estructura hecha a mano. **No toca ningún archivo**: solo escribe el lockfile. |
| `coe-harness verify` | Audita el propio harness (manifest vs `templates/`). |

Sin comando, se autodetecta: hay lockfile → `upgrade` · hay `CLAUDE.md` o `.claude/`
→ `adopt` · repo limpio → `init`.

Flags: `--dry-run` (imprime el plan, escribe cero bytes), `--yes`, `--force`,
`--prune`, `--no-backup`, `--verbose`, `--name/--type/--stack/--lang`, `--skills`.

## La garantía

**Un archivo tuyo nunca se sobrescribe en silencio.**

El motor clasifica cada archivo comparando qué hay en disco, qué dice el lockfile que
había, y qué querría emitir el harness hoy:

| En disco | En el lockfile | ¿Cambió el template? | Qué pasa |
|---|---|---|---|
| no está | no está | — | se crea |
| **está** | **no está** | — | **nunca se pisa** → `.new` al lado |
| está, intacto | está | no | nada |
| está, intacto | está | sí | se actualiza (no pierdes nada: no lo habías tocado) |
| está, **editado por ti** | está | no | se respeta, no se toca |
| está, **editado por ti** | está | sí | **nunca se pisa** → `.new` al lado |
| está | está, ya no en el manifest | — | obsoleto: intacto se borra con `--prune`; editado exige confirmación escrita |

Init, adopción y migración de versión **son el mismo code path**. Backup de todo lo
sobrescrito en `.claude/backup-<timestamp>/`; `--force` exige tipear `FORCE`.

Para los dos archivos que el harness no posee del todo: `.gitignore` (solo es dueño
de un bloque delimitado) y `.claude/settings.json` (solo **agrega** claves que
faltan; nunca pisa un valor que tú escribiste).

## Lo que NO trae, a propósito

Este harness nace del generador del harness interno de la organización
(`souclaude-harness`) y comparte su motor, pero deja fuera todo lo que ata un repo a
la operación interna: el tablero de milestones y kanban, los espejos en trackers
(Jira, Azure Boards), el monitor de consumo, la carpeta de progreso y los modos de
trabajo. El test `test/transferencia.test.js` falla si cualquier archivo emitido
vuelve a mencionarlos. La única referencia externa que queda es la URL de este
repo, para `upgrade`. El porqué completo está en
[docs/decisions/20261005-coe-harness-para-proyectos-externos.md](docs/decisions/20261005-coe-harness-para-proyectos-externos.md).

## GitHub Actions

El harness instala dos workflows y la skill `coe-github` prohíbe crear otros:

- `reglas-pr.yml` — un solo job por PR con los tres grupos de checks (un runner, no
  tres). Es el check requerido `reglas-pr` en la protección de `main`.
- `tag-release.yml` — al mergear el release crea `vX.Y.Z` y mueve `vX`. Solo en repos
  Node; en otros stacks la skill `harness-upgrade` guía al agente para escribir el
  equivalente.

Si la organización necesita pausar Actions, se reemplaza el `on:` de cada workflow
por `workflow_dispatch:` y se quita `reglas-pr` de los checks requeridos de `main`
(`CHECKS_REQUERIDOS` en `src/core/github-protect.js`): el hook de la sesión sigue
cubriendo el push y el PR, y los tags los crea el agente con
`node scripts/tag-release.mjs --ref origin/main`.

## Desarrollo

```bash
npm install
npm test                                    # node:test, sin dependencias de testing
node bin/cli.mjs init --dry-run --yes       # probar sin escribir nada
node bin/cli.mjs verify --strict            # manifest vs templates/
```

Este repo se instala el harness a sí mismo (dogfood): `.claude/`, `scripts/`,
`.github/` y `CLAUDE.md` salen de `node bin/cli.mjs init`, y los tests exigen que las
copias locales sean idénticas a las plantillas. Los fixtures de los tests usan
directorios temporales **con un espacio en la ruta** a propósito.

Guía para quien mantiene el generador: [MAINTAINERS.md](MAINTAINERS.md).

## Versionado y publicación

El harness y el CLI se versionan juntos (`harnessVersion` del manifest ==
`version` de `package.json`; un test lo exige). SemVer con prefijo `v`, dos tags:

- `vX.Y.Z` — inmutable, uno por release.
- `vN` (`v1`) — **móvil**, apunta al último release de esa serie. Es lo que consumen
  los proyectos: `#v1` recibe parches y minors sin hacer nada, y nunca un breaking
  por sorpresa. Cambiar de major es un acto explícito.

`main` solo recibe merges desde `dev`: el trabajo entra a `dev` por PR de rama, y el
release es un **PR de `dev` a `main`** con la versión propuesta en el cuerpo y el
estado de la `security-audit`. Tras el merge, `tag-release.yml` crea los tags.

# MAINTAINERS — cómo mantener y actualizar `coe-harness`

Guía para quien toca **el generador** (este repo), no para quien usa el harness en su
proyecto. Para eso, el [README](README.md) y las skills instaladas.

---

## Setup

```bash
npm install          # dos deps: @clack/prompts y picocolors
npm test             # node:test, sin dependencias de testing
node bin/cli.mjs init --dry-run --yes   # probar sin escribir nada
```

Requisitos: **Node ≥ 22.4** y git. No hay build step: el código que editas es el que se
publica.

---

## Mapa del repo

```
bin/cli.mjs              entrypoint (npx lo corre)
src/
  cli.js                 parseo de flags + dispatch + autodetección de comando
  ui.js                  prompts (clack); respeta --yes / CI=true
  commands/
    _shared.js           resolveVars() + resolveSkills() + planAndApply() + githubProtectionStep()
    init · upgrade · status · adopt · verify
  core/
    manifest.js          carga templates/harness.manifest.json
    detect.js            detecta el stack del repo host
    hash.js              sha256 sobre contenido normalizado a LF
    render.js            sustitución {{VAR}}
    block.js             append-block (.gitignore)
    jsonmerge.js         merge-json (settings.json)
    lockfile.js          lee/escribe .claude/harness.json
    plan.js  ◄           EL MOTOR: clasifica cada archivo (la tabla)
    apply.js             ejecuta el plan (write guard + backup)
    verify.js            audita manifest vs templates/
    github-protect.js    branch protection de main vía gh api
  migrations/index.js    transforms mecánicos versionados (vacío en 1.0)
templates/
  harness.manifest.json  ◄ qué archivos se emiten y con qué política
  base/                  el harness tal cual (con {{VARS}})
    claude/hooks/reglas-pr.mjs     el hook de la sesión
    scripts/check-pr-rules.mjs     las reglas (rama, secretos, datos, PR)
    claude/skills/*                las seis skills
  fragments/gitignore/   fragmentos por stack
test/                    node:test + helpers
```

**El manifest es el centro de todo.** Casi ningún cambio de contenido toca código: se
edita `templates/` y, si hace falta, una línea en el manifest.

**Este repo se instala el harness a sí mismo.** `.claude/`, `scripts/`, `.github/`
(salvo `ci.yml`), `CLAUDE.md`, `notes.md`, `.datos-autorizados` y `docs/decisions/`
los emitió `node bin/cli.mjs init`. Dos tests lo custodian: `dogfood.test.js` (todo
archivo de `.claude/` está en el manifest, y las copias managed son idénticas a sus
templates) y `check-pr-rules.test.js` (el script, el hook y los workflows locales son
idénticos a los distribuidos). Después de editar un template managed, corre
`node bin/cli.mjs upgrade --yes` para refrescar la copia local.

---

## Cómo actualizar — recetas

### 1. Cambiar el contenido de un archivo ya existente

Editas `templates/base/<ruta>` y listo. El efecto en repos ya instalados depende de la
**política** del archivo:

- **`managed`** (skills, hook, scripts, workflows): el `upgrade` lo sobrescribe solo si
  el usuario no lo tocó. Es lo normal para todo lo que el harness "posee".
- **`user-owned`** (`CLAUDE.md`, `notes.md`, PR template, CODEOWNERS,
  `.datos-autorizados`): en un repo ya instalado **no se pisa**; el dev recibe un
  `.new`. Cámbialo sabiendo eso.

Después: `node bin/cli.mjs upgrade --yes` (refresca la copia local), `npm test`, y
sube la versión (receta 6) para que `status` marque el upgrade.

### 2. Agregar un archivo nuevo al harness

1. Crea el template en `templates/base/<ruta>`. **Los dotfiles se guardan sin el punto**
   (`templates/base/datos-autorizados`, no `.datos-autorizados`) y el nombre real va en
   `dest`.
2. Agrega una entrada en `templates/harness.manifest.json` → `files[]`:
   ```json
   { "id": "mi-doc", "src": "base/docs/mi-doc.md", "dest": "docs/mi-doc.md",
     "render": true, "policy": "managed" }
   ```
   - `render: true` si el template usa `{{VARS}}`.
   - `when: "empty-repo"` si solo va en repos nuevos; `when: "stack:node"` si exige
     un runtime.
   - `skill: "<id>"` si pertenece a una skill elegible.
   - `binary: true` si es un asset binario (sin eso, la lectura utf8 lo corrompe).
3. Si usas una variable nueva (`{{FOO}}`), resuélvela en `src/commands/_shared.js` →
   `resolveVars()`. Si es una referencia a algo fuera del repo, no la agregues: rompe
   la transferibilidad (`test/transferencia.test.js`).
4. Agrega o extiende un test en `test/`.
5. Sube la versión (receta 6).

### 3. Agregar una regla de PR, un patrón de secreto o una heurística de datos

Todo vive en `templates/base/scripts/check-pr-rules.mjs`:

- `SECRETO_ARCHIVOS` — archivos de credenciales por nombre.
- `PATRONES_SECRETO` — formatos de tokens/llaves; con `valor`, el grupo capturado
  pasa por `pareceSecreto()` (placeholders y referencias al entorno no cuentan).
- `DATOS_ARCHIVOS`, `PATRONES_DOCUMENTO`, `PALABRAS_DE_NOMINA` — datos sensibles.
- Las reglas de `pr-metadata` son funciones `evalua*` con su propio `regla`.

Cada patrón nuevo lleva un caso positivo y uno negativo en
`test/check-pr-rules.test.js`. Pensar siempre en el falso positivo: el hook **deniega
el push**, no solo pinta un check en rojo. Las vías de escape (`coe:no-secreto`,
`.datos-autorizados`) son del usuario; no agregues otras automáticas.

### 4. Agregar un stack o un fragmento de `.gitignore`

- `src/core/detect.js` → `SIGNATURES`: agrega el stack.
- `templates/fragments/gitignore/<stack>.txt`: el fragmento. Se concatena con `base.txt`
  cuando ese stack se detecta. `verify` avisa de fragmentos huérfanos.

### 5. Deprecar o renombrar un archivo

- Sácalo de `manifest.files`.
- En repos que lo tenían, el motor lo detecta como **`obsolete`** (vía el lockfile) y lo
  borra con `--prune` si está intacto; si lo editaron, exige confirmación escrita.
- Para detectarlo también en repos **sin lockfile**, agrégalo a `manifest.obsolete[]`:
  `{ "dest": "...", "reason": "..." }`.

### 6. Publicar una versión

1. Sube `harnessVersion` en `templates/harness.manifest.json` y `version` en
   `package.json` (se mueven juntas; un test lo exige). `npm install` para refrescar
   `package-lock.json`.
2. Actualiza `CHANGELOG.md`.
3. `npm test` y `node bin/cli.mjs verify --strict`.
4. Release: **`main` solo recibe merges desde `dev`**. El trabajo entra a `dev` por PR
   de rama; el release es un PR de `dev` a `main` con la versión propuesta en el cuerpo
   y el estado de la `security-audit` (el check `pr-metadata` lo exige).
5. Tags: `tag-release.yml` crea `vX.Y.Z` y mueve `vN` al mergear. Si Actions no corre,
   `git fetch origin && node scripts/tag-release.mjs --ref origin/main`.
6. Los proyectos corren `npx github:soutec-dev/coe-harness#v1 upgrade` y reciben la
   nueva versión. Un breaking sube el major y estrena su propio tag móvil (`v2`); los
   proyectos cambian de major editando la ref.

### 7. Una migración (cambio mecánico sobre un archivo que el usuario editó)

El seed-merge y el hash-diff **solo agregan / sobrescriben lo intacto**. Para un cambio
mecánico sobre lo que ya hay en disco (reemplazar una línea concreta de `CLAUDE.md`,
remover una clave de `settings.json`), agrega una entrada en
`src/migrations/index.js`:

```js
{
  id: 'v1-1-algo',
  to: '1.1.0',
  dest: 'CLAUDE.md',
  describe: 'qué hace, en una línea (se muestra al usuario)',
  transform(content) { /* recibe lo de disco, devuelve lo corregido */ },
}
```

Corre **antes** de comparar; sobre un archivo editado por el usuario se aplica en el
lugar, con backup y sin reclamar su hash. Que sea una función chica.

---

## Cómo funciona por detrás

**Instalar, adoptar un repo con código y migrar de versión son el mismo code path.**
No hay tres flujos; hay una tabla de clasificación.

Para cada archivo del manifest, el motor compara por hash tres cosas: lo que hay **en
disco**, lo que el **lockfile** (`.claude/harness.json`) dice que emitimos la última
vez, y lo que el **template** querría emitir hoy. El hash es `sha256(contenido
normalizado a LF)`: así `autocrlf` y los editores de Windows no marcan todo como
"modificado".

| Política | Significado |
|---|---|
| `managed` | El harness manda. Se sobrescribe solo si el hash en disco coincide con el lockfile. |
| `user-owned` | Se siembra una vez y **nunca más se toca**. Si el template cambió, se escribe `.new`. |
| `append-block` | El harness es dueño de un bloque delimitado dentro del archivo (`.gitignore`). |
| `merge-json` | Solo **agrega** claves que faltan (`settings.json`). Nunca pisa un valor del usuario. |

| Veredicto | Cuándo | Acción |
|---|---|---|
| `create` | no existe, no está en el lockfile | escribir |
| `update` | intacto desde la última vez, el template cambió | sobrescribir |
| `noop` | idéntico a lo deseado | no tocar |
| `local-edit` | lo editaste tú, el template no cambió | dejarlo |
| `conflict` | lo editaste tú **y** el template cambió | `.new` al lado |
| `foreign` | existe pero nunca lo escribimos nosotros | `.new` al lado |
| `restore` | lo escribimos y lo borraste | reescribir |
| `obsolete` | estaba en el lockfile, ya no en el manifest | `--prune` |
| `migrate` | lo editaste tú y una migración cambia algo | solo el cambio, en el lugar, con backup |

`apply.js` tiene un **write guard**: solo escribe rutas que salieron del plan que el
usuario vio; cualquier otra tira error. Hace backup de todo lo que sobrescribe. Al
final reescribe el lockfile con el hash de lo emitido.

**Greenfield es "sticky"**: si el repo era vacío se decide una vez y queda en el
lockfile. Sin esto, la segunda corrida vería el repo poblado y marcaría `README.md`
como obsoleto.

**La protección de `main`** (`github-protect.js`) corre después del plan, nunca en
`--dry-run`, y nunca bloquea la instalación si falla (sin `gh`, sin remoto, sin
permiso de admin): se reporta y se sigue.

---

## Tests

`node:test`, in-process, sin dependencias.

```bash
npm test
node --test "test/check-pr-rules.test.js"     # un archivo
```

Los invariantes que atrapan casi todo:

- **Idempotencia**: correr `init` dos veces → la segunda no escribe nada.
- **Pureza de `--dry-run`**: el árbol queda byte-idéntico.
- **NUNCA SE PISA**: un archivo editado por el usuario nunca se sobrescribe.
- **Transferibilidad**: ningún archivo emitido menciona herramientas internas.
- **Espejos**: las copias locales (dogfood) son idénticas a las distribuidas.

Los tests de `check-pr-rules` y del hook corren el script real contra repos git en
directorios temporales (con espacios en la ruta), sin red.

## Licencia y política de contribuciones

- Licencia Apache 2.0: `LICENSE` (texto íntegro), `NOTICE` (copyright de SOUTEC) y
  `"license": "Apache-2.0"` en `package.json`. Si alguna vez cambia, se tocan los tres.
- Sin contribuciones externas, aunque el repo sea público: issues, wiki y proyectos
  desactivados (Settings → General); interacciones limitadas a colaboradores
  (Settings → Moderation → Interaction limits). **GitHub caduca ese límite a los seis
  meses**: hay que renovarlo, con la interfaz o con
  `gh api -X PUT repos/soutec-dev/coe-harness/interaction-limits -f limit=collaborators_only -f expiry=six_months`.
  Los workflows de PRs externos solo corren con aprobación (Settings → Actions →
  General → "Require approval for all external contributors"). Opcional, solo desde la
  interfaz: Settings → Moderation → Code review limits, para que solo quien tenga
  acceso pueda aprobar o pedir cambios.
- Si aun así llega un PR o un issue externo, se cierra con un comentario cortés que
  remita a `CONTRIBUTING.md`; un fork externo es legítimo (lo permite la licencia), lo
  que no se acepta es el cambio en este repo.

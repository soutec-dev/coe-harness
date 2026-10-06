# ADR: coe-harness, un harness hermano para proyectos externos

**Fecha**: 2026-10-05
**Status**: accepted
**Deciders**: coordinación del harness

## Context

El harness interno de la organización (`souclaude-harness`) instala en cada repo
una superficie de Claude Code que está, por diseño, **acoplada a la operación
interna**: un tablero de milestones y kanban en un repositorio de documentación
compartido, espejos de ese tablero en trackers externos (Jira o Azure Boards),
un monitor de consumo de tokens que publica en ese mismo repositorio, una
carpeta `progress/` con el protocolo de trazabilidad, y dos modos de trabajo
(equipo / solo) que multiplican plantillas y pruebas. Ese acoplamiento es
correcto para los repos internos: la trazabilidad es parte del método.

Hay un segundo tipo de proyecto donde ese acoplamiento es un problema: los
**proyectos externos**, que se trabajan junto a personas de otras empresas o que
van a transferirse a un cliente al terminar. Ahí:

- El repo tiene que poder **entregarse tal cual**, sin desconectar nada ni dejar
  referencias a herramientas a las que la otra parte no tiene (ni debe tener)
  acceso.
- La metodología interna no aplica a la otra parte; lo que sí tiene que
  sobrevivir es lo mínimo e innegociable: un **flujo de GitHub simple** (dos ramas,
  `main` protegido, todo por PR), la **prohibición absoluta de credenciales y datos
  sensibles** en el repo, y la **auditoría de seguridad** (`/security-review`) que
  hoy ya exige el harness interno.
- Aparece un riesgo que el harness interno no cubre con el mismo énfasis: subir
  **datos de la organización** (nombres, nóminas, datos de empleados o clientes)
  a un repo que va a ver gente de afuera. Hace falta una regla de **autorización
  previa** y una red que la haga cumplir.

Restricciones: el motor de plan/lockfile del harness interno (la garantía de que
un archivo del usuario nunca se pisa, `init`/`upgrade`/`adopt` como un solo code
path, el manifest como fuente de verdad) está probado y no conviene reinventarlo.
Y el harness externo debe poder evolucionar sin arrastrar al interno ni ser
arrastrado por él.

## Decision

Crear **`coe-harness`**, un generador hermano en su propio repositorio
(`soutecdev/coe-harness`, `npx github:soutecdev/coe-harness#v1`), que:

1. **Reutiliza el motor** del harness interno copiado tal cual (`plan`, `apply`,
   `lockfile`, `manifest`, `hash`, `render`, `block`, `jsonmerge`, `verify`,
   `detect`, `ui`) y los comandos `init`/`upgrade`/`status`/`adopt`/`verify`
   recortados: sin Vault, sin monitor, sin `vault-sync`, sin CLI global, sin
   modos. Una sola superficie.
2. **Instala solo lo transferible**: `CLAUDE.md`, `notes.md`, `settings.json`, el
   hook `reglas-pr`, `check-pr-rules.mjs`, la plantilla de PR, CODEOWNERS, dos
   workflows, `.gitignore` reforzado, `.datos-autorizados` y seis skills
   (`coe-github`, `datos-sensibles`, `security-audit`, `security-report-standard`
   obligatorias; `adr-new`, `harness-upgrade` opcionales). Un test
   (`transferencia.test.js`) falla si cualquier archivo emitido vuelve a
   mencionar las herramientas internas. La única referencia externa es la URL del
   propio harness, para `upgrade`.
3. **Refuerza las tres reglas con mecanismos, no solo con texto**:
   - `main`: deny en `settings.json`, deny en el hook para cualquier refspec a
     `main`/`master`, `--force`/`-f`/`+refspec` y `--all`/`--mirror`, y branch
     protection en GitHub con el check `reglas-pr` requerido.
   - Secretos y datos: el grupo `secretos` deja de mirar solo nombres de archivo
     y pasa a escanear el **contenido** de los commits (llaves, tokens,
     contraseñas, con filtro de placeholders) y a aplicar **heurísticas de datos
     personales y de nómina** (documentos de identidad, IBAN/CBU, tarjetas con
     Luhn, listados de correos, nombres de archivo de nómina/clientes/volcados).
     Las dos vías de excepción —`.datos-autorizados` y el marcador
     `coe:no-secreto`— son decisiones del usuario, nunca del agente, y la
     plantilla de PR obliga a declarar los datos (`datos-sensibles-declarados`).
   - Seguridad: `/security-review` delegado antes de cada PR (regla
     `security-review-declarado`) y la skill `security-audit` —la auditoría
     gateada del harness interno, sin la identidad gráfica ni el PDF, con el
     informe en Markdown dentro de `docs/security/`— obligatoria antes de cada
     release `dev` → `main` (el check lo exige en los PRs a `main`).
4. **CI activa pero mínima**: un solo job por PR con los tres grupos
   (`reglas-pr.yml`) en vez de tres workflows, y `tag-release.yml` por release.
   La pausa de Actions vigente en la organización para el harness interno fue una
   medida de costo "hasta optimizar los checks"; este harness nace con la versión
   optimizada y documenta cómo pausarla si hiciera falta.
5. **Branch protection sin aprobaciones obligatorias** (0 approvals, PR
   obligatorio, `enforce_admins`): en un equipo de dos, exigir una aprobación deja
   trabado el release cuando lo abre el propio coordinador. Equipos con dos o más
   revisores lo suben a 1 en GitHub; CODEOWNERS ya lo deja listo.

El repo del generador se instala el harness a sí mismo (dogfood) y, a diferencia
del interno, **no exige tablero ni milestone en su propio `CLAUDE.md`**: practica
lo que distribuye. Su desarrollo se traza, si la organización lo desea, desde el
tablero interno, pero nada en el repo lo requiere.

## Consequences

### Positivas
- Un repo instalado con `coe-harness` se transfiere tal cual: no hay nada que
  desconectar, y la otra parte recibe reglas que puede seguir con cualquier
  cliente de Claude Code.
- Las tres reglas tienen enforcement en dos lugares (sesión y GitHub), con el
  mismo script, así que cubren tanto al agente como a un colaborador humano que
  pushea desde su máquina.
- El escaneo de contenido y las heurísticas de datos cierran el hueco más grave
  del harness interno, que solo miraba nombres de archivo.
- El harness externo puede evolucionar a su ritmo (sus propias versiones, su
  propio tag móvil `v1`).

### Negativas
- **Dos generadores que comparten motor por copia.** Un fix en `plan.js` o
  `apply.js` hay que aplicarlo en los dos. Es deliberado para no acoplarlos hoy;
  si la deriva empieza a doler, el paso siguiente es extraer el motor a un
  paquete compartido.
- Las heurísticas de datos sensibles producen falsos positivos (un fixture
  sintético con CUILs válidos, un ejemplo de IBAN en la documentación). El costo
  es una línea en `.datos-autorizados` o un marcador, decidido por el usuario; el
  costo de no tenerlas es una nómina en un repo ajeno.
- CI consume minutos de Actions en los repos consumidores (un job por PR).

### Neutras
- Las heurísticas no detectan un nombre y apellido sueltos ni un dato sin forma
  de patrón: la regla de autorización previa sigue siendo, ante todo, una regla de
  criterio que el agente y el equipo aplican; el hook es una red.
- `coe-harness` no instala `.mcp.json` ni ningún conector: si un proyecto externo
  necesita uno, lo agrega el proyecto, fuera del harness.

## Alternatives considered

### Alternativa A: un "modo externo" dentro del harness interno
**Pros**: un solo generador, un solo motor, una sola suite.
**Cons**: el código del generador seguiría cargando Vault, monitor y espejos; la
matriz de modos (equipo / solo / externo) crece en plantillas, manifest y tests;
el consumidor correría `npx souclaude`, que apunta al repo interno y a sus
defaults (URL del Vault en el manifest, CLI global que instala el monitor), y la
transferibilidad quedaría dependiendo de no activar nada por accidente.
**Por qué se descartó**: la garantía de "nada interno" tiene que ser estructural,
no una combinación de flags.

### Alternativa B: un repositorio plantilla ("Use this template") con la superficie copiada
**Pros**: cero código; el consumidor copia y listo.
**Cons**: sin `upgrade` no hay forma de distribuir una regla nueva o un patrón de
secreto nuevo a los proyectos ya creados; sin `verify` ni lockfile, la deriva
entre proyectos es inmediata; sin branch protection automática, `main` queda a
merced de la configuración manual de cada repo.
**Por qué se descartó**: el valor del harness está en poder actualizarlo; un
template congela el día cero.

### Alternativa C: un generador hermano con el motor copiado (elegida)
**Pros**: transferibilidad estructural, motor probado, evolución independiente,
suite propia; el costo de la copia es acotado (el motor son ~700 líneas estables).
**Cons**: duplicación del motor.
**Por qué se eligió**: es la única que cumple a la vez "nada interno" y
"actualizable", y la duplicación tiene una salida conocida (extraer un paquete)
si llega a doler.

## References

- `souclaude-harness` (harness interno): su README, `MAINTAINERS.md` y los ADRs
  de pausa de Actions y de checks de PR en la sesión, de los que este harness
  hereda el motor, el hook y el script de reglas.
- `templates/base/scripts/check-pr-rules.mjs`,
  `templates/base/claude/hooks/reglas-pr.mjs`, `src/core/github-protect.js`.
- `test/transferencia.test.js`, `test/check-pr-rules.test.js`,
  `test/hook-reglas-pr.test.js`.

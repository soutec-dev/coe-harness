---
name: security-audit
version: 1.0.0
description: Auditoría de seguridad gateada. Ejecuta el /security-review nativo de Claude Code sobre el alcance elegido, remedia los hallazgos Critical/High, repite el review y genera el informe de evidencia en Markdown (docs/security/) solo después de superar el gate. Obligatoria antes de cada release dev → main (skill coe-github); también cuando el usuario pida "auditoría de seguridad", "security audit" o "revisar la seguridad del proyecto", o cuando un cambio toque autenticación, autorización, manejo de datos personales, pagos, criptografía o infraestructura.
argument-hint: "[scope opcional: full | branch | diff | ruta-o-modulo]"
effort: high
allowed-tools:
  - Skill(security-review)
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - Bash(git status *)
  - Bash(git rev-parse *)
  - Bash(git branch *)
  - Bash(git diff *)
  - Bash(git log *)
---

# Security Audit — auditoría de seguridad gateada

Este workflow se ejecuta cuando un humano corre:

```text
/security-audit $ARGUMENTS
```

o cuando el flujo del proyecto lo exige: **antes de cada release `dev` → `main`**
(skill `coe-github`, sección "Release"). El security review ligero por PR (un
`/security-review` sobre el diff de la rama) no reemplaza esta auditoría: aquella
mira un cambio; esta mira lo que va a producción, con remediación y evidencia.

No reemplaces ni sobrescribas el comando nativo `/security-review`. Debes invocarlo
mediante el `Skill` tool como parte de este proceso.

## Objetivo

Producir evidencia técnica compartible con el responsable de seguridad del
proyecto (o quien el proyecto designe) de que:

1. se ejecutó el security review nativo de Claude Code;
2. todo hallazgo `Critical` o `High` fue corregido con un plan de remediación trazable;
3. se ejecutaron las pruebas aplicables;
4. se repitió el security review después de los cambios;
5. el informe final solo fue generado después de superar el gate final.

El informe no debe afirmar que la aplicación es "completamente segura" ni funcionar
como certificación absoluta. Debe declarar con precisión que no se detectaron
hallazgos `Critical` o `High` dentro del alcance y limitaciones de la revisión final.

## Alcance

Si `$ARGUMENTS` viene vacío y la auditoría la pidió un humano, **antes de ejecutar
nada** pregunta qué alcance usar, mostrando las opciones disponibles:

- `full` (repositorio completo);
- `branch` (rama actual frente a su upstream o base disponible);
- `diff` (cambios no confirmados y commits de la rama frente a su base);
- ruta, módulo o componente (foco limitado a ese elemento y sus dependencias de
  seguridad relevantes).

No asumas `full` en silencio. Si el humano no responde con un alcance concreto, o
confirma explícitamente que no tiene preferencia, entonces sí resuelve a `full`.

Si la auditoría la dispara el flujo de release, el alcance por defecto es `diff`
entre `main` y `dev` (lo que entra al release); si no hay release previo, `full`.

Si `$ARGUMENTS` no viene vacío, resuélvelo directo sin preguntar.

Declara siempre exclusiones, supuestos y limitaciones.

## Directorio de evidencia

Crea un directorio nuevo por ejecución:

```text
docs/security/YYYY-MM-DD_HHMMSS/
```

No sobrescribas evidencia de ejecuciones anteriores. La evidencia se commitea con
el repo (es parte del release), así que **nunca contiene secretos ni datos de
personas**: redacta antes de guardar (skill `datos-sensibles`).

Dentro del directorio conserva, como mínimo:

```text
00-run-metadata.md
01-initial-security-review.md
02-remediation-plan.md              # solo cuando aplique
03-remediation-summary.md           # solo cuando aplique
04-test-evidence.md
05-final-security-review.md
SECURITY-AUDIT.md                   # solo si el gate final pasa
SECURITY-AUDIT-BLOCKED.md           # solo si el gate no pasa
```

`02-remediation-plan.md` es el plan de remediación de esta ejecución. Si el
repositorio ya define otra convención para documentar planes, el archivo debe
contener un enlace o referencia inequívoca a la ruta oficial.

## Fase 1 — Registrar metadata

Antes de revisar, registra sin modificar el repositorio:

- fecha y hora local y UTC;
- nombre del proyecto o repositorio;
- alcance resuelto;
- rama actual;
- commit HEAD;
- rama base o upstream cuando pueda determinarse;
- estado del working tree;
- archivos modificados relevantes;
- versión de Claude Code cuando esté disponible sin instalar nada;
- limitaciones conocidas del ambiente.

Nunca copies valores de secretos, tokens, contraseñas, llaves privadas ni
connection strings. Redáctalos.

## Fase 2 — Security review inicial nativo

Invoca el skill nativo `security-review` mediante el Skill tool.

Pásale el alcance resuelto y solicita que:

- inspeccione vulnerabilidades y controles de seguridad;
- incluya severidad, evidencia, ubicación e impacto;
- separe hallazgos confirmados de dudas o gaps de cobertura;
- revise explícitamente el manejo de secretos y de datos personales (que no
  haya credenciales en el código ni datos de personas en fixtures, logs o
  documentación);
- no aplique cambios durante esta primera revisión;
- entregue una salida suficientemente detallada para remediación y auditoría.

Guarda la salida completa, sin reinterpretarla, en:

```text
01-initial-security-review.md
```

Después crea una tabla normalizada de hallazgos con:

- ID;
- severidad;
- título;
- archivo o componente;
- estado inicial;
- evidencia;
- acción requerida.

Si la severidad de un hallazgo potencial no está clara, no lo rebajes por
conveniencia. Trátalo como `Needs validation` y resuélvelo antes de declarar el
gate como aprobado.

## Gate de remediación

### Bloqueantes

La existencia de cualquiera de los siguientes impide generar el informe final:

- al menos un hallazgo `Critical` abierto;
- al menos un hallazgo `High` abierto;
- pruebas obligatorias fallidas;
- review final incompleto o no verificable;
- gap de cobertura que impida evaluar razonablemente un control crítico;
- secretos expuestos que aún no hayan sido revocados o rotados;
- datos personales o de la organización presentes en el repo sin autorización
  registrada en `.datos-autorizados`;
- cambios de seguridad sin prueba de regresión o validación equivalente.

### No bloqueantes para crear el informe, pero obligatorios en él

- hallazgos `Medium` abiertos;
- hallazgos `Low`;
- observaciones `Informational`;
- riesgos aceptados explícitamente;
- limitaciones de cobertura que no impidan evaluar los controles críticos.

Un `Medium` abierto produce el estado `READY WITH CONDITIONS`, nunca una declaración
limpia de aprobación.

## Fase 3 — Remediación de Critical/High

Si no existen hallazgos `Critical` o `High`, omite esta fase y continúa con pruebas
y review final.

Si existen, remedia tú mismo, con este contrato:

1. Escribe primero un plan de remediación en `02-remediation-plan.md` que cubra
   cada hallazgo `Critical` y `High`: requisito verificable, cambio propuesto,
   prueba que lo valida y riesgo residual.
2. Implementa las correcciones; no te limites a redactar el plan.
3. Añade pruebas de regresión y controles negativos.
4. Ejecuta las pruebas aplicables y registra comandos y resultados.
5. No ocultes, suprimas ni rebajes hallazgos para superar el gate.
6. No edites el reporte original del security review.
7. Registra en `03-remediation-summary.md` archivos modificados, pruebas
   ejecutadas, resultados y riesgos residuales.

Para secretos expuestos, eliminar el valor del código no basta: hay que tratar
revocación o rotación, limpieza segura, configuración correcta y prevención de
recurrencia. Si la rotación requiere una acción humana no disponible, el gate
permanece bloqueado. Para datos personales expuestos, la decisión de notificación
y de limpieza del historial es del coordinador: regístrala como acción humana
requerida.

## Fase 4 — Pruebas

Ejecuta las pruebas apropiadas para el stack y el alcance, siguiendo primero las
instrucciones del repositorio.

Incluye cuando apliquen:

- pruebas unitarias;
- integración;
- autorización por rol o tenant;
- validación de entradas;
- regresiones específicas de los hallazgos;
- lint y type checking;
- build de producción;
- pruebas de infraestructura o configuración;
- escaneo de dependencias ya disponible en el proyecto;
- el check de secretos del propio harness:
  `node scripts/check-pr-rules.mjs --grupo secretos`.

No instales herramientas nuevas solo para decorar el reporte. Si una herramienta
necesaria no está disponible, registra la limitación y determina si bloquea el gate.

Guarda en `04-test-evidence.md`:

- comando exacto;
- fecha;
- resultado;
- resumen de errores;
- archivos de log relevantes (redactados);
- qué hallazgo valida cada prueba de seguridad.

Cualquier prueba obligatoria fallida bloquea el informe.

## Fase 5 — Security review final nativo

Después de la remediación y las pruebas, invoca nuevamente el skill nativo
`security-review` con el mismo alcance.

Solicita explícitamente que:

- revise el estado actual del código, no el reporte anterior;
- verifique las rutas afectadas por los hallazgos iniciales;
- busque regresiones o vulnerabilidades introducidas por las correcciones;
- reporte severidad, evidencia y cobertura;
- no confunda una prueba existente con evidencia suficiente si el control sigue
  siendo evadible.

Guarda la salida completa en:

```text
05-final-security-review.md
```

## Ciclo de remediación

Si el review final mantiene o introduce hallazgos `Critical` o `High`:

1. no generes el informe final;
2. actualiza el plan de remediación e implementa la siguiente iteración;
3. vuelve a ejecutar pruebas;
4. vuelve a ejecutar el security review nativo.

Máximo: tres ciclos de remediación en una misma ejecución.

Si después de tres ciclos persisten bloqueantes, crea únicamente:

```text
SECURITY-AUDIT-BLOCKED.md
```

Debe incluir:

- estado `NOT READY FOR REVIEW`;
- bloqueantes pendientes;
- intentos realizados;
- pruebas fallidas o cobertura insuficiente;
- acción humana requerida;
- rutas de la evidencia generada.

No generes un informe "preliminar", "draft" o "con observaciones" mientras exista
un `Critical` o `High`. Cambiarle el apellido al informe no vuelve segura la
aplicación.

## Fase 6 — Gate final

El gate pasa únicamente cuando:

- el review final no contiene `Critical` ni `High` abiertos;
- las pruebas obligatorias pasan;
- no existe un gap que impida verificar un control crítico;
- cualquier secreto expuesto fue revocado o rotado, no solo removido del código;
- no quedan datos de la organización sin autorización en el repo;
- existe trazabilidad entre hallazgos, cambios y pruebas.

Estado final:

- `READY FOR REVIEW`: cero `Critical`, `High` y `Medium` abiertos;
- `READY WITH CONDITIONS`: cero `Critical` y `High`, pero existen `Medium`, riesgos
  aceptados o limitaciones no críticas;
- `NOT READY FOR REVIEW`: cualquier condición bloqueante.

La aprobación final del paso a producción sigue perteneciendo al responsable de
seguridad y al coordinador del proyecto.

## Fase 7 — Generar el informe

Solo después de pasar el gate, compila la evidencia tú mismo: usa como fuentes la
metadata, el review inicial, el plan y resumen de remediación cuando existan, los
resultados de pruebas, el review final y el estado final calculado. La estructura
del informe es la de `report-template.md` (y el estándar `security-report-standard`).

Escribe `SECURITY-AUDIT.md` en Markdown plano, sin dependencias de estilo: tiene
que poder leerse en GitHub tal cual. Si el proyecto necesita PDF, se convierte
después con la herramienta que el proyecto use; el Markdown es la fuente.

Verifica después:

- el archivo existe y tiene contenido;
- el informe no contiene secretos ni datos de personas sin redactar;
- el estado del informe coincide con el gate;
- los hallazgos iniciales corregidos aparecen como remediados, no eliminados del
  historial;
- cualquier `Medium` pendiente aparece claramente en condiciones o riesgo residual.

## Respuesta final al humano

Si el gate pasa, devuelve:

```markdown
# Security Audit Completed

- Status: READY FOR REVIEW | READY WITH CONDITIONS
- Scope: <alcance>
- Initial findings: <conteos>
- Remediated Critical/High: <conteos>
- Remaining Medium/Low: <conteos>
- Tests: PASSED
- Report: docs/security/<fecha>/SECURITY-AUDIT.md
- Approval: PENDING (responsable de seguridad / coordinador)
```

Si el gate no pasa, devuelve:

```markdown
# Security Audit Blocked

- Status: NOT READY FOR REVIEW
- Scope: <alcance>
- Blocking findings: <conteos y IDs>
- Tests: PASSED | FAILED | INCOMPLETE
- Blocked report: docs/security/<fecha>/SECURITY-AUDIT-BLOCKED.md
- Required action: <acción concreta>
```

Cuando la auditoría forma parte de un release, el estado y la ruta del informe van
en la sección "Security review" del PR `dev` → `main` (el check `pr-metadata` lo
exige). Nunca presentes el resultado como certificación, pentest formal o garantía
absoluta de seguridad.

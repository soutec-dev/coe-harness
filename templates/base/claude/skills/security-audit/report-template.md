# Auditoría de seguridad — {{PROJECT}}

<!--
Referencia estructural del informe de evidencia, en Markdown plano: tiene que
leerse en GitHub tal cual, sin dependencias de estilo. Contenido y
trazabilidad: skill `security-report-standard`.

- Sustituye cada {{PLACEHOLDER}} con evidencia real y verificada. No inventes
  resultados, no rebajes severidades y no elimines hallazgos corregidos del
  historial.
- Nunca uses afirmaciones absolutas ("la aplicación es segura", "certificada").
- Redacta todo valor sensible (secretos, tokens, documentos, correos, nombres
  de personas): el informe se commitea con el repo.
- Mantén las tablas en 6-7 columnas como máximo; si una tabla necesita más,
  parte la información.
- Este comentario no se renderiza en el informe final: bórralo.
-->

> **Resumen general**: {{EXECUTIVE_CONCLUSION}}

## 1. Estado de la auditoría

| Campo | Valor |
|---|---|
| Proyecto | {{PROJECT}} |
| Estado | {{STATUS}} |
| Fecha de la auditoría | {{DATE}} |
| Rama | {{BRANCH}} |
| Commit inicial | {{INITIAL_COMMIT}} |
| Commit final | {{FINAL_COMMIT}} |
| Alcance | {{SCOPE}} |
| Aprobación (responsable de seguridad / coordinador) | PENDING |

## 2. Resumen ejecutivo

{{EXECUTIVE_SUMMARY}}

> **Importante.** Este informe no reemplaza un pentest formal, una auditoría externa
> ni la validación de infraestructura de producción. Es un insumo para que el
> responsable de seguridad y el coordinador tomen su propia decisión informada
> sobre el paso a producción.

## 3. Sobre el proyecto

{{PROJECT_IDENTIFICATION}}

## 4. Qué se revisó y metodología

{{ATTACK_SURFACE}}

- **Método de revisión**: comando nativo `/security-review` de Claude Code, en dos
  pasadas (inicial y final).
- **Ciclos de remediación ejecutados**: {{REMEDIATION_CYCLES}}.
- **Pruebas obligatorias**: {{TEST_SUMMARY}}.
- **Secretos y datos sensibles**: {{SECRETS_AND_DATA_CHECK}} (check
  `scripts/check-pr-rules.mjs --grupo secretos` y revisión manual).

## 5. Alcance y limitaciones

{{SCOPE_AND_LIMITATIONS}}

## 6. Resultado de la revisión final

{{FINAL_REVIEW}}

## 7. Hallazgos por severidad

| Severidad | Iniciales | Remediados | Abiertos |
|---|---:|---:|---:|
| Critical | {{INITIAL_CRITICAL}} | {{FIXED_CRITICAL}} | 0 |
| High | {{INITIAL_HIGH}} | {{FIXED_HIGH}} | 0 |
| Medium | {{INITIAL_MEDIUM}} | {{FIXED_MEDIUM}} | {{OPEN_MEDIUM}} |
| Low | {{INITIAL_LOW}} | {{FIXED_LOW}} | {{OPEN_LOW}} |
| Informativo | {{INITIAL_INFO}} | — | {{OPEN_INFO}} |

> Ningún hallazgo `Critical` o `High` queda abierto al cierre de esta auditoría.

## 8. Trazabilidad Critical/High

Registro técnico de cada hallazgo grave detectado y su remediación. No se elimina un
hallazgo de esta tabla por haber sido corregido — el historial de corrección es parte
de la evidencia.

| ID | Severidad | Activo afectado | Requisito del plan | Cambio aplicado | Prueba | Estado |
|---|---|---|---|---|---|---|
| {{ID}} | {{SEVERITY}} | {{AFFECTED_ASSET}} | {{PLAN_REF}} | {{CHANGE}} | {{TEST_REF}} | REMEDIATED |

> {{REMEDIATION_TRACEABILITY_NOTE}}

## 9. Evidencia de pruebas

| Comando | Propósito | Resultado | Evidencia |
|---|---|---|---|
| {{COMMAND}} | {{PURPOSE}} | PASSED | {{EVIDENCE}} |

## 10. Hallazgos Medium/Low/Info

{{REMAINING_FINDINGS}}

## 11. Riesgo residual y condiciones

{{RESIDUAL_RISK}}

## 12. Recomendación

{{RECOMMENDATION}}

## 13. Índice de evidencia

{{EVIDENCE_INDEX}}

## 14. Declaración de assurance

> En la revisión final automatizada no se identificaron hallazgos Critical o High
> dentro del alcance y las limitaciones declaradas. Este informe habilita la
> evaluación final del responsable de seguridad y del coordinador del proyecto,
> pero no sustituye un pentest formal, la validación de infraestructura de
> producción ni la aprobación corporativa de despliegue.

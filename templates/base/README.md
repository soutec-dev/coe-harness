# {{PROJECT_NAME}}

[Una línea: qué hace este proyecto.]

**Stack**: {{STACK}}
**Tipo**: {{PROJECT_TYPE}}
**Owner**: {{OWNER}}

## Setup

```bash
# [pasos para levantar el proyecto desde cero]
cp .env.example .env   # y completar los valores en local; .env nunca se commitea
```

## Estructura

```
src/          código
tests/        tests
scripts/      utilidades de desarrollo (check-pr-rules.mjs, tag-release.mjs)
docs/         documentación técnica
  decisions/        ADRs (si la skill adr-new está instalada)
  security/         informes de la auditoría de seguridad (skill security-audit)
CLAUDE.md     contexto y reglas para Claude Code
notes.md      scratchpad persistente
.datos-autorizados   datos de la organización cuya inclusión fue autorizada (lo edita el coordinador)
```

## Cómo se trabaja

- **Dos ramas**: `dev` (integración) y `main` (producción). Las ramas de trabajo
  nacen de `dev` y vuelven a `dev` por PR; `dev` → `main` es el release, también por
  PR. Nadie pushea a `main`.
- **Ninguna credencial ni dato sensible entra al repo.** `.env`, llaves, tokens,
  datos personales, nóminas, listados de clientes: nunca. El hook de la sesión y el
  check de CI deniegan el push que los subiría; la autorización para incluir datos
  de la organización la da el responsable de la información y queda registrada en
  `.datos-autorizados`.
- **Security review antes de cada PR** y **auditoría de seguridad
  (`security-audit`) antes de cada release** `dev` → `main`.

## Trabajar con Claude Code

Este repo tiene instalado **coe-harness**. Las skills viven en `.claude/skills/`,
versionadas junto al código, y se eligen al instalar con
`npx github:soutec-dev/coe-harness#v1` (`coe-github`, `datos-sensibles`,
`security-audit` y `security-report-standard` son obligatorias y siempre están).
No hay agentes ni flujos fijos: el modelo trabaja directo, con el flujo Git y las
reglas de secretos y seguridad como únicas reglas duras.

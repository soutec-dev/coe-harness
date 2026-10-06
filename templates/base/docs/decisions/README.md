# Architecture Decision Records (ADRs)

Decisiones arquitectónicas significativas con su rationale documentado.

## Naming

```
YYYYMMDD-slug-descriptivo.md
```

Ejemplos:
- `20260415-use-postgres-for-primary-db.md`
- `20260510-adopt-event-sourcing.md`
- `20260603-migrate-to-typescript.md`

## Crear uno

```
/adr-new usar postgres como base primaria
```

Genera el archivo con la fecha de hoy y el slug, desde `_template.md`, y te
entrevista por el Context y las Alternatives. El template vive en `_template.md`:
una sola fuente, compartida por el comando y por ti.

## Cuándo escribir un ADR

**SÍ**
- Elección de tecnología nueva (framework, DB, lenguaje)
- Cambio de paradigma arquitectónico
- Decisiones que afectan a múltiples componentes
- Trade-offs significativos con implicaciones futuras
- Decisiones que alguien del equipo probablemente cuestione en 6 meses

**NO**
- Cambios de implementación detallada
- Decisiones reversibles de bajo impacto
- Decisiones obvias que nadie discutiría

## Lifecycle

1. **Proposed** — draft en PR, en discusión
2. **Accepted** — mergeado a main, la decisión está vigente
3. **Deprecated** — no se recomienda, pero puede existir en código legacy
4. **Superseded** — una decisión posterior la reemplaza (link cruzado)

**Regla de oro**: los ADRs son inmutables una vez aceptados. Si una decisión cambia,
se crea un ADR nuevo que supersede al anterior. El original no se edita.

Un ADR no lleva credenciales ni datos de personas: si la decisión involucra
datos sensibles, descríbelos por su tipo, nunca por su valor.

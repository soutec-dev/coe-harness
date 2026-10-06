---
name: adr-new
description: Registra una decisión arquitectónica como ADR en docs/decisions/YYYYMMDD-<slug>.md, desde el template del proyecto, y te entrevista por el contexto y las alternativas descartadas.
argument-hint: <título de la decisión>
disable-model-invocation: true
---

# /adr-new

Título pedido: `$ARGUMENTS`

## Qué hacer

1. **Verifica que amerite un ADR.** Lee `docs/decisions/README.md`. Un ADR es para
   una decisión que alguien va a cuestionar en 6 meses: elección de tecnología,
   cambio de paradigma, trade-off con consecuencias. **No** para cambios de
   implementación ni decisiones reversibles de bajo impacto. Si no amerita, dilo.

2. **Deriva el nombre del archivo**: `docs/decisions/<YYYYMMDD>-<slug>.md`, con la
   fecha de hoy y el slug en kebab-case sacado de `$ARGUMENTS`.

3. **Copia `docs/decisions/_template.md`** — no reescribas el template de memoria,
   léelo del archivo. Es la fuente única, compartida con los humanos.

4. **Entrevista.** Las dos secciones que importan, y las dos que la gente saltea:

   - **Context** — la fuerza que motiva la decisión. Qué duele hoy. Qué restricciones
     hay. Sin esto, el ADR no sirve dentro de un año.
   - **Alternatives considered** — qué más se evaluó y **por qué se descartó**. Un
     ADR sin alternativas descartadas no es un ADR: es un anuncio.

   Después: Decision (clara, sin ambigüedad) y Consequences (positivas, negativas
   **y** neutras — si no hay ninguna negativa, no pensaste lo suficiente).

5. **Status inicial**: `proposed`. Pasa a `accepted` cuando se mergea.

6. **Sin datos sensibles**: un ADR describe la decisión, no copia credenciales,
   nombres de personas ni datos de la organización. Si la decisión los involucra,
   nómbralos por su tipo.

## Regla de oro

Los ADRs son **inmutables** una vez aceptados. Si la decisión cambia, se escribe un
ADR nuevo que supersede al anterior, con link cruzado. El original **no se edita**.

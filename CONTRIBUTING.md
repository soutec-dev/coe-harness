# Contribuir a coe-harness

> **English summary.** This repository is public so that anyone can read it, audit it
> and install it (`npx -y github:soutec-dev/coe-harness#v1 init`), under the
> Apache License 2.0. It is **not** open to external contributions: pull requests and
> issues from outside the SOUTEC organization are closed without review. Report
> security problems privately to the maintainers (see `MAINTAINERS.md`).

## Qué permite este repositorio

- **Leerlo y auditarlo.** Todo el código, las plantillas que instala y la evidencia de
  su auditoría de seguridad (`docs/security/`) están a la vista a propósito: quien
  adopte el harness tiene que poder ver qué hace antes de instalarlo.
- **Usarlo y adaptarlo.** La licencia Apache 2.0 (`LICENSE`, `NOTICE`) permite usar,
  copiar, modificar y redistribuir el harness, también en proyectos de otras
  empresas, con las condiciones de esa licencia (conservar los avisos de copyright y
  de licencia, indicar los cambios). Un fork es la vía para quien necesite una
  variante propia.

## Qué no permite

- **Contribuciones externas.** El desarrollo del harness lo lleva el equipo de la
  organización `soutec-dev`. Los pull requests y los issues abiertos por personas
  que no pertenecen a la organización se cierran sin revisión, y las interacciones
  externas (comentarios, issues, PRs) están limitadas a colaboradores del repo.
  Los canales de issues, wiki y discusiones están desactivados.
- **Acceso de escritura.** Solo los miembros de la organización con permiso en el
  repo pueden pushear ramas; `main` solo recibe merges desde `dev` por pull request,
  con el check `reglas-pr` en verde, también para administradores.

## Cómo se trabaja dentro de la organización

El flujo es el mismo que el harness instala en los proyectos que lo adoptan: rama
`tipo/slug` desde `dev`, commits `tipo: descripción` en español neutro, `/security-review`
antes de cada PR, PR a `dev` con la plantilla completa, y release `dev` → `main` por
PR con la skill `security-audit` en estado `READY`. El detalle operativo está en
`MAINTAINERS.md` y en `CLAUDE.md`.

## Problemas de seguridad

Si encuentras una vulnerabilidad en el harness o en lo que instala, **no la publiques
en un issue ni en un PR**: avisa en privado a los mantenedores (`MAINTAINERS.md`).
Las vulnerabilidades confirmadas se corrigen en `dev` y salen en un parche del tag
móvil `v1`, que los proyectos reciben con `coe-harness upgrade`.

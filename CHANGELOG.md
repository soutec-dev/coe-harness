# Changelog

Todas las versiones notables de `coe-harness`. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y el versionado,
[SemVer](https://semver.org/lang/es/).

## [1.0.0] — 2026-10-05

Primera versión. Harness de Claude Code para proyectos externos, derivado del motor
del harness interno de la organización pero sin ninguna dependencia de sus
herramientas (tablero, trackers, monitor, modos). Ver
`docs/decisions/20261005-coe-harness-para-proyectos-externos.md`.

### Agregado

- **CLI** `init` / `upgrade` / `status` / `adopt` / `verify`, con el mismo motor de
  plan + lockfile (un archivo del usuario nunca se pisa en silencio) y la protección
  de `main` en GitHub vía `gh api` (PR obligatorio, check `reglas-pr`, sin force-push).
- **Flujo Git simple** (skill `coe-github`): dos ramas `dev`/`main`, ramas
  `tipo/slug`, commits convencionales, PR con plantilla, squash & merge del
  coordinador, release `dev` → `main` con tags `vX.Y.Z` + `vX`.
- **Secretos y datos sensibles** (skill `datos-sensibles`, `.datos-autorizados`,
  sección "Datos sensibles" de la plantilla de PR): ninguna credencial ni dato de
  la organización entra al repo; los datos solo con autorización previa registrada
  por el usuario.
- **Hook `reglas-pr`** de Claude Code: antes de cada `git push` deniega el destino
  `main`/`master`, `--force`/`-f`/`+refspec`, `--all`/`--mirror`, y el grupo
  `secretos` sobre los commits que subirían; al crear o editar el PR corre los tres
  grupos y publica el resultado como comentario.
- **`check-pr-rules.mjs`** con escaneo de credenciales por nombre de archivo y por
  contenido (llaves privadas, tokens de AWS/GitHub/Slack/Google/Stripe/OpenAI,
  JWTs, URLs con credenciales, connection strings, `_authToken`, asignaciones de
  contraseña con filtro de placeholders) y heurísticas de datos personales y de
  nómina (documentos de identidad, IBAN/CBU, tarjetas con Luhn, listados de
  correos, nombres de archivo de nómina/clientes/volcados), con `.datos-autorizados`
  y `coe:no-secreto` como vías de excepción del usuario. Reglas nuevas de
  `pr-metadata`: `security-review-declarado` (y el estado de `security-audit` en
  los PRs a `main`) y `datos-sensibles-declarados`.
- **Auditoría de seguridad gateada** (skills `security-audit` y
  `security-report-standard`): `/security-review` nativo, remediación de
  Critical/High, re-review e informe Markdown en `docs/security/`, obligatoria
  antes de cada release.
- **Workflows**: `reglas-pr.yml` (los tres grupos en un solo job, check requerido)
  y `tag-release.yml` (solo repos Node).
- **`settings.json`** con deny de lectura de credenciales (repo y home), deny de
  push a `main` y de `gh pr merge/review`, `gh release` y `gh repo create/delete`.
- **Tests**: motor, CLI, checks, hook (contra repos git reales), tags,
  transferibilidad (ningún archivo emitido menciona herramientas internas) y
  dogfood (las copias locales son idénticas a las distribuidas).

[1.0.0]: https://github.com/soutecdev/coe-harness/releases/tag/v1.0.0

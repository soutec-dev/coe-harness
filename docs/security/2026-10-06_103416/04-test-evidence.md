# 04 — Evidencia de pruebas

Commit evaluado: `0939109` (rama `dev`, working tree limpio). Todas las pruebas se
corrieron en la máquina del ejecutor (Windows 11, Node v24.18.0, npm 11.16.0) el
2026-10-06, antes de la revisión final.

| Comando | Propósito | Resultado | Qué valida |
|---|---|---|---|
| `npm test` | Suite completa del generador: motor de plan/lockfile, CLI, checks de PR, hook (contra repos git reales), tags, transferibilidad, dogfood | **PASSED** — 135 tests, 135 pass, 0 fail | Regresión general. Cubre los controles de secretos y datos (`test/check-pr-rules.test.js`), la denegación de push a `main`, `--force` y `--all` y el aislamiento del script confiable (`test/hook-reglas-pr.test.js`), y la distinción de la limitación de plan Free (`test/unit.test.js`) |
| `node bin/cli.mjs verify --strict` | Integridad del manifest: huérfanos, rutas rotas, ids/dest duplicados, críticos faltantes | **PASSED** — "Manifest consistente: sin huerfanos, sin rutas rotas, sin duplicados, sin criticos faltantes" | Lo que se instala es exactamente lo declarado |
| `node scripts/check-pr-rules.mjs --grupo secretos` (diff `origin/main...HEAD`) | El propio check del harness sobre todo lo que entra al release: archivos de credenciales, secretos en el contenido, datos personales o de nómina | **PASSED** — `[OK] sin-secretos`, `[OK] sin-secretos-en-contenido`, `[OK] sin-datos-sensibles` | Ningún secreto ni dato de la organización en el release. Los fixtures de los tests están exentos por `coe:no-secreto (fixture)` y por `.datos-autorizados` |
| `npm audit --omit=dev` | Escaneo de dependencias de producción (`@clack/prompts@0.11.0`, `picocolors@1.1.1` y las transitivas `@clack/core@0.5.0`, `sisteransi@1.0.5`) | **PASSED** — found 0 vulnerabilities | Cadena de suministro de runtime |
| `node bin/cli.mjs upgrade --yes` (dogfood sobre este repo) | El CLI corre sobre un repo real y reaplica la branch protection de `main` en GitHub | **PASSED** — protección aplicada: PR obligatorio + check `reglas-pr`, sin force-push ni borrado, también para admins | Control de `main` del lado de GitHub |

## Notas

- No se instalaron herramientas nuevas para la auditoría (lint, SAST, escáneres
  externos): el proyecto no las tiene y la skill `security-audit` lo prohíbe "para
  decorar el reporte". La cobertura de análisis estático la aporta el
  `/security-review` nativo (archivos `01` y `05`).
- `npm test` tarda ~1,5 min porque los tests del hook y del script levantan repos
  git reales en directorios temporales con espacios en la ruta.
- Las pruebas de regresión específicas de hallazgos se agregan en
  `03-remediation-summary.md` si la fase de remediación aplica.

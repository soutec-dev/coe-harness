# 04 — Evidencia de pruebas

Las pruebas obligatorias se corrieron tres veces en la máquina del ejecutor (Windows 11,
Node v24.18.0, npm 11.16.0) el 2026-10-06: antes de la revisión final 1 (commit
`0939109`), tras el primer ciclo de remediación (`6776d09`) y tras el segundo ciclo
(**`3501be0`**, rama `dev`, working tree limpio), que es el commit que sustenta el
informe. La tabla recoge la última corrida; las anteriores quedan al final.

| Comando | Propósito | Resultado | Qué valida |
|---|---|---|---|
| `npm test` | Suite completa del generador: motor de plan/lockfile, CLI, checks de PR, hook (contra repos git reales con un `origin` bare), tags, transferibilidad, dogfood | **PASSED** — 158 tests, 158 pass, 0 fail, 0 skipped (139 s) | Regresión general y los controles de seguridad: secretos y datos (`test/check-pr-rules.test.js`, incluidos prefijos/camelCase, tope de línea, sombra `origin/dev`, evil merge); destino `main`, `--force`, `--all`/`:`, remotos, `-q`, comandos compuestos, variables de entorno, opciones abreviadas, varios push, presupuesto de tiempo y aislamiento del script confiable (`test/hook-reglas-pr.test.js`); fusión de branch protection, `sinProteccion`, `destSeguro`, espejo PowerShell (`test/unit.test.js`); traversal, `.GIT`, symlink y `dirs` (`test/migrate.test.js`, `test/verify.test.js`) |
| `node bin/cli.mjs verify --strict` | Integridad del manifest: huérfanos, rutas rotas, ids/dest duplicados, críticos faltantes, `dest` inseguros (incluido `manifest.dirs`) | **PASSED** — "Manifest consistente: sin huerfanos, sin rutas rotas, sin duplicados, sin criticos faltantes" | Lo que se instala es exactamente lo declarado |
| `node scripts/check-pr-rules.mjs --grupo secretos --sin-pushear` (sobre `d9c52d8`, `1930816` y `3501be0` antes de cada push) y `--grupo secretos` (diff `origin/main...HEAD`) | El propio check del harness sobre todo lo que entra al release: archivos de credenciales, secretos en el contenido, datos personales o de nómina, excepciones nuevas | **PASSED** — `[OK] sin-secretos`, `[OK] sin-secretos-en-contenido`, `[OK] sin-datos-sensibles`; `excepciones-nuevas` listó únicamente los dos marcadores `coe:no-secreto (fixture)` del test nuevo de claves con prefijo | Ningún secreto ni dato de la organización en el release. Los fixtures de los tests están exentos por `coe:no-secreto (fixture)` y por `.datos-autorizados` |
| `npm audit --omit=dev` | Escaneo de dependencias de producción (`@clack/prompts@0.11.0`, `picocolors@1.1.1` y las transitivas `@clack/core@0.5.0`, `sisteransi@1.0.5`, ahora fijadas en `npm-shrinkwrap.json`) | **PASSED** — found 0 vulnerabilities | Cadena de suministro de runtime |
| `node bin/cli.mjs upgrade --yes` (dogfood sobre este repo, tras cada cambio de plantilla) | El CLI corre sobre un repo real, regenera las copias managed y reaplica la branch protection en GitHub | **PASSED** — "Branch protection de main en soutec-dev/coe-harness: PR obligatorio + check reglas-pr en verde, sin force-push ni borrado (lo que ya estaba configurado se conservo)"; `dev` sin force-push ni borrado | Control de `main` del lado de GitHub y copias dogfood idénticas a las plantillas (lo exige el test de dogfood) |

## Corridas anteriores

| Commit | `npm test` | `verify --strict` | check secretos | `npm audit` |
|---|---|---|---|---|
| `0939109` (antes de la revisión final 1) | 135/135 | PASSED | PASSED | 0 vulnerabilidades |
| `6776d09` (tras el ciclo 1) | 149/149 | PASSED | PASSED | 0 vulnerabilidades |
| `d9c52d8` (ciclo 2, remediación principal) | 158/158 | PASSED | PASSED | 0 vulnerabilidades |
| `3501be0` (ciclo 2, cierre) | 158/158 | PASSED | PASSED | 0 vulnerabilidades |

## Notas

- No se instalaron herramientas nuevas para la auditoría (lint, SAST, escáneres
  externos): el proyecto no las tiene y la skill `security-audit` lo prohíbe "para
  decorar el reporte". La cobertura de análisis estático la aporta el
  `/security-review` nativo (archivos `01` y `05`), complementado con laboratorios
  reproducibles del revisor (repos git temporales, hook invocado por stdin).
- `npm test` tarda ~2,5 min porque los tests del hook y del script levantan repos
  git reales en directorios temporales con espacios en la ruta.
- Incidente de proceso registrado: el commit `1930816` entró con la copia dogfood
  del hook desfasada de su plantilla porque un `grep` en la cadena de comandos
  enmascaró el fallo del test de dogfood; `3501be0` lo corrige y la corrida completa
  de arriba es posterior. Lección: capturar el exit code del test antes de filtrar
  su salida.
- Las pruebas de regresión específicas de cada hallazgo están listadas en
  `03-remediation-summary.md` (ciclo 1 y ciclo 2).

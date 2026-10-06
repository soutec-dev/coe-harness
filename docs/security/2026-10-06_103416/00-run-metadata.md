# 00 — Metadata de la ejecución

Auditoría de seguridad previa al primer release `dev → main` (v1.0.0), exigida por la
skill `coe-github` ("Release") y ejecutada según el procedimiento de la skill
`security-audit` del propio repositorio.

| Campo | Valor |
|---|---|
| Fecha y hora local | 2026-10-06 10:34 (UTC-4) |
| Fecha y hora UTC | 2026-10-06T14:34:17Z |
| Proyecto / repositorio | coe-harness — https://github.com/soutec-dev/coe-harness |
| Alcance resuelto | `full`: todo el repositorio en la rama `dev`, comparada con `main` (que solo contiene el README inicial) |
| Rama | `dev` |
| Commit HEAD | `0939109` — fix: en repos privados de planes Free la falta de branch protection se explica, no se confunde con un permiso |
| Rama base | `main` = `fcc5349` (commit inicial, solo `README.md`) |
| Estado del working tree | limpio (`git status --short` sin salida) |
| Archivos relevantes | `src/` (motor y CLI), `bin/`, `templates/` (todo lo que se distribuye: hook, script de checks, settings, workflows, skills), las copias dogfood (`.claude/`, `scripts/`, `.github/`), `test/` |
| Versión de Claude Code | n/d (no se consulta sin instalar nada) |
| Node / npm / SO | v24.18.0 / 11.16.0 / Windows 11 |
| Método de revisión | `/security-review` nativo de Claude Code, delegado a un subagente que recibe la ruta del repositorio; dos pasadas (inicial y final) |
| Ejecutor | agente de Claude Code de la sesión del harness interno, en nombre de @ignacio |

## Limitaciones conocidas del ambiente

- La revisión corre desde otra sesión de Claude Code (la del harness interno), con
  este repositorio como carpeta hermana: el subagente recibe la ruta explícita. Si la
  skill nativa `security-review` no puede apuntar a esa carpeta, la revisión se hace
  manual con el mismo criterio y así queda registrado en
  `01-initial-security-review.md`.
- No hay entorno de producción ni servicios desplegados: el proyecto es un CLI y un
  conjunto de plantillas. La superficie de ataque son los comandos que ejecuta en la
  máquina del desarrollador (`git`, `gh`, `node`), lo que instala en otros
  repositorios (hook, settings, workflows) y la cadena de suministro (`npx` desde un
  tag móvil de GitHub).
- Las credenciales presentes en `test/` son fixtures falsos, marcados con
  `coe:no-secreto (fixture)`; en esta evidencia no se copia ningún valor.
- La skill `security-audit` de este repo no está cargada en la sesión que ejecuta la
  auditoría; su procedimiento se sigue a mano, fase por fase, y las fases quedan
  documentadas en los archivos `01`–`05` de esta carpeta.

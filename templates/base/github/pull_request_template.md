## Descripción del cambio
Explica brevemente qué se cambió y por qué.

## Tipo de cambio
- [ ] Nueva funcionalidad
- [ ] Corrección de error
- [ ] Hotfix producción
- [ ] Refactor
- [ ] Documentación
- [ ] Configuración / mantenimiento
- [ ] Experimento / POC

## Pruebas realizadas
- [ ] Ejecuté el proyecto en local
- [ ] Probé el flujo principal afectado
- [ ] Validé que el cambio no rompe funcionalidades existentes
- [ ] Actualicé documentación si aplica

## Evidencia
Adjuntar capturas, logs, resultados de prueba o explicación breve (con los valores sensibles redactados).

## Security review
- [ ] Corrí `/security-review` sobre este cambio antes de abrir el PR.
- Hallazgos: (ninguno / listar hallazgos y su severidad)
- Si hubo hallazgos: (remediados antes del PR / el responsable decidió continuar sin remediar y aceptó el riesgo)
- Solo en el PR de release `dev` → `main`: estado de `security-audit` (READY FOR REVIEW / READY WITH CONDITIONS) y ruta del informe en `docs/security/`.

## Datos sensibles
- [ ] Este PR **no** incluye credenciales ni datos personales o internos de la organización (código, tests, fixtures, docs, capturas).
- [ ] Este PR incluye datos de la organización **con autorización previa**, registrada en `.datos-autorizados`.
  - Autorizado por: <quién, rol> el <AAAA-MM-DD>
  - Alcance: <qué datos y para qué>

## Impacto / Riesgos
Indicar si afecta producción, usuarios, integraciones, APIs, datos o infraestructura.

## Requiere versión / release
- [ ] No
- [ ] Sí
Versión sugerida: vX.Y.Z

## Notas para despliegue
Indicar pasos especiales si aplica.

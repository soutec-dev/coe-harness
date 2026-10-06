# notes.md — coe-harness

Scratchpad persistente del proyecto. Lo que aprendiste y no quieres volver a
aprender: gotchas del stack, comandos que nunca te acuerdas, decisiones chicas que
no merecen un ADR, cosas que probaste y no funcionaron.

Lo que **no** va aquí: decisiones arquitectónicas (van en `docs/decisions/`),
convenciones del proyecto (van en `CLAUDE.md`) ni, por supuesto, credenciales o
datos de personas.

---

## Gotchas

- **El test de dogfood lista archivos con `git ls-files`**, no con el disco: en un
  clon fresco o tras agregar archivos a `.claude/`, hay que tenerlos en el índice
  (`git add`) para que el test los vea. Es a propósito: el manifest describe lo que
  se commitea.
- **Un binario en un diff no trae la línea `+++ b/<ruta>`**: solo
  `Binary files /dev/null and b/<ruta> differ`. `archivosDeDiff` saca la ruta de
  ahí; si algún día git cambia ese formato, el binario queda sin ruta y se
  descarta (sin escaneo de contenido, que para un binario no aporta).
- **`--sin-pushear` compara contra `--remotes=origin`**: en un repo sin remoto
  `origin` (o antes del primer push), todos los commits cuentan como "sin pushear"
  y el check los revisa enteros. No es un bug: es exactamente lo que subiría el
  primer push.
- **`git add` en Windows avisa "LF will be replaced by CRLF"** por `core.autocrlf`.
  Es inofensivo: el motor hashea con normalización LF y los tests de espejo
  comparan copias que pasan por el mismo filtro.
- **Los tests son fixtures del propio check**: llevan credenciales falsas (líneas
  marcadas con `coe:no-secreto (fixture)`) y documentos, tarjetas y correos
  sintéticos (`test/check-pr-rules.test.js` y `test/hook-reglas-pr.test.js` están
  en `.datos-autorizados`). Si agregas un fixture nuevo con esa pinta, el push lo
  va a denegar hasta que lo marques igual — es el harness aplicándose a sí mismo.
- **`npm test` tarda ~1.5 min**: los tests del hook y de `check-pr-rules` levantan
  repos git reales (con espacios en la ruta) y corren el script como subproceso.
  Para iterar sobre un archivo: `node --test test/check-pr-rules.test.js`.

## Comandos útiles

```bash
node bin/cli.mjs verify --strict            # manifest vs templates/
node bin/cli.mjs upgrade --yes              # refresca la copia dogfood tras tocar un template
node bin/cli.mjs init --dry-run --yes       # plan sin escribir, sobre cualquier repo
node scripts/check-pr-rules.mjs --grupo secretos --sin-pushear   # lo que denegaria el hook
node --test test/hook-reglas-pr.test.js     # un solo archivo de tests
```

## Descartado (y por qué)

- **Un "modo externo" dentro del harness interno** y **un repositorio plantilla**:
  ver `docs/decisions/20261005-coe-harness-para-proyectos-externos.md`.
- **`required_approving_review_count: 1` en la protección de `main`**: en un
  equipo de dos, el release que abre el propio coordinador queda trabado. Se deja
  en 0 con PR obligatorio y `enforce_admins`; equipos con más revisores lo suben
  en GitHub.
- **Detectar tarjetas de 13 dígitos sin separadores**: los timestamps en
  milisegundos pasan Luhn una de cada diez veces. Sin separadores solo cuentan 15
  y 16 dígitos que empiezan en 3–6.

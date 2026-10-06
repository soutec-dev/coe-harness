import { lt } from '../core/lockfile.js'

// Transforms mecanicos que el diff-por-hash no puede expresar: remover o
// renombrar claves, reemplazar una linea concreta en un archivo user-owned. El
// seed-merge solo AGREGA y un archivo editado por el usuario nunca se pisa, asi
// que sin una migracion un cambio de ese tipo solo llegaria al .new.
//
// Es un array de funciones chicas a proposito. Nada de un DSL de migraciones.
// Forma de cada entrada:
//   { id, to: '1.1.0', dest: 'CLAUDE.md', describe: '...', transform(content) {...} }
export const migrations = []

// Devuelve las migraciones aplicables a `dest` para pasar de `fromVersion` al
// harness actual. Una migracion aplica si el repo esta por debajo de su `to`.
export function migrationsFor(dest, fromVersion) {
  return migrations.filter((m) => m.dest === dest && lt(fromVersion, m.to))
}

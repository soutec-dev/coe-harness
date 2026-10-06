import path from 'node:path'
import { exists, listEntries, readIfExists } from './fsx.js'

// Senales de stack. Deciden que fragmento de .gitignore se concatena y si los
// entries con "when": "stack:<id>" (tag-release, atado a Node) se instalan.
export const SIGNATURES = [
  { stack: 'node', label: 'Node.js', files: ['package.json'] },
  { stack: 'python', label: 'Python', files: ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py'] },
  { stack: 'java', label: 'Java / JVM', files: ['pom.xml', 'build.gradle', 'build.gradle.kts'] },
  { stack: 'go', label: 'Go', files: ['go.mod'] },
  { stack: 'rust', label: 'Rust', files: ['Cargo.toml'] },
  { stack: 'dotnet', label: '.NET', files: ['global.json'], glob: /\.(csproj|sln|fsproj)$/i },
  { stack: 'php', label: 'PHP', files: ['composer.json'] },
  { stack: 'ruby', label: 'Ruby', files: ['Gemfile'] },
]

// Un repo se considera "greenfield" solo si lo unico que tiene son archivos de
// andamiaje de git/GitHub. Eso decide si emitimos src/, tests/, scripts/ y README:
// tirarle un src/.gitkeep a un repo Python que ya tiene su paquete, o a uno Java
// que tiene src/main/java, es exactamente el cambio no pedido que no queremos.
const SCAFFOLD_ONLY = new Set([
  '.git', '.github', '.gitignore', '.gitattributes',
  'README.md', 'readme.md', 'LICENSE', 'LICENSE.md', '.vscode', '.idea', '.DS_Store',
])

export function isEmptyRepo(cwd) {
  return listEntries(cwd).every((e) => SCAFFOLD_ONLY.has(e))
}

// "Este repo era greenfield" es una decision que se toma UNA VEZ, al instalar, y
// queda en el lockfile. Recalcularla en cada corrida es un bug: despues del primer
// init el repo ya tiene CLAUDE.md y src/, asi que dejaria de ser vacio y los archivos
// con `when: empty-repo` (README, .env.example) pasarian a verse como obsoletos.
export function resolveDetected(cwd, lock) {
  const detected = detect(cwd)
  return typeof lock?.greenfield === 'boolean' ? { ...detected, isEmpty: lock.greenfield } : detected
}

export function detect(cwd) {
  const entries = listEntries(cwd)
  const stacks = []

  for (const sig of SIGNATURES) {
    const byFile = sig.files.some((f) => exists(path.join(cwd, f)))
    const byGlob = sig.glob ? entries.some((e) => sig.glob.test(e)) : false
    if (byFile || byGlob) stacks.push(sig)
  }

  const packageManager = detectPackageManager(cwd)
  const projectName = detectProjectName(cwd) ?? path.basename(cwd)

  return {
    stacks: stacks.map((s) => s.stack),
    stackLabel: stacks.length ? stacks.map((s) => s.label).join(' + ') : 'por definir',
    packageManager,
    projectName,
    isEmpty: isEmptyRepo(cwd),
  }
}

function detectPackageManager(cwd) {
  if (exists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (exists(path.join(cwd, 'yarn.lock'))) return 'yarn'
  if (exists(path.join(cwd, 'package-lock.json'))) return 'npm'
  return null
}

function detectProjectName(cwd) {
  const pkg = readIfExists(path.join(cwd, 'package.json'))
  if (pkg) {
    try {
      const name = JSON.parse(pkg).name
      if (typeof name === 'string' && name) return name.replace(/^@[^/]+\//, '')
    } catch {
      // package.json roto: no es asunto nuestro, seguimos con el nombre del directorio.
    }
  }
  return null
}

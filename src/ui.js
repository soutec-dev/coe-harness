import * as p from '@clack/prompts'
import pc from 'picocolors'
import { CREATE, UPDATE, NOOP, CONFLICT, FOREIGN, RESTORE, LOCAL_EDIT, OBSOLETE, MIGRATE } from './core/plan.js'

export const isCI = () => process.env.CI === 'true' || process.env.CI === '1'

export function intro(text) {
  p.intro(pc.bgCyan(pc.black(` ${text} `)))
}

export function outro(text) {
  p.outro(text)
}

export const log = {
  info: (m) => p.log.info(m),
  warn: (m) => p.log.warn(pc.yellow(m)),
  error: (m) => p.log.error(pc.red(m)),
  success: (m) => p.log.success(pc.green(m)),
  step: (m) => p.log.step(m),
  message: (m) => p.log.message(m),
}

export function cancelled(message = 'Cancelado. No se escribio nada.') {
  p.cancel(message)
}

async function guard(value) {
  if (p.isCancel(value)) {
    cancelled()
    process.exit(130)
  }
  return value
}

export async function text({ message, initialValue, yes }) {
  if (yes) return initialValue
  return guard(await p.text({ message, initialValue, defaultValue: initialValue }))
}

export async function select({ message, options, initialValue, yes }) {
  if (yes) return initialValue ?? options[0].value
  return guard(await p.select({ message, options, initialValue }))
}

// Checkbox de opciones multiples. Con --yes o CI devuelve initialValues tal
// cual (el default es "todas marcadas", igual que las demas preguntas).
export async function multiselect({ message, options, initialValues = [], yes }) {
  if (yes) return initialValues
  return guard(await p.multiselect({ message, options, initialValues, required: false }))
}

export async function confirm({ message, initialValue = false, yes }) {
  if (yes) return initialValue
  return guard(await p.confirm({ message, initialValue }))
}

// P5: las acciones destructivas piden una segunda confirmacion explicita, y
// --yes NUNCA la implica. Hay que tipear la palabra.
export async function confirmDestructive({ message, word }) {
  if (isCI()) return false
  const answer = await guard(
    await p.text({ message: `${message}\n  Escribi ${pc.bold(word)} para confirmar (cualquier otra cosa cancela):` })
  )
  return String(answer).trim() === word
}

const VERDICT_STYLE = {
  [CREATE]: { label: 'crear', color: pc.green },
  [UPDATE]: { label: 'actualizar', color: pc.cyan },
  [RESTORE]: { label: 'restaurar', color: pc.cyan },
  [CONFLICT]: { label: 'conflicto -> .new', color: pc.yellow },
  [FOREIGN]: { label: 'ya existia -> .new', color: pc.yellow },
  [MIGRATE]: { label: 'migrar en el lugar', color: pc.cyan },
  [LOCAL_EDIT]: { label: 'editado por ti (se respeta)', color: pc.dim },
  [NOOP]: { label: 'sin cambios', color: pc.dim },
  [OBSOLETE]: { label: 'obsoleto', color: pc.magenta },
}

const ORDER = [CREATE, UPDATE, RESTORE, MIGRATE, CONFLICT, FOREIGN, OBSOLETE, LOCAL_EDIT, NOOP]

// Siempre se imprime el plan ANTES de tocar nada. Una sola confirmacion.
export function renderPlan(plan, { verbose = false } = {}) {
  const groups = {}
  for (const a of plan.actions) (groups[a.verdict] ??= []).push(a)

  const lines = []
  for (const verdict of ORDER) {
    const items = groups[verdict]
    if (!items?.length) continue
    const style = VERDICT_STYLE[verdict]
    const hideDetail = verdict === NOOP && !verbose

    lines.push(style.color(`${style.label} (${items.length})`))
    if (hideDetail) continue

    for (const a of items) {
      lines.push(`  ${pc.dim('·')} ${a.writePath && a.writePath !== a.dest ? `${a.dest} ${pc.dim('->')} ${a.writePath}` : a.dest}`)
      for (const r of a.reasons ?? []) lines.push(`      ${pc.dim(r)}`)
    }
  }

  if (!lines.length) lines.push(pc.dim('nada que hacer'))
  p.note(lines.join('\n'), 'Plan')
}

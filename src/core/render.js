// Sustitucion {{VAR}}. Deliberadamente no usamos Handlebars/EJS: el harness
// solo necesita reemplazo literal de variables, no logica en los templates.
export function render(template, vars) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  )
}

// Variables que un template pide y que no estan en `vars`. Se usa en los tests
// para que no se cuele un {{PLACEHOLDER}} sin resolver en el output.
export function missingVars(template, vars) {
  const found = new Set()
  for (const [, key] of template.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) found.add(key)
  }
  return [...found]
}

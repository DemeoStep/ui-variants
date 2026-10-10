// Pure functions of the ui-variants mod: no `$`, no side effects.

/** The skill name in the event: `ui-variants` or with the plugin prefix. */
export const SKILL_NAMES = ['ui-variants', 'ui-variants:ui-variants']

/** The skill line the mod reads arguments from ($ARGUMENTS already substituted). */
const ARGS_LINE = /^Show variants for:[ \t]*(.*)$/m

/** Skill arguments: the text after "Show variants for:", trimmed. */
export function parseArgs(text) {
  const found = ARGS_LINE.exec(text)
  return found === null ? '' : found[1].trim()
}

/** A top-level YAML block (`dependencies:` and so on): the lines up to the next key. */
export function yamlBlock(yaml, key) {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex(line => new RegExp(`^${key}:\\s*(#.*)?$`).test(line))
  if (start < 0) return ''
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith('#')) break
    body.push(line)
  }
  return body.join('\n')
}

/** Whether pubspec.yaml depends on `flutter: { sdk: flutter }`. */
export function isFlutterPubspec(yaml) {
  const deps = yamlBlock(yaml, 'dependencies')
  return /^\s+flutter:\s*\n\s+sdk:\s*['"]?flutter['"]?\s*(#.*)?$/m.test(deps) ||
    /^\s+flutter:\s*\{\s*sdk:\s*['"]?flutter['"]?\s*\}/m.test(deps)
}

/** The `name:` field of pubspec.yaml, or undefined. */
export function pubspecName(yaml) {
  const found = /^name:\s*['"]?([a-z_][a-z0-9_]*)['"]?\s*(#.*)?$/m.exec(yaml)
  return found === null ? undefined : found[1]
}

/** The `environment.sdk` constraint of pubspec.yaml as a string, or undefined. */
export function pubspecSdk(yaml) {
  const env = yamlBlock(yaml, 'environment')
  const found = /^\s+sdk:\s*(.+?)\s*(#.*)?$/m.exec(env)
  if (found === null) return undefined
  return found[1].replace(/^['"]|['"]$/g, '').trim()
}

/** An x.y.z version as an array of numbers (a pre-release is dropped). */
function versionParts(text) {
  const found = /^(\d+)\.(\d+)\.(\d+)/.exec(text)
  return found === null ? undefined : [Number(found[1]), Number(found[2]), Number(found[3])]
}

/** Compares x.y.z versions: -1, 0 or 1. */
export function compareVersions(a, b) {
  const left = versionParts(String(a)) ?? [0, 0, 0]
  const right = versionParts(String(b)) ?? [0, 0, 0]
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/** An SDK constraint as { min, max } (version strings; a missing bound is undefined). */
export function parseConstraint(text) {
  const value = String(text ?? '').trim()
  if (value === '' || value === 'any') return { min: undefined, max: undefined }
  const caret = /^\^(\d+\.\d+\.\d+\S*)$/.exec(value)
  if (caret !== null) {
    const [major, minor] = versionParts(caret[1])
    const max = major > 0 ? `${major + 1}.0.0` : `0.${minor + 1}.0`
    return { min: caret[1], max }
  }
  let min
  let max
  for (const token of value.split(/\s+/)) {
    const found = /^(>=|>|<=|<)(\d+\.\d+\.\d+\S*)$/.exec(token)
    if (found === null) return undefined
    if (found[1].startsWith('>')) min = found[2]
    else max = found[2]
  }
  return { min, max }
}

/**
 * The wider of two SDK constraints: the lower of the lower bounds and the higher
 * of the upper ones. If either does not parse, the project's constraint is used.
 */
export function widerSdk(host, project) {
  if (project === undefined) return host
  if (host === undefined) return project
  const a = parseConstraint(host)
  const b = parseConstraint(project)
  if (a === undefined || b === undefined) return project
  const min = a.min === undefined || b.min === undefined
    ? undefined
    : compareVersions(a.min, b.min) <= 0 ? a.min : b.min
  const max = a.max === undefined || b.max === undefined
    ? undefined
    : compareVersions(a.max, b.max) >= 0 ? a.max : b.max
  const parts = []
  if (min !== undefined) parts.push(`>=${min}`)
  if (max !== undefined) parts.push(`<${max}`)
  return parts.length === 0 ? 'any' : parts.join(' ')
}

/** A short hash of a string (FNV-1a, 32 bits, 8 hex digits). */
export function shortHash(text) {
  let hash = 0x811c9dc5
  for (const char of new TextEncoder().encode(text)) {
    hash ^= char
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** A string in YAML single quotes. */
export function yamlQuote(text) {
  return `'${String(text).replaceAll("'", "''")}'`
}

/** Fills values into {{NAME}} placeholders. */
export function fillPlaceholders(text, values) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole)
}

/** Turns App Sandbox off in an .entitlements file. */
export function withoutSandbox(plist) {
  return plist.replace(
    /(<key>com\.apple\.security\.app-sandbox<\/key>\s*)<true\s*\/>/,
    '$1<false/>',
  )
}

/** The decision from decision.json, or undefined if the JSON is broken or of the wrong shape. */
export function parseDecision(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const notes = Array.isArray(value.notes) ? value.notes.filter(isNote) : []
  const choices = Array.isArray(value.choices) ? value.choices.filter(isChoice).map(choice => ({
    group: typeof choice.group === 'string' ? choice.group : '',
    variantId: choice.variantId,
    title: typeof choice.title === 'string' ? choice.title : choice.variantId,
  })) : []
  const requests = Array.isArray(value.requests) ? value.requests.filter(isRequest).map(request => ({
    id: request.id,
    variantId: typeof request.variantId === 'string' ? request.variantId : '',
    title: typeof request.title === 'string' ? request.title : '',
    target: typeof request.target === 'string' ? request.target : '',
    text: request.text,
  })) : []
  return {
    round: typeof value.round === 'string' ? value.round : '',
    requests,
    feature: typeof value.feature === 'string' ? value.feature : '',
    chosen: typeof value.chosen === 'string' && value.chosen !== '' ? value.chosen : undefined,
    chosenTitle: typeof value.chosenTitle === 'string' ? value.chosenTitle : undefined,
    chosenAt: typeof value.chosenAt === 'string' ? value.chosenAt : '',
    choices,
    notes,
  }
}

function isRequest(request) {
  return request !== null && typeof request === 'object' &&
    typeof request.id === 'string' && typeof request.text === 'string'
}

function isChoice(choice) {
  return choice !== null && typeof choice === 'object' && typeof choice.variantId === 'string'
}

/** Choices per question: from choices, or a single chosen in the older decision format. */
export function decisionChoices(decision) {
  if (decision.choices.length > 0) return decision.choices
  return decision.chosen === undefined
    ? []
    : [{ group: '', variantId: decision.chosen, title: decision.chosenTitle ?? decision.chosen }]
}

function isNote(note) {
  return note !== null && typeof note === 'object' && typeof note.text === 'string'
}

/** The choice signature: changes on every press of Choose. */
export function choiceSignature(decision) {
  if (decision === undefined || decision.chosen === undefined) return undefined
  return `${decision.chosen}|${decision.chosenAt}`
}

/**
 * The send signature: the round, the choices and the notes. Pressing Choose
 * again on the same variant without new notes gives the same signature.
 */
export function sendSignature(decision) {
  if (decision === undefined || decision.chosen === undefined) return undefined
  const choices = decisionChoices(decision).map(choice => `${choice.group}=${choice.variantId}`).join(';')
  return `${decision.round}|${choices}|${notesSignature(decision)}`
}

/** The notes signature: their count and the time of the last one. */
export function notesSignature(decision) {
  if (decision === undefined || decision.notes.length === 0) return ''
  const last = decision.notes[decision.notes.length - 1]
  return `${decision.notes.length}|${last.at ?? ''}`
}

function clip(text, limit) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** One note line: "[variant → element] text". */
export function noteLine(note, limit = 160) {
  const where = [note.variantId, note.target].filter(part => typeof part === 'string' && part !== '')
  const head = where.length === 0 ? '' : `[${where.join(' → ')}] `
  return `${head}${clip(note.text, limit)}`
}

/** The text of the message that starts Claude's next turn. */
export function choicePrompt(decision, decisionPath) {
  const notes = decision.notes
  const shown = notes.slice(0, 6).map(note => noteLine(note)).join('; ')
  const more = notes.length > 6 ? `; and ${notes.length - 6} more` : ''
  const comments = notes.length === 0 ? 'none' : `${shown}${more}`
  const feature = decision.feature === '' ? 'the current task' : `"${decision.feature}"`
  const choices = decisionChoices(decision)
  if (choices.length > 1) {
    const list = choices.map(choice => `${choice.group} — ${choice.variantId}`).join('; ')
    return `Chosen variants for ${feature}: ${list}. ` +
      `Notes: ${comments}. Full details: ${decisionPath}. ` +
      'Implement the chosen variants in the project.'
  }
  return `Chosen variant ${decision.chosen} for ${feature}. ` +
    `Notes: ${comments}. Full details: ${decisionPath}. ` +
    'Implement the chosen variant in the project.'
}

/** The last non-empty line of a command's output (a short failure reason). */
export function lastLine(text, limit = 200) {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.length === 0 ? '' : clip(lines[lines.length - 1], limit)
}

/** The first error line in flutter output (compile, build). */
export function flutterError(text, limit = 200) {
  const lines = String(text ?? '').split(/\r?\n/)
  const found = lines.find(line =>
    /(^|\s)Error:|error:|Compilation failed|Hot restart failed|Restart failed|Exception:|Could not build|Build failed/i.test(line))
  return found === undefined ? undefined : clip(found, limit)
}

/**
 * The message with variant revisions from the window: Claude changes only those
 * variants, the window refreshes by itself, no choice has been made yet.
 */
export function revisionPrompt(requests, variantsDir) {
  const line = request => {
    const name = request.title === '' ? request.variantId : `${request.variantId} ("${request.title}")`
    const where = request.target === '' ? '' : `, element "${clip(request.target, 80)}"`
    return `${name}${where}: ${clip(request.text, 400)}`
  }
  const head = requests.length === 1
    ? `Variant revision from the picker window — ${line(requests[0])}.`
    : `Variant revisions from the picker window: ${requests.map((request, i) => `${i + 1}) ${line(request)}`).join('; ')}.`
  return `${head} Change only ${requests.length === 1 ? 'this variant' : 'these variants'} in ${variantsDir}: ` +
    'keep the id, the class and the registration, and do not touch the project. No choice has been made yet: after the revision reply briefly and end the turn, the window refreshes by itself.'
}

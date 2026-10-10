// Чистые функции мода ui-variants: без `$`, без побочных эффектов.

/** Имя скилла в событии: `ui-variants` или с префиксом плагина. */
export const SKILL_NAMES = ['ui-variants', 'ui-variants:ui-variants']

/** Строка скилла, из которой мод читает аргументы ($ARGUMENTS уже подставлен). */
const ARGS_LINE = /^Покажи варианты для:[ \t]*(.*)$/m

/** Аргументы скилла: текст после «Покажи варианты для:», без пробелов по краям. */
export function parseArgs(text) {
  const found = ARGS_LINE.exec(text)
  return found === null ? '' : found[1].trim()
}

/** Блок верхнего уровня YAML (`dependencies:` и т. п.): строки до следующего ключа. */
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

/** Есть ли в pubspec.yaml зависимость `flutter: { sdk: flutter }`. */
export function isFlutterPubspec(yaml) {
  const deps = yamlBlock(yaml, 'dependencies')
  return /^\s+flutter:\s*\n\s+sdk:\s*['"]?flutter['"]?\s*(#.*)?$/m.test(deps) ||
    /^\s+flutter:\s*\{\s*sdk:\s*['"]?flutter['"]?\s*\}/m.test(deps)
}

/** Поле `name:` из pubspec.yaml или undefined. */
export function pubspecName(yaml) {
  const found = /^name:\s*['"]?([a-z_][a-z0-9_]*)['"]?\s*(#.*)?$/m.exec(yaml)
  return found === null ? undefined : found[1]
}

/** Ограничение `environment.sdk` из pubspec.yaml как строка или undefined. */
export function pubspecSdk(yaml) {
  const env = yamlBlock(yaml, 'environment')
  const found = /^\s+sdk:\s*(.+?)\s*(#.*)?$/m.exec(env)
  if (found === null) return undefined
  return found[1].replace(/^['"]|['"]$/g, '').trim()
}

/** Версия x.y.z как массив чисел (пререлиз отбрасывается). */
function versionParts(text) {
  const found = /^(\d+)\.(\d+)\.(\d+)/.exec(text)
  return found === null ? undefined : [Number(found[1]), Number(found[2]), Number(found[3])]
}

/** Сравнение версий x.y.z: -1, 0 или 1. */
export function compareVersions(a, b) {
  const left = versionParts(String(a)) ?? [0, 0, 0]
  const right = versionParts(String(b)) ?? [0, 0, 0]
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/** Ограничение SDK как { min, max } (строки версий; отсутствие границы — undefined). */
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
 * Более широкое из двух ограничений SDK: нижняя граница — меньшая, верхняя —
 * большая. Если одно не разобрано, берётся ограничение проекта как есть.
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

/** Короткий хеш строки (FNV-1a, 32 бита, 8 шестнадцатеричных знаков). */
export function shortHash(text) {
  let hash = 0x811c9dc5
  for (const char of new TextEncoder().encode(text)) {
    hash ^= char
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Строка в одинарных кавычках YAML. */
export function yamlQuote(text) {
  return `'${String(text).replaceAll("'", "''")}'`
}

/** Подставляет значения в {{ИМЯ}}. */
export function fillPlaceholders(text, values) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole)
}

/** Отключает App Sandbox в тексте .entitlements. */
export function withoutSandbox(plist) {
  return plist.replace(
    /(<key>com\.apple\.security\.app-sandbox<\/key>\s*)<true\s*\/>/,
    '$1<false/>',
  )
}

/** Решение из decision.json или undefined, если JSON битый или не того вида. */
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

/** Выборы по вопросам: из choices, а у старого вида решения — один chosen. */
export function decisionChoices(decision) {
  if (decision.choices.length > 0) return decision.choices
  return decision.chosen === undefined
    ? []
    : [{ group: '', variantId: decision.chosen, title: decision.chosenTitle ?? decision.chosen }]
}

function isNote(note) {
  return note !== null && typeof note === 'object' && typeof note.text === 'string'
}

/** Подпись выбора: меняется при каждом нажатии «Выбрать». */
export function choiceSignature(decision) {
  if (decision === undefined || decision.chosen === undefined) return undefined
  return `${decision.chosen}|${decision.chosenAt}`
}

/**
 * Подпись отправки: показ, вариант и комментарии. Повторное нажатие «Выбрать»
 * на том же варианте без новых комментариев даёт ту же подпись.
 */
export function sendSignature(decision) {
  if (decision === undefined || decision.chosen === undefined) return undefined
  const choices = decisionChoices(decision).map(choice => `${choice.group}=${choice.variantId}`).join(';')
  return `${decision.round}|${choices}|${notesSignature(decision)}`
}

/** Подпись комментариев: число и время последнего. */
export function notesSignature(decision) {
  if (decision === undefined || decision.notes.length === 0) return ''
  const last = decision.notes[decision.notes.length - 1]
  return `${decision.notes.length}|${last.at ?? ''}`
}

function clip(text, limit) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** Одна строка комментария: «[вариант → элемент] текст». */
export function noteLine(note, limit = 160) {
  const where = [note.variantId, note.target].filter(part => typeof part === 'string' && part !== '')
  const head = where.length === 0 ? '' : `[${where.join(' → ')}] `
  return `${head}${clip(note.text, limit)}`
}

/** Текст сообщения, которое запускает следующий ход Claude. */
export function choicePrompt(decision, decisionPath) {
  const notes = decision.notes
  const shown = notes.slice(0, 6).map(note => noteLine(note)).join('; ')
  const more = notes.length > 6 ? `; и ещё ${notes.length - 6}` : ''
  const comments = notes.length === 0 ? 'нет' : `${shown}${more}`
  const feature = decision.feature === '' ? 'текущей задачи' : `«${decision.feature}»`
  const choices = decisionChoices(decision)
  if (choices.length > 1) {
    const list = choices.map(choice => `${choice.group} — ${choice.variantId}`).join('; ')
    return `Выбраны варианты для фичи ${feature}: ${list}. ` +
      `Комментарии: ${comments}. Полностью: ${decisionPath}. ` +
      'Реализуй выбранные варианты в проекте.'
  }
  return `Выбран вариант ${decision.chosen} для фичи ${feature}. ` +
    `Комментарии: ${comments}. Полностью: ${decisionPath}. ` +
    'Реализуй выбранный вариант в проекте.'
}

/** Последняя содержательная строка вывода команды (для краткой причины ошибки). */
export function lastLine(text, limit = 200) {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.length === 0 ? '' : clip(lines[lines.length - 1], limit)
}

/** Первая строка с ошибкой в выводе flutter (компиляция, сборка). */
export function flutterError(text, limit = 200) {
  const lines = String(text ?? '').split(/\r?\n/)
  const found = lines.find(line =>
    /(^|\s)Error:|error:|Compilation failed|Hot restart failed|Restart failed|Exception:|Could not build|Build failed/i.test(line))
  return found === undefined ? undefined : clip(found, limit)
}

/**
 * Текст сообщения с правками вариантов из окна: Claude меняет только эти
 * варианты, окно обновляется само, выбор ещё не сделан.
 */
export function revisionPrompt(requests, variantsDir) {
  const line = request => {
    const name = request.title === '' ? request.variantId : `${request.variantId} («${request.title}»)`
    const where = request.target === '' ? '' : `, элемент «${clip(request.target, 80)}»`
    return `${name}${where}: ${clip(request.text, 400)}`
  }
  const head = requests.length === 1
    ? `Правка варианта из окна-пикера — ${line(requests[0])}.`
    : `Правки вариантов из окна-пикера: ${requests.map((request, i) => `${i + 1}) ${line(request)}`).join('; ')}.`
  return `${head} Измени только ${requests.length === 1 ? 'этот вариант' : 'эти варианты'} в ${variantsDir}: ` +
    'id, класс и регистрацию сохрани, проект не трогай. Выбор ещё не сделан — после правки кратко ответь и заверши ход, окно обновится само.'
}

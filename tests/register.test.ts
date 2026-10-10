// Тесты мода ui-variants: файловая система, процессы, хранилище и часы —
// заглушки в памяти, мод загружен движком из папки плагина.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PROJECT = '/work/demo_app'
const HOME = '/Users/tester'
const FLUTTER = '/sdk/flutter/bin/flutter'
const CACHE = `${HOME}/Library/Caches/ui-variants/`

const FLUTTER_PUBSPEC = [
  'name: demo_app',
  'description: Демо',
  'environment:',
  "  sdk: '>=3.4.0 <4.0.0'",
  '',
  'dependencies:',
  '  flutter:',
  '    sdk: flutter',
  '  cupertino_icons: ^1.0.8',
  '',
].join('\n')

const DART_PUBSPEC = 'name: cli_tool\nenvironment:\n  sdk: ^3.5.0\ndependencies:\n  args: ^2.0.0\n'

const SKILL_TEXT = [
  'Покажи варианты для: ARGS',
  'Варианты: {{VARIANTS_DIR}}',
  'Реестр: {{REGISTRY}}',
  'Тема: {{THEME}}',
  'Решение: {{DECISION}}',
  'Пакет: package:{{PACKAGE}}/',
  'Проверка: {{APP_DIR}}',
].join('\n')

const TEMPLATES: Record<string, string> = {
  'pubspec.yaml.tmpl':
    'name: ui_variants_host\nenvironment:\n  sdk: {{SDK}}\ndependencies:\n  flutter:\n    sdk: flutter\n  {{PACKAGE}}:\n    path: {{PROJECT_ROOT}}\n{{DEVICE_FRAME}}\n',
  'lib/_host/frames.dart': '// рамки device_frame',
  'fallback/frames.dart': '// встроенные рамки',
  'analysis_options.yaml': 'analyzer:\n',
  'lib/main.dart': '// окно-пикер',
  'lib/registry.dart': '// реестр по умолчанию',
  'lib/theme.dart': '// тема по умолчанию',
  'lib/_host/version.dart.tmpl': "const String hostTemplateVersion = '{{VERSION}}';",
  'macos/Runner/MainFlutterWindow.swift.tmpl': 'title = "Варианты UI — {{PACKAGE}}"',
}

const SANDBOXED = '<dict>\n\t<key>com.apple.security.app-sandbox</key>\n\t<true/>\n</dict>'

type File = { text: string; mtimeMs: number }

type World = {
  files: Map<string, File>
  writes: string[]
  runs: { argv: string[]; cwd?: string }[]
  spawns: { argv: string[]; cwd?: string; env?: Record<string, string> }[]
  toasts: string[]
  prompts: string[]
  alive: Set<number>
  signals: string[]
  failPubGet: boolean
  failFrames: boolean
  write: (path: string, text: string) => void
  appDir: () => string | undefined
}

function templatePath(path: string): string | undefined {
  const found = /\/templates(?:\/(.*))?$/.exec(path)
  return found === null ? undefined : (found[1] ?? '')
}

function listTemplates(rel: string) {
  const prefix = rel === '' ? '' : `${rel}/`
  const names = new Map<string, 'file' | 'dir'>()
  for (const key of Object.keys(TEMPLATES)) {
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash < 0) names.set(rest, 'file')
    else names.set(rest.slice(0, slash), 'dir')
  }
  return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
}

function setup(on: On, options: { pubspec?: string; store?: Record<string, unknown> } = {}): World {
  let stamp = 1000
  const world: World = {
    files: new Map(),
    writes: [],
    runs: [],
    spawns: [],
    toasts: [],
    prompts: [],
    alive: new Set(),
    signals: [],
    failPubGet: false,
    failFrames: false,
    write: (path, text) => {
      stamp += 1
      world.files.set(path, { text, mtimeMs: stamp })
    },
    appDir: () => {
      for (const path of world.files.keys()) {
        const found = /^(.*\/ui-variants\/[^/]+)\/macos\//.exec(path)
        if (found !== null && found[1].startsWith(CACHE)) return found[1]
      }
      return undefined
    },
  }
  if (options.pubspec !== undefined) world.write(`${PROJECT}/pubspec.yaml`, options.pubspec)

  mock.env(on, { HOME, SHELL: '/bin/zsh' })
  mock.store(on, options.store)
  on('session.root', () => ({ value: PROJECT }))
  on('session.id', () => ({ value: 'session-1' }))

  on('fs.exists', ($, e) => {
    const rel = templatePath(e.path)
    if (rel !== undefined) return { value: rel === '' || rel in TEMPLATES }
    const isDir = [...world.files.keys()].some(path => path.startsWith(`${e.path}/`))
    return { value: world.files.has(e.path) || isDir }
  })
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version":"0.1.0"}' }
    const rel = templatePath(e.path)
    if (rel !== undefined && rel in TEMPLATES) return { value: TEMPLATES[rel] }
    const file = world.files.get(e.path)
    return file === undefined ? { deny: `ENOENT ${e.path}` } : { value: file.text }
  })
  on('fs.write', ($, e) => {
    world.writes.push(e.path)
    world.write(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const file = world.files.get(e.path)
    if (file === undefined) return { deny: `ENOENT ${e.path}` }
    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.list', ($, e) => {
    const rel = templatePath(e.path)
    if (rel !== undefined) return { value: listTemplates(rel) }
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [path, file] of world.files) {
      if (!path.startsWith(`${e.path}/`)) continue
      const rest = path.slice(e.path.length + 1)
      const slash = rest.indexOf('/')
      if (slash < 0) entries.set(rest, { name: rest, kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false })
      else entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    }
    return entries.size === 0 ? { deny: `ENOENT ${e.path}` } : { value: [...entries.values()] }
  })

  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const cwd = e.init?.cwd
    world.runs.push({ argv, cwd })
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    const fail = (stderr = '') => ({ value: { exitCode: 1, stdout: '', stderr } })
    if (argv[0] === '/usr/bin/which') return ok(`${FLUTTER}\n`)
    if (argv[0] === FLUTTER && argv[1] === 'create') {
      const dir = argv[argv.length - 1]
      world.write(`${dir}/macos/Runner.xcodeproj/project.pbxproj`, '// xcode')
      world.write(`${dir}/pubspec.yaml`, 'name: ui_variants_host\nenvironment:\n  sdk: ^3.13.5\n')
      world.write(`${dir}/lib/main.dart`, '// MyApp')
      world.write(`${dir}/macos/Runner/DebugProfile.entitlements`, SANDBOXED)
      world.write(`${dir}/macos/Runner/Release.entitlements`, SANDBOXED)
      return ok()
    }
    if (argv[0] === FLUTTER && argv[1] === 'pub') {
      const hostPubspec = world.files.get(`${cwd}/pubspec.yaml`)?.text ?? ''
      if (world.failFrames && hostPubspec.includes('device_frame')) {
        return { value: { exitCode: 1, stdout: '', stderr: 'Because demo_app depends on freezed_annotation ^2.4.0 and device_frame >=1.2.0 depends on freezed_annotation ^3.0.0, version solving failed.' } }
      }
      if (world.failPubGet) {
        return { value: { exitCode: 1, stdout: '', stderr: 'Because demo_app requires SDK version >=9.0.0, version solving failed.' } }
      }
      world.write(`${cwd}/.dart_tool/package_config.json`, '{}')
      return ok()
    }
    if (argv[0] === 'kill') {
      const pid = Number(argv[2])
      world.signals.push(`${argv[1]} ${pid}`)
      if (!world.alive.has(pid)) return fail()
      if (argv[1] === '-TERM') world.alive.delete(pid)
      return ok()
    }
    if (argv[0] === 'ps') {
      const command = `dart flutter_tools.snapshot run -d macos --pid-file ${world.appDir()}/.state/flutter.pid\n`
      return world.alive.has(Number(argv[2])) ? ok(command) : fail()
    }
    if (argv[0] === '/bin/sh' && argv[2].includes('UIV_PIDS')) {
      // Быстрое закрытие окна: сигнал живым flutter run и pkill приложения.
      let found = 0
      for (const pid of (e.init?.env?.UIV_PIDS ?? '').split(' ').filter(Boolean).map(Number)) {
        if (!world.alive.has(pid)) continue
        world.signals.push(`-TERM ${pid}`)
        world.alive.delete(pid)
        found = 1
      }
      world.signals.push(`pkill ${e.init?.env?.UIV_APP_BUNDLE}`)
      return ok(`${found}\n`)
    }
    if (argv[0] === 'rm') {
      for (const target of argv.slice(2)) {
        const full = target.startsWith('/') ? target : `${cwd}/${target}`
        for (const path of [...world.files.keys()]) {
          if (path === full || path.startsWith(`${full}/`)) world.files.delete(path)
        }
      }
      return ok()
    }
    return ok()
  })
  on('process.spawn', async function* ($, e) {
    world.spawns.push({ argv: [...e.argv], cwd: e.cwd, env: e.env })
    world.alive.add(4242)
    yield { stream: 'stdout' as const, text: '4242\n' }
    return { value: { code: 0, signal: null } }
  })

  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    world.prompts.push(e.text)
    return { text: e.text }
  })
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  return world
}

const TURN = { answer: 'Готово', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' as const }

function expectNothingInProject(world: World) {
  for (const path of world.writes) expect(path.startsWith(`${PROJECT}/`)).toBe(false)
  for (const path of world.writes) expect(path.startsWith(CACHE)).toBe(true)
  for (const run of world.runs) {
    if (run.argv[0] === 'rm') {
      const targets = run.argv.slice(2).map(target => (target.startsWith('/') ? target : `${run.cwd}/${target}`))
      for (const target of targets) expect(target.startsWith(CACHE)).toBe(true)
    }
  }
}

test('до загрузки скилла хуки ничего не делают', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: `${CACHE}demo_app-x/lib/registry.dart`, content: '' })
  await $.tool.call({ tool: 'Edit', file_path: `${PROJECT}/lib/main.dart`, old_string: 'a', new_string: 'b' })
  await $.turn.complete(TURN)
  await clock.advance(10_000)
  await $.skill.prompt({ skill: 'other-skill', text: 'Покажи варианты для: x' })
  expect(world.writes).toEqual([])
  expect(world.runs).toEqual([])
  expect(world.spawns).toEqual([])
  expect(world.toasts).toEqual([])
  expect(world.prompts).toEqual([])
})

test('в не-Flutter проекте скилл возвращает короткий отказ', async ($, on) => {
  const world = setup(on, { pubspec: DART_PUBSPEC })
  mock.clock(on)
  const answer = await $.skill.prompt({ skill: 'ui-variants:ui-variants', text: SKILL_TEXT })
  expect(answer.text).toBe('Это не Flutter-проект, окно-пикер здесь не работает. Опиши варианты текстом.')
  expect(world.writes).toEqual([])
  expect(world.runs).toEqual([])
})

test('без pubspec.yaml скилл тоже отказывает', async ($, on) => {
  const world = setup(on)
  mock.clock(on)
  const answer = await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  expect(answer.text).toMatch(/^Это не Flutter-проект/)
  expect(world.writes).toEqual([])
})

test('загрузка скилла создаёт приложение-пикер и подставляет пути', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  mock.clock(on, { now: 1_700_000_000_000 })
  const answer = await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT.replace('ARGS', 'экран входа') })
  const appDir = world.appDir()
  expect(appDir).toBeDefined()
  expect(appDir).toMatch(/\/Library\/Caches\/ui-variants\/demo_app-[0-9a-f]{8}$/)
  expect(answer.text).toContain('Покажи варианты для: экран входа')
  expect(answer.text).toContain(`Варианты: ${appDir}/lib/variants`)
  expect(answer.text).toContain(`Реестр: ${appDir}/lib/registry.dart`)
  expect(answer.text).toContain(`Тема: ${appDir}/lib/theme.dart`)
  expect(answer.text).toContain(`Решение: ${appDir}/.state/decision.json`)
  expect(answer.text).toContain('Пакет: package:demo_app/')
  expect(answer.text).not.toContain('{{')
  const create = world.runs.find(run => run.argv[1] === 'create')
  expect(create?.argv).toEqual([FLUTTER, 'create', '--platforms=macos', '--project-name', 'ui_variants_host',
    '--org', 'dev.uivariants', '--no-pub', appDir])
  const pubspec = world.files.get(`${appDir}/pubspec.yaml`)?.text ?? ''
  expect(pubspec).toContain("path: '/work/demo_app'")
  expect(pubspec).toContain("sdk: '>=3.4.0 <4.0.0'")
  expect(world.files.get(`${appDir}/lib/main.dart`)?.text).toBe('// окно-пикер')
  expect(world.files.get(`${appDir}/lib/_host/version.dart`)?.text).toContain("'0.1.0'")
  expect(world.files.get(`${appDir}/macos/Runner/MainFlutterWindow.swift`)?.text).toContain('demo_app')
  expect(world.files.get(`${appDir}/macos/Runner/DebugProfile.entitlements`)?.text).toContain('<false/>')
  expect(world.files.get(`${appDir}/macos/Runner/Release.entitlements`)?.text).toContain('<false/>')
  expect(world.runs.some(run => run.argv[1] === 'pub' && run.cwd === appDir)).toBe(true)
  expect(world.toasts).toEqual([])
  expect(world.prompts).toEqual([])
  expectNothingInProject(world)
})

test('обновление шаблонов не трогает реестр, тему и варианты', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  mock.clock(on)
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  world.write(`${appDir}/lib/registry.dart`, '// реестр Claude')
  world.write(`${appDir}/lib/theme.dart`, '// тема проекта')
  world.files.delete(`${appDir}/lib/_host/version.dart`)
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  expect(world.files.get(`${appDir}/lib/registry.dart`)?.text).toBe('// реестр Claude')
  expect(world.files.get(`${appDir}/lib/theme.dart`)?.text).toBe('// тема проекта')
  expect(world.files.get(`${appDir}/lib/_host/version.dart`)?.text).toContain('0.1.0')
  expect(world.runs.filter(run => run.argv[1] === 'create').length).toBe(1)
})

test('сбой pub get добавляет причину и просьбу описать варианты текстом', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  mock.clock(on)
  world.failPubGet = true
  const answer = await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  expect(answer.text).toContain('окно-пикер сейчас недоступно')
  expect(answer.text).toContain('version solving failed')
  expect(answer.text).toContain('опиши варианты текстом')
  // Мод не активировался: запись реестра не открывает окно.
  await $.tool.call({ tool: 'Write', file_path: `${world.appDir()}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  expect(world.spawns).toEqual([])
})

test('запись в registry.dart и конец хода открывают окно, следующий раз — hot restart', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''

  // Запись не в пикер — окно не открывается.
  await $.tool.call({ tool: 'Write', file_path: `${PROJECT}/lib/main.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.spawns).toEqual([])

  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/variants/login_a.dart`, content: '' })
  await $.tool.call({ tool: 'Edit', file_path: `${appDir}/lib/registry.dart`, old_string: 'a', new_string: 'b' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.spawns.length).toBe(1)
  const spawn = world.spawns[0]
  expect(spawn.cwd).toBe(appDir)
  expect(spawn.argv[0]).toBe('/bin/sh')
  expect(spawn.argv[2]).toContain('run -d macos --pid-file')
  expect(spawn.env?.UIV_FLUTTER).toBe(FLUTTER)
  expect(spawn.env?.UIV_STATE).toBe(`${appDir}/.state`)
  expect(spawn.env?.UIV_APP_BUNDLE).toBe(`${appDir}/build/macos/Build/Products/Debug/ui_variants_host.app`)
  expect(spawn.argv[2]).toContain('pkill -f "$UIV_APP_BUNDLE"')
  expect(world.toasts).toContain('Окно с вариантами открывается…')

  // flutter run записал pid-файл: окно открыто.
  world.write(`${appDir}/.state/flutter.pid`, '4242')
  await clock.advance(2000)
  expect(world.toasts).toContain('Окно с вариантами открыто')

  // Новые варианты: горячий перезапуск того же процесса.
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.signals).toContain('-USR2 4242')
  expect(world.spawns.length).toBe(1)
  expect(world.toasts).toContain('Окно с вариантами обновлено')
  expectNothingInProject(world)
})

test('новый выбор: toast и ровно один prompt.submit, повтор — ни одного', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  const path = `${appDir}/.state/decision.json`

  // Битый JSON — тик пропускается.
  world.write(path, '{"chosen": ')
  await clock.advance(2000)
  expect(world.toasts).toEqual([])

  // Комментарий без выбора — только toast.
  const note = { variantId: 'login-a', target: 'кнопка входа', text: 'крупнее', at: '2026-10-10T10:00:00Z' }
  world.write(path, JSON.stringify({ feature: 'Экран входа', chosen: null, notes: [note] }))
  await clock.advance(2000)
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toContain('крупнее')
  expect(world.prompts).toEqual([])

  const chosen = {
    round: 'round-1',
    feature: 'Экран входа',
    chosen: 'login-b',
    chosenTitle: 'Компактный',
    chosenAt: '2026-10-10T10:01:00Z',
    notes: [note],
  }
  world.write(path, JSON.stringify(chosen))
  await clock.advance(2000)
  expect(world.toasts).toContain('Выбран вариант: Компактный')
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('Выбран вариант login-b для фичи «Экран входа»')
  expect(world.prompts[0]).toContain('[login-a → кнопка входа] крупнее')
  expect(world.prompts[0]).toContain(path)
  expect(world.prompts[0]).toContain('Реализуй выбранный вариант в проекте')
  // Окно получает подтверждение.
  const ack = JSON.parse(world.files.get(`${appDir}/.state/ack.json`)?.text ?? '{}')
  expect(ack).toMatchObject({ chosenAt: chosen.chosenAt, status: 'sent' })

  // Тот же выбор, файл переписан — повтор не отправляется.
  world.write(path, JSON.stringify(chosen))
  await clock.advance(6000)
  // Повторное нажатие «Выбрать» на том же варианте без новых комментариев — тоже.
  const again = { ...chosen, chosenAt: '2026-10-10T10:02:00Z' }
  world.write(path, JSON.stringify(again))
  await clock.advance(2000)
  expect(world.toasts).toContain('Этот выбор уже отправлен')
  expect(JSON.parse(world.files.get(`${appDir}/.state/ack.json`)?.text ?? '{}'))
    .toMatchObject({ chosenAt: again.chosenAt, status: 'duplicate' })
  // Повторная загрузка скилла в той же сессии — тоже нет.
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  await clock.advance(4000)
  expect(world.prompts.length).toBe(1)
  expect(world.toasts.filter(text => text.startsWith('Выбран вариант')).length).toBe(1)

  // Новый комментарий и снова «Выбрать» — это новая информация, она отправляется.
  const extra = { variantId: 'login-b', target: '', text: 'без тени', at: '2026-10-10T10:03:00Z' }
  world.write(path, JSON.stringify({ ...chosen, chosenAt: '2026-10-10T10:03:01Z', notes: [note, extra] }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(2)
  expect(world.prompts[1]).toContain('без тени')
  // Новый показ с тем же id варианта — тоже новый выбор.
  world.write(path, JSON.stringify({ ...chosen, round: 'round-2', chosenAt: '2026-10-10T11:00:00Z' }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(3)
  expectNothingInProject(world)
})

test('close закрывает окно, clean удаляет приложение и выключает мод', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  world.write(`${appDir}/.state/flutter.pid`, '4242')
  await clock.advance(2000)

  const closing = $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT.replace('ARGS', 'close') })
  await clock.advance(2000)
  expect((await closing).text).toBe('Окно-пикер закрыто.')
  expect(world.signals).toContain('-TERM 4242')

  const cleaning = $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT.replace('ARGS', 'clean') })
  await clock.advance(2000)
  expect((await cleaning).text).toBe('Окно-пикер закрыто, временное приложение удалено.')
  expect(world.appDir()).toBeUndefined()

  // После clean мод неактивен.
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(2000)
  expect(world.spawns.length).toBe(1)
  expectNothingInProject(world)
})

test('после перезагрузки мода активность восстанавливается из $.store', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  // session.start после reload: таймеры отменены, состояние модуля сброшено.
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
  world.write(`${appDir}/.state/decision.json`, JSON.stringify({
    feature: 'Экран входа',
    chosen: 'login-a',
    chosenTitle: 'Карточка',
    chosenAt: '2026-10-10T11:00:00Z',
    notes: [],
  }))
  await clock.advance(2000)
  expect(world.toasts).toEqual(['Выбран вариант: Карточка'])
  expect(world.prompts.length).toBe(1)
  // Запись вариантов после восстановления снова открывает окно.
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.spawns.length).toBe(1)
})

test('варианты, записанные через Bash, тоже открывают окно; чтение через Bash — нет', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''

  // Только чтение и анализ: файлы пикера не изменились.
  await $.tool.call({ tool: 'Bash', command: `flutter analyze ${appDir}/lib` })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.spawns).toEqual([])

  // Bash пишет варианты через переменную: путь целиком в команде не встречается.
  world.write(`${appDir}/lib/variants/badge_a.dart`, '// вариант')
  world.write(`${appDir}/lib/registry.dart`, '// реестр с badge_a')
  await $.tool.call({ tool: 'Bash', command: 'D=/x; cat > "$D/lib/variants/badge_a.dart" <<EOF' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.spawns.length).toBe(1)

  // Следующий ход без изменений — окно не трогается.
  world.write(`${appDir}/.state/flutter.pid`, '4242')
  await clock.advance(2000)
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.signals.filter(signal => signal.startsWith('-USR2'))).toEqual([])
  expectNothingInProject(world)
})

test('решение, сделанное до загрузки скилла, ход не запускает', async ($, on) => {
  // Подпись отправки в старом формате (до версии 0.1.6): повторно не отправлять.
  const store = { 'submitted|/work/demo_app': 'r1|a|' }
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC, store })
  const now = 1_700_000_000_000
  const clock = mock.clock(on, { now })
  const clear = { reason: 'clear' as const, sessionId: 'session-1', resume: { id: 'session-1' } }
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  const path = `${appDir}/.state/decision.json`
  await $.session.end(clear)

  // Выбор минуту назад, пока сессия не следила за окном.
  const fresh = { round: 'r1', feature: 'Экран', chosen: 'a', chosenTitle: 'А', chosenAt: new Date(now - 60_000).toISOString(), notes: [] }
  world.write(path, JSON.stringify(fresh))
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  await clock.advance(6000)
  expect(world.prompts).toEqual([])
  expect(world.toasts).toEqual([])

  // Новый выбор при открытой сессии отправляется как обычно.
  world.write(path, JSON.stringify({ ...fresh, chosen: 'b', chosenAt: new Date(now + 5000).toISOString() }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(1)
})

test('конец сессии закрывает окно и flutter run', async ($, on) => {
  const now = 1_700_000_000_000
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now })
  const end = { reason: 'prompt_input_exit' as const, sessionId: 'session-1', resume: { id: 'session-1' } }
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  expect(JSON.parse(world.files.get(`${appDir}/.state/heartbeat.json`)?.text ?? '{}')).toMatchObject({ at: now })
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  world.write(`${appDir}/.state/flutter.pid`, '4242')
  await clock.advance(2000)
  expect(world.alive.has(4242)).toBe(true)

  await $.session.end(end)
  expect(world.signals).toContain('-TERM 4242')
  expect(world.signals).toContain(`pkill ${appDir}/build/macos/Build/Products/Debug/ui_variants_host.app`)
  expect(world.alive.has(4242)).toBe(false)
})

test('при другой живой сессии того же проекта окно остаётся открытым', async ($, on) => {
  const now = 1_700_000_000_000
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC, store: { 'alive|/work/demo_app|session-2': now } })
  const clock = mock.clock(on, { now })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  world.write(`${appDir}/.state/flutter.pid`, '4242')
  await clock.advance(2000)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })
  expect(world.alive.has(4242)).toBe(true)
  expect(world.signals.some(signal => signal.startsWith('pkill'))).toBe(false)
})

test('после выбора окно закрывается, после комментария без выбора — нет', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  const path = `${appDir}/.state/decision.json`
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  world.write(`${appDir}/.state/flutter.pid`, '4242')
  await clock.advance(2000)

  const note = { variantId: 'a', target: '', text: 'ярче', at: '2026-10-10T10:00:00Z' }
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Экран', chosen: null, notes: [note] }))
  await clock.advance(6000)
  expect(world.alive.has(4242)).toBe(true)

  world.write(path, JSON.stringify({ round: 'r1', feature: 'Экран', chosen: 'a', chosenTitle: 'А', chosenAt: '2026-10-10T10:01:00Z', notes: [note] }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(1)
  // Окно ещё успевает показать подтверждение.
  expect(world.alive.has(4242)).toBe(true)
  await clock.advance(3000)
  expect(world.signals).toContain('-TERM 4242')
  expect(world.alive.has(4242)).toBe(false)

  // Новые варианты снова открывают окно.
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.spawns.length).toBe(2)
})

test('несколько вопросов: одно сообщение со всеми выборами', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  const path = `${appDir}/.state/decision.json`
  const choices = [
    { group: 'Раскладка', variantId: 'layout-cards', title: 'Карточки' },
    { group: 'Цвета', variantId: 'color-warm', title: 'Тёплые' },
  ]
  // Отметки до отправки (chosen пуст) ход не запускают.
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Экран', chosen: null, choices: choices.slice(0, 1), notes: [] }))
  await clock.advance(4000)
  expect(world.prompts).toEqual([])

  const sent = { round: 'r1', feature: 'Экран', chosen: 'layout-cards', chosenTitle: 'Карточки, Тёплые', chosenAt: '2026-10-10T10:00:00Z', choices, notes: [] }
  world.write(path, JSON.stringify(sent))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('Выбраны варианты для фичи «Экран»: Раскладка — layout-cards; Цвета — color-warm.')
  expect(world.prompts[0]).toContain('Реализуй выбранные варианты в проекте.')
  expect(world.toasts).toContain('Выбраны варианты: Карточки, Тёплые')

  // Те же отметки ещё раз — не отправляются; другой цвет — новое сообщение.
  world.write(path, JSON.stringify({ ...sent, chosenAt: '2026-10-10T10:01:00Z' }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(1)
  const other = [choices[0], { group: 'Цвета', variantId: 'color-cold', title: 'Холодные' }]
  world.write(path, JSON.stringify({ ...sent, chosenAt: '2026-10-10T10:02:00Z', choices: other }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(2)
  expect(world.prompts[1]).toContain('Цвета — color-cold')
})

test('рамки device_frame, а при конфликте версий — встроенные', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  mock.clock(on)
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  expect(world.files.get(`${appDir}/pubspec.yaml`)?.text).toContain("device_frame: '>=1.2.0 <2.0.0'")
  expect(world.files.get(`${appDir}/lib/_host/frames.dart`)?.text).toBe('// рамки device_frame')
  expect([...world.files.keys()].some(path => path.includes('/fallback/'))).toBe(false)

  // pubspec проекта изменился и теперь конфликтует с device_frame.
  world.failFrames = true
  world.write(`${PROJECT}/pubspec.yaml`, FLUTTER_PUBSPEC + '  freezed_annotation: ^2.4.0\n')
  const answer = await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  expect(answer.text).not.toContain('недоступно')
  expect(world.files.get(`${appDir}/pubspec.yaml`)?.text).not.toContain('device_frame')
  expect(world.files.get(`${appDir}/lib/_host/frames.dart`)?.text).toBe('// встроенные рамки')
  expect(world.files.get(`${appDir}/.state/mod.log`)?.text).toContain('device_frame не подошёл')
})

test('правка варианта сразу уходит Claude, окно не закрывается', async ($, on) => {
  // Правка, лежавшая в файле до загрузки скилла, не отправляется.
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  const path = `${appDir}/.state/decision.json`
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  const old = { id: 'r-old', variantId: 'a', title: 'А', target: '', text: 'старая правка', at: '2026-10-10T09:00:00Z' }
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Экран', chosen: null, notes: [], requests: [old] }))
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  world.write(`${appDir}/.state/flutter.pid`, '4242')
  await clock.advance(4000)
  expect(world.prompts).toEqual([])

  const fix = { id: 'r1', variantId: 'card-row', title: 'Строка', target: 'кнопка «+»', text: 'сделай синей и увеличь отступ', at: '2026-10-10T10:00:00Z' }
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Экран', chosen: null, notes: [], requests: [old, fix] }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('Правка варианта из окна-пикера — card-row («Строка»), элемент «кнопка «+»»: сделай синей и увеличь отступ.')
  expect(world.prompts[0]).toContain(`${appDir}/lib/variants`)
  expect(world.prompts[0]).not.toContain('старая правка')
  expect(JSON.parse(world.files.get(`${appDir}/.state/requests-ack.json`)?.text ?? '{}')).toEqual({ sent: ['r-old', 'r1'] })
  expect(world.toasts.some(text => text.startsWith('Правка отправлена Claude'))).toBe(true)

  // Повторное чтение файла — без повторной отправки; две новые — одним сообщением.
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Экран', chosen: null, notes: [], requests: [old, fix] }))
  await clock.advance(4000)
  expect(world.prompts.length).toBe(1)
  const more = [
    { id: 'r2', variantId: 'card-row', title: 'Строка', target: '', text: 'поменяй порядок', at: '2026-10-10T10:01:00Z' },
    { id: 'r3', variantId: 'card-hero', title: 'Герой', target: '', text: 'меньше шрифт', at: '2026-10-10T10:01:01Z' },
  ]
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Экран', chosen: null, notes: [], requests: [old, fix, ...more] }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(2)
  expect(world.prompts[1]).toContain('Правки вариантов из окна-пикера: 1) card-row («Строка»): поменяй порядок; 2) card-hero («Герой»): меньше шрифт.')
  // Правка не закрывает окно, в отличие от выбора.
  await clock.advance(5000)
  expect(world.alive.has(4242)).toBe(true)
})

// Tests of the ui-variants mod: the file system, processes, store and clock are
// in-memory stubs; the engine loads the mod from the plugin folder.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PROJECT = '/work/demo_app'
const HOME = '/Users/tester'
const FLUTTER = '/sdk/flutter/bin/flutter'
const CACHE = `${HOME}/Library/Caches/ui-variants/`

const FLUTTER_PUBSPEC = [
  'name: demo_app',
  'description: Demo',
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
  'Show variants for: ARGS',
  'Variants: {{VARIANTS_DIR}}',
  'Registry: {{REGISTRY}}',
  'Theme: {{THEME}}',
  'Decision: {{DECISION}}',
  'Package: package:{{PACKAGE}}/',
  'Check: {{APP_DIR}}',
].join('\n')

const TEMPLATES: Record<string, string> = {
  'pubspec.yaml.tmpl':
    'name: ui_variants_host\nenvironment:\n  sdk: {{SDK}}\ndependencies:\n  flutter:\n    sdk: flutter\n  {{PACKAGE}}:\n    path: {{PROJECT_ROOT}}\n{{DEVICE_FRAME}}\n',
  'lib/_host/frames.dart': '// device_frame frames',
  'fallback/frames.dart': '// built-in frames',
  'analysis_options.yaml': 'analyzer:\n',
  'lib/main.dart': '// picker window',
  'lib/registry.dart': '// default registry',
  'lib/theme.dart': '// default theme',
  'lib/_host/version.dart.tmpl': "const String hostTemplateVersion = '{{VERSION}}';",
  'macos/Runner/MainFlutterWindow.swift.tmpl': 'title = "UI Variants — {{PACKAGE}}"',
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
      // Quick window close: a signal to live flutter run processes and pkill of the app.
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

const TURN = { answer: 'Done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' as const }

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

test('hooks do nothing before the skill is loaded', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: `${CACHE}demo_app-x/lib/registry.dart`, content: '' })
  await $.tool.call({ tool: 'Edit', file_path: `${PROJECT}/lib/main.dart`, old_string: 'a', new_string: 'b' })
  await $.turn.complete(TURN)
  await clock.advance(10_000)
  await $.skill.prompt({ skill: 'other-skill', text: 'Show variants for: x' })
  expect(world.writes).toEqual([])
  expect(world.runs).toEqual([])
  expect(world.spawns).toEqual([])
  expect(world.toasts).toEqual([])
  expect(world.prompts).toEqual([])
})

test('in a non-Flutter project the skill returns a short refusal', async ($, on) => {
  const world = setup(on, { pubspec: DART_PUBSPEC })
  mock.clock(on)
  const answer = await $.skill.prompt({ skill: 'ui-variants:ui-variants', text: SKILL_TEXT })
  expect(answer.text).toBe('This is not a Flutter project, so the picker window is not available here. Describe the variants in text.')
  expect(world.writes).toEqual([])
  expect(world.runs).toEqual([])
})

test('without pubspec.yaml the skill refuses too', async ($, on) => {
  const world = setup(on)
  mock.clock(on)
  const answer = await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  expect(answer.text).toMatch(/^This is not a Flutter project/)
  expect(world.writes).toEqual([])
})

test('loading the skill creates the picker app and fills in the paths', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  mock.clock(on, { now: 1_700_000_000_000 })
  const answer = await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT.replace('ARGS', 'sign-in screen') })
  const appDir = world.appDir()
  expect(appDir).toBeDefined()
  expect(appDir).toMatch(/\/Library\/Caches\/ui-variants\/demo_app-[0-9a-f]{8}$/)
  expect(answer.text).toContain('Show variants for: sign-in screen')
  expect(answer.text).toContain(`Variants: ${appDir}/lib/variants`)
  expect(answer.text).toContain(`Registry: ${appDir}/lib/registry.dart`)
  expect(answer.text).toContain(`Theme: ${appDir}/lib/theme.dart`)
  expect(answer.text).toContain(`Decision: ${appDir}/.state/decision.json`)
  expect(answer.text).toContain('Package: package:demo_app/')
  expect(answer.text).not.toContain('{{')
  const create = world.runs.find(run => run.argv[1] === 'create')
  expect(create?.argv).toEqual([FLUTTER, 'create', '--platforms=macos', '--project-name', 'ui_variants_host',
    '--org', 'dev.uivariants', '--no-pub', appDir])
  const pubspec = world.files.get(`${appDir}/pubspec.yaml`)?.text ?? ''
  expect(pubspec).toContain("path: '/work/demo_app'")
  expect(pubspec).toContain("sdk: '>=3.4.0 <4.0.0'")
  expect(world.files.get(`${appDir}/lib/main.dart`)?.text).toBe('// picker window')
  expect(world.files.get(`${appDir}/lib/_host/version.dart`)?.text).toContain("'0.1.0'")
  expect(world.files.get(`${appDir}/macos/Runner/MainFlutterWindow.swift`)?.text).toContain('demo_app')
  expect(world.files.get(`${appDir}/macos/Runner/DebugProfile.entitlements`)?.text).toContain('<false/>')
  expect(world.files.get(`${appDir}/macos/Runner/Release.entitlements`)?.text).toContain('<false/>')
  expect(world.runs.some(run => run.argv[1] === 'pub' && run.cwd === appDir)).toBe(true)
  expect(world.toasts).toEqual([])
  expect(world.prompts).toEqual([])
  expectNothingInProject(world)
})

test('a template update leaves the registry, theme and variants alone', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  mock.clock(on)
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  world.write(`${appDir}/lib/registry.dart`, '// registry by Claude')
  world.write(`${appDir}/lib/theme.dart`, '// project theme')
  world.files.delete(`${appDir}/lib/_host/version.dart`)
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  expect(world.files.get(`${appDir}/lib/registry.dart`)?.text).toBe('// registry by Claude')
  expect(world.files.get(`${appDir}/lib/theme.dart`)?.text).toBe('// project theme')
  expect(world.files.get(`${appDir}/lib/_host/version.dart`)?.text).toContain('0.1.0')
  expect(world.runs.filter(run => run.argv[1] === 'create').length).toBe(1)
})

test('a pub get failure adds the reason and asks to describe variants in text', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  mock.clock(on)
  world.failPubGet = true
  const answer = await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  expect(answer.text).toContain('picker window is not available right now')
  expect(answer.text).toContain('version solving failed')
  expect(answer.text).toContain('describe the variants in text')
  // The mod did not activate: writing the registry does not open the window.
  await $.tool.call({ tool: 'Write', file_path: `${world.appDir()}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  expect(world.spawns).toEqual([])
})

test('a registry.dart write and the turn end open the window; the next time it hot restarts', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''

  // A write outside the picker does not open the window.
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
  expect(world.toasts).toContain('Opening the variants window…')

  // flutter run wrote the pid file: the window is open.
  world.write(`${appDir}/.state/flutter.pid`, '4242')
  await clock.advance(2000)
  expect(world.toasts).toContain('Variants window is open')

  // New variants: a hot restart of the same process.
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.signals).toContain('-USR2 4242')
  expect(world.spawns.length).toBe(1)
  expect(world.toasts).toContain('Variants window updated')
  expectNothingInProject(world)
})

test('a new choice gives a toast and exactly one prompt.submit; a repeat gives none', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  const path = `${appDir}/.state/decision.json`

  // Broken JSON: the tick is skipped.
  world.write(path, '{"chosen": ')
  await clock.advance(2000)
  expect(world.toasts).toEqual([])

  // A note without a choice: only a toast.
  const note = { variantId: 'login-a', target: 'sign-in button', text: 'bigger', at: '2026-10-10T10:00:00Z' }
  world.write(path, JSON.stringify({ feature: 'Sign-in screen', chosen: null, notes: [note] }))
  await clock.advance(2000)
  expect(world.toasts.length).toBe(1)
  expect(world.toasts[0]).toContain('bigger')
  expect(world.prompts).toEqual([])

  const chosen = {
    round: 'round-1',
    feature: 'Sign-in screen',
    chosen: 'login-b',
    chosenTitle: 'Compact',
    chosenAt: '2026-10-10T10:01:00Z',
    notes: [note],
  }
  world.write(path, JSON.stringify(chosen))
  await clock.advance(2000)
  expect(world.toasts).toContain('Chosen variant: Compact')
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('Chosen variant login-b for "Sign-in screen"')
  expect(world.prompts[0]).toContain('[login-a → sign-in button] bigger')
  expect(world.prompts[0]).toContain(path)
  expect(world.prompts[0]).toContain('Implement the chosen variant in the project')
  // The window gets an acknowledgement.
  const ack = JSON.parse(world.files.get(`${appDir}/.state/ack.json`)?.text ?? '{}')
  expect(ack).toMatchObject({ chosenAt: chosen.chosenAt, status: 'sent' })

  // The same choice with the file rewritten is not sent again.
  world.write(path, JSON.stringify(chosen))
  await clock.advance(6000)
  // Neither is pressing Choose again on the same variant without new notes.
  const again = { ...chosen, chosenAt: '2026-10-10T10:02:00Z' }
  world.write(path, JSON.stringify(again))
  await clock.advance(2000)
  expect(world.toasts).toContain('This choice was already sent')
  expect(JSON.parse(world.files.get(`${appDir}/.state/ack.json`)?.text ?? '{}'))
    .toMatchObject({ chosenAt: again.chosenAt, status: 'duplicate' })
  // Reloading the skill in the same session does not send it either.
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  await clock.advance(4000)
  expect(world.prompts.length).toBe(1)
  expect(world.toasts.filter(text => text.startsWith('Chosen variant')).length).toBe(1)

  // A new note and Choose again carry new information, so they are sent.
  const extra = { variantId: 'login-b', target: '', text: 'no shadow', at: '2026-10-10T10:03:00Z' }
  world.write(path, JSON.stringify({ ...chosen, chosenAt: '2026-10-10T10:03:01Z', notes: [note, extra] }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(2)
  expect(world.prompts[1]).toContain('no shadow')
  // A new show with the same variant id is a new choice too.
  world.write(path, JSON.stringify({ ...chosen, round: 'round-2', chosenAt: '2026-10-10T11:00:00Z' }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(3)
  expectNothingInProject(world)
})

test('close closes the window; clean deletes the app and deactivates the mod', async ($, on) => {
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
  expect((await closing).text).toBe('The picker window is closed.')
  expect(world.signals).toContain('-TERM 4242')

  const cleaning = $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT.replace('ARGS', 'clean') })
  await clock.advance(2000)
  expect((await cleaning).text).toBe('The picker window is closed and the temporary app is deleted.')
  expect(world.appDir()).toBeUndefined()

  // After clean the mod is inactive.
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(2000)
  expect(world.spawns.length).toBe(1)
  expectNothingInProject(world)
})

test('after a mod reload activity is restored from $.store', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  // session.start after a reload: timers cancelled, module state reset.
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
  world.write(`${appDir}/.state/decision.json`, JSON.stringify({
    feature: 'Sign-in screen',
    chosen: 'login-a',
    chosenTitle: 'Card',
    chosenAt: '2026-10-10T11:00:00Z',
    notes: [],
  }))
  await clock.advance(2000)
  expect(world.toasts).toEqual(['Chosen variant: Card'])
  expect(world.prompts.length).toBe(1)
  // Writing variants after the restore opens the window again.
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.spawns.length).toBe(1)
})

test('variants written with Bash open the window too; reading with Bash does not', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''

  // Reading and analysis only: the picker files did not change.
  await $.tool.call({ tool: 'Bash', command: `flutter analyze ${appDir}/lib` })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.spawns).toEqual([])

  // Bash writes variants through a variable: the full path is not in the command.
  world.write(`${appDir}/lib/variants/badge_a.dart`, '// variant')
  world.write(`${appDir}/lib/registry.dart`, '// registry with badge_a')
  await $.tool.call({ tool: 'Bash', command: 'D=/x; cat > "$D/lib/variants/badge_a.dart" <<EOF' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.spawns.length).toBe(1)

  // The next turn without changes leaves the window alone.
  world.write(`${appDir}/.state/flutter.pid`, '4242')
  await clock.advance(2000)
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.signals.filter(signal => signal.startsWith('-USR2'))).toEqual([])
  expectNothingInProject(world)
})

test('a decision made before the skill loaded does not start a turn', async ($, on) => {
  // A send signature in the old format (before 0.1.6): do not send again.
  const store = { 'submitted|/work/demo_app': 'r1|a|' }
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC, store })
  const now = 1_700_000_000_000
  const clock = mock.clock(on, { now })
  const clear = { reason: 'clear' as const, sessionId: 'session-1', resume: { id: 'session-1' } }
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  const path = `${appDir}/.state/decision.json`
  await $.session.end(clear)

  // A choice a minute ago, while no session watched the window.
  const fresh = { round: 'r1', feature: 'Screen', chosen: 'a', chosenTitle: 'A', chosenAt: new Date(now - 60_000).toISOString(), notes: [] }
  world.write(path, JSON.stringify(fresh))
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  await clock.advance(6000)
  expect(world.prompts).toEqual([])
  expect(world.toasts).toEqual([])

  // A new choice while the session is open is sent as usual.
  world.write(path, JSON.stringify({ ...fresh, chosen: 'b', chosenAt: new Date(now + 5000).toISOString() }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(1)
})

test('the session end closes the window and flutter run', async ($, on) => {
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

test('the window stays open if another live session watches the project', async ($, on) => {
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

test('the window closes after a choice, not after a note without a choice', async ($, on) => {
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

  const note = { variantId: 'a', target: '', text: 'brighter', at: '2026-10-10T10:00:00Z' }
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Screen', chosen: null, notes: [note] }))
  await clock.advance(6000)
  expect(world.alive.has(4242)).toBe(true)

  world.write(path, JSON.stringify({ round: 'r1', feature: 'Screen', chosen: 'a', chosenTitle: 'A', chosenAt: '2026-10-10T10:01:00Z', notes: [note] }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(1)
  // The window still has time to show the acknowledgement.
  expect(world.alive.has(4242)).toBe(true)
  await clock.advance(3000)
  expect(world.signals).toContain('-TERM 4242')
  expect(world.alive.has(4242)).toBe(false)

  // New variants open the window again.
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  expect(world.spawns.length).toBe(2)
})

test('several questions: one message with all the choices', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  const path = `${appDir}/.state/decision.json`
  const choices = [
    { group: 'Layout', variantId: 'layout-cards', title: 'Cards' },
    { group: 'Colors', variantId: 'color-warm', title: 'Warm' },
  ]
  // Marks before sending (chosen is empty) do not start a turn.
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Screen', chosen: null, choices: choices.slice(0, 1), notes: [] }))
  await clock.advance(4000)
  expect(world.prompts).toEqual([])

  const sent = { round: 'r1', feature: 'Screen', chosen: 'layout-cards', chosenTitle: 'Cards, Warm', chosenAt: '2026-10-10T10:00:00Z', choices, notes: [] }
  world.write(path, JSON.stringify(sent))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('Chosen variants for "Screen": Layout — layout-cards; Colors — color-warm.')
  expect(world.prompts[0]).toContain('Implement the chosen variants in the project.')
  expect(world.toasts).toContain('Chosen variants: Cards, Warm')

  // The same marks again are not sent; another color is a new message.
  world.write(path, JSON.stringify({ ...sent, chosenAt: '2026-10-10T10:01:00Z' }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(1)
  const other = [choices[0], { group: 'Colors', variantId: 'color-cold', title: 'Cold' }]
  world.write(path, JSON.stringify({ ...sent, chosenAt: '2026-10-10T10:02:00Z', choices: other }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(2)
  expect(world.prompts[1]).toContain('Colors — color-cold')
})

test('device_frame frames, or built-in ones on a version conflict', async ($, on) => {
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  mock.clock(on)
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  expect(world.files.get(`${appDir}/pubspec.yaml`)?.text).toContain("device_frame: '>=1.2.0 <2.0.0'")
  expect(world.files.get(`${appDir}/lib/_host/frames.dart`)?.text).toBe('// device_frame frames')
  expect([...world.files.keys()].some(path => path.includes('/fallback/'))).toBe(false)

  // The project's pubspec changed and now conflicts with device_frame.
  world.failFrames = true
  world.write(`${PROJECT}/pubspec.yaml`, FLUTTER_PUBSPEC + '  freezed_annotation: ^2.4.0\n')
  const answer = await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  expect(answer.text).not.toContain('not available')
  expect(world.files.get(`${appDir}/pubspec.yaml`)?.text).not.toContain('device_frame')
  expect(world.files.get(`${appDir}/lib/_host/frames.dart`)?.text).toBe('// built-in frames')
  expect(world.files.get(`${appDir}/.state/mod.log`)?.text).toContain('device_frame does not fit')
})

test('a variant revision goes to Claude right away and the window stays open', async ($, on) => {
  // A revision already in the file before the skill loaded is not sent.
  const world = setup(on, { pubspec: FLUTTER_PUBSPEC })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  const appDir = world.appDir() ?? ''
  const path = `${appDir}/.state/decision.json`
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  const old = { id: 'r-old', variantId: 'a', title: 'A', target: '', text: 'old revision', at: '2026-10-10T09:00:00Z' }
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Screen', chosen: null, notes: [], requests: [old] }))
  await $.skill.prompt({ skill: 'ui-variants', text: SKILL_TEXT })
  await $.tool.call({ tool: 'Write', file_path: `${appDir}/lib/registry.dart`, content: '' })
  await $.turn.complete(TURN)
  await clock.advance(100)
  world.write(`${appDir}/.state/flutter.pid`, '4242')
  await clock.advance(4000)
  expect(world.prompts).toEqual([])

  const fix = { id: 'r1', variantId: 'card-row', title: 'Row', target: 'the + button', text: 'make it blue and increase the padding', at: '2026-10-10T10:00:00Z' }
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Screen', chosen: null, notes: [], requests: [old, fix] }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('Variant revision from the picker window — card-row ("Row"), element "the + button": make it blue and increase the padding.')
  expect(world.prompts[0]).toContain(`${appDir}/lib/variants`)
  expect(world.prompts[0]).not.toContain('old revision')
  expect(JSON.parse(world.files.get(`${appDir}/.state/requests-ack.json`)?.text ?? '{}')).toEqual({ sent: ['r-old', 'r1'] })
  expect(world.toasts.some(text => text.startsWith('Revision sent to Claude'))).toBe(true)

  // Rereading the file sends nothing again; two new ones go in one message.
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Screen', chosen: null, notes: [], requests: [old, fix] }))
  await clock.advance(4000)
  expect(world.prompts.length).toBe(1)
  const more = [
    { id: 'r2', variantId: 'card-row', title: 'Row', target: '', text: 'change the order', at: '2026-10-10T10:01:00Z' },
    { id: 'r3', variantId: 'card-hero', title: 'Hero', target: '', text: 'smaller font', at: '2026-10-10T10:01:01Z' },
  ]
  world.write(path, JSON.stringify({ round: 'r1', feature: 'Screen', chosen: null, notes: [], requests: [old, fix, ...more] }))
  await clock.advance(2000)
  expect(world.prompts.length).toBe(2)
  expect(world.prompts[1]).toContain('Variant revisions from the picker window: 1) card-row ("Row"): change the order; 2) card-hero ("Hero"): smaller font.')
  // Unlike a choice, a revision does not close the window.
  await clock.advance(5000)
  expect(world.alive.has(4242)).toBe(true)
})

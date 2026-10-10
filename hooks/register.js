// ui-variants mod: a live picker window for UI variants in Flutter projects on macOS.
//
// Until the ui-variants skill is loaded in a session, the mod does nothing.
// Loading the skill creates a temporary picker app in ~/Library/Caches/ui-variants;
// after a Claude turn that writes variants, the mod opens the window (or hot
// restarts it), and sends the choice, notes and revisions from the window back
// into the session as the next message. The window closes after a choice and
// when the session ends.

import {
  choicePrompt,
  choiceSignature,
  compareVersions,
  decisionChoices,
  fillPlaceholders,
  flutterError,
  isFlutterPubspec,
  lastLine,
  noteLine,
  notesSignature,
  parseArgs,
  parseDecision,
  pubspecName,
  pubspecSdk,
  revisionPrompt,
  sendSignature,
  shortHash,
  widerSdk,
  withoutSandbox,
  yamlQuote,
} from './util.js'

const TICK_MS = 2000
const OWNER_BEAT_MS = 5000
const OWNER_STALE_MS = 15000
const RESTART_CHECK_MS = 4000
const RESTART_GIVE_UP_MS = 60000
const STORE_TTL_MS = 14 * 24 * 60 * 60 * 1000
const ALIVE_TTL_MS = 24 * 60 * 60 * 1000
const CLOSE_AFTER_CHOICE_MS = 2500
const LONG_MS = 300000

const NOT_FLUTTER = 'This is not a Flutter project, so the picker window is not available here. Describe the variants in text.'

// Temporary app files that template updates never overwrite.
const PROTECTED = /^lib\/(registry\.dart|theme\.dart|variants\/)/

// Device frames: the device_frame package (a version range, so pub can pick one
// compatible with the project's dependencies) or built-in frames if none fits.
const DEVICE_FRAME_DEPENDENCY = "  device_frame: '>=1.2.0 <2.0.0'"
const FRAMES_TEMPLATES = { device_frame: 'lib/_host/frames.dart', builtin: 'fallback/frames.dart' }

// Starts flutter run in the background, detached from the Claude Code process:
// the window survives a mod reload, and the mod itself closes it (session end,
// close, clean). Prints the PID of the started process.
const LAUNCH_SCRIPT = [
  'mkdir -p "$UIV_STATE"',
  'rm -f "$UIV_STATE/flutter.pid"',
  // A window that outlived its flutter run cannot be refreshed: close it.
  'pkill -f "$UIV_APP_BUNDLE" 2>/dev/null',
  'nohup /usr/bin/perl -MPOSIX -e \'POSIX::setsid(); exec @ARGV or die "exec: $!"\' ' +
    '"$UIV_FLUTTER" run -d macos --pid-file "$UIV_STATE/flutter.pid" ' +
    '"--dart-define=UI_VARIANTS_STATE=$UIV_STATE" ' +
    '"--dart-define=UI_VARIANTS_PACKAGE=$UIV_PACKAGE" ' +
    '</dev/null >"$UIV_STATE/flutter.log" 2>&1 &',
  'echo $!',
].join('\n')

// Closes the window with one quick command (session.end has about 1.5 s in all).
// Only this project's flutter run gets the signal: its command line contains the
// .state path, so another flutter run, or a PID reused by another process, is
// left alone. Prints 1 if anything was running.
const STOP_SCRIPT = [
  'found=0',
  'for p in $UIV_PIDS; do',
  '  if ps -p "$p" -o command= 2>/dev/null | grep -qF -- "$UIV_STATE"; then',
  '    kill -TERM "$p" 2>/dev/null && found=1',
  '  fi',
  'done',
  'pkill -f "$UIV_APP_BUNDLE" && found=1',
  'echo $found',
].join('\n')

// Module state. It is empty after a mod reload and is restored from $.store in
// session.start.
let active = null
let watchTimer = null
let closeTimer = null
let needsRefresh = false
let launching = null
let pendingRestart = false
let restartCheck = null
let seen = { choice: undefined, notes: '' }
let decisionMtime = -1
let isTicking = false
let ownerBeatAt = 0
let lastFingerprint = ''
let version = undefined

// $.store keys: every key includes the project path.
function activeKey(root, sessionId) {
  return `active|${root}|${sessionId}`
}
function seenKey(root, sessionId) {
  return `seen|${root}|${sessionId}`
}
function windowKey(root) {
  return `window|${root}`
}
function submittedKey(root) {
  return `submitted|${root}`
}
function ownerKey(root) {
  return `owner|${root}`
}
function hostKey(root) {
  return `host|${root}`
}
function flutterKey(root) {
  return `flutter|${root}`
}
function aliveKey(root, sessionId) {
  return `alive|${root}|${sessionId}`
}
function requestedKey(root) {
  return `requested|${root}`
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function resetState() {
  active = null
  needsRefresh = false
  launching = null
  pendingRestart = false
  restartCheck = null
  seen = { choice: undefined, notes: '' }
  decisionMtime = -1
  isTicking = false
  ownerBeatAt = 0
  lastFingerprint = ''
}

function stopWatch() {
  if (watchTimer !== null) watchTimer.cancel()
  watchTimer = null
  if (closeTimer !== null) closeTimer.cancel()
  closeTimer = null
}

function startWatch($) {
  if (watchTimer === null) watchTimer = $.clock.every(TICK_MS, () => void tick($))
}

/** Paths of the project's temporary app. */
function hostPaths(root, pkg, home) {
  const appDir = `${home}/Library/Caches/ui-variants/${pkg}-${shortHash(root)}`
  return { appDir, stateDir: `${appDir}/.state` }
}

/** The project's built picker app (its process is found by this path). */
function appBundle(ctx) {
  return `${ctx.appDir}/build/macos/Build/Products/Debug/ui_variants_host.app`
}

/** The skill text with the paths filled in. */
function fillSkill(text, ctx) {
  return fillPlaceholders(text, {
    VARIANTS_DIR: `${ctx.appDir}/lib/variants`,
    REGISTRY: `${ctx.appDir}/lib/registry.dart`,
    THEME: `${ctx.appDir}/lib/theme.dart`,
    DECISION: `${ctx.stateDir}/decision.json`,
    PACKAGE: ctx.pkg,
    APP_DIR: ctx.appDir,
  })
}

function unavailableSkill(text, ctx, reason) {
  return `${fillSkill(text, ctx)}\n\nIMPORTANT: the picker window is not available right now (${reason}). ` +
    'This time describe the variants in text in your reply and skip the instructions about the temporary app.'
}

/** Whether a tool call writes the variant, registry or theme files. */
function touchesHost(e, appDir) {
  const lib = `${appDir}/lib/`
  const watched = path =>
    path === `${lib}registry.dart` || path === `${lib}theme.dart` || path.startsWith(`${lib}variants/`)
  return [e.file_path, e.notebook_path].some(path => typeof path === 'string' && watched(path))
}

async function collectStamps($, dir, prefix, parts) {
  if (!(await $.fs.exists(dir))) return
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind === 'dir') await collectStamps($, `${dir}/${entry.name}`, `${prefix}${entry.name}/`, parts)
    else parts.push(`${prefix}${entry.name}:${entry.mtimeMs}:${entry.size}`)
  }
}

/**
 * A fingerprint of the picker files Claude writes: registry, theme and variants.
 * Catches writes made any way (Bash, a subagent), not only Write and Edit.
 */
async function hostFingerprint($, ctx) {
  const lib = `${ctx.appDir}/lib`
  const parts = []
  for (const name of ['registry.dart', 'theme.dart']) {
    const path = `${lib}/${name}`
    const stat = (await $.fs.exists(path)) ? await $.fs.stat(path) : undefined
    parts.push(`${name}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`)
  }
  await collectStamps($, `${lib}/variants`, 'variants/', parts)
  return parts.sort().join('|')
}

async function pluginVersion($) {
  if (version === undefined) {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    version = String(manifest.version ?? '0.0.0')
  }
  return version
}

async function logError($, ctx, text) {
  $.ui.log(`ui-variants: ${text}`, { to: 'debug' })
  if (ctx === null) return
  const path = `${ctx.stateDir}/mod.log`
  const at = new Date(await $.clock.now()).toISOString()
  const previous = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  const lines = `${previous}${at} ${text}\n`.split('\n').slice(-200)
  await $.fs.write(path, lines.join('\n'))
}

async function isAlive($, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const probe = await $.process.run(['kill', '-0', String(pid)])
  return probe.exitCode === 0
}

/** The PID of this project's flutter run, if it is alive. */
async function windowPid($, ctx) {
  const saved = await $.store.get(windowKey(ctx.root))
  let pid = saved !== null && typeof saved === 'object' ? saved.pid : undefined
  const pidPath = `${ctx.stateDir}/flutter.pid`
  if (!Number.isInteger(pid) && (await $.fs.exists(pidPath))) {
    pid = Number.parseInt((await $.fs.read(pidPath)).trim(), 10)
  }
  if (!(await isAlive($, pid))) return undefined
  // The PID may have been reused: check that it is this project's flutter run
  // (its command line contains the .state path).
  const ps = await $.process.run(['ps', '-p', String(pid), '-o', 'command='])
  return ps.stdout.includes(ctx.stateDir) ? pid : undefined
}

async function logTail($, ctx, from) {
  const path = `${ctx.stateDir}/flutter.log`
  if (!(await $.fs.exists(path))) return ''
  const argv = from === undefined ? ['tail', '-c', '20000', path] : ['tail', '-c', `+${from + 1}`, path]
  const read = await $.process.run(argv)
  return read.stdout.slice(-20000)
}

async function logSize($, ctx) {
  const path = `${ctx.stateDir}/flutter.log`
  if (!(await $.fs.exists(path))) return 0
  return (await $.fs.stat(path)).size
}

// ---------- Flutter and the temporary app ----------

async function findFlutter($, root, home) {
  const pinned = `${root}/.fvm/flutter_sdk/bin/flutter`
  if (await $.fs.exists(pinned)) return pinned
  const cached = await $.store.get(flutterKey(root))
  if (typeof cached === 'string' && (await $.fs.exists(cached))) return cached
  const found = await searchFlutter($, home)
  if (found !== undefined) await $.store.set(flutterKey(root), found)
  return found
}

async function searchFlutter($, home) {
  const direct = await $.process.run(['/usr/bin/which', 'flutter']).catch(() => undefined)
  const onPath = direct !== undefined && direct.exitCode === 0 ? lastLine(direct.stdout) : ''
  if (onPath.startsWith('/')) return onPath
  const shell = (await $.env.get('SHELL')) || '/bin/zsh'
  const login = await $.process
    .run([shell, '-lic', 'command -v flutter'], { timeoutMs: 20000 })
    .catch(() => undefined)
  const viaShell = login !== undefined && login.exitCode === 0 ? lastLine(login.stdout) : ''
  if (viaShell.startsWith('/')) return viaShell
  const candidates = [
    `${home}/fvm/default/bin/flutter`,
    `${home}/flutter/bin/flutter`,
    `${home}/development/flutter/bin/flutter`,
    '/opt/homebrew/bin/flutter',
    '/usr/local/bin/flutter',
  ]
  for (const candidate of candidates) {
    if (await $.fs.exists(candidate)) return candidate
  }
  return undefined
}

async function listFiles($, base, rel) {
  const entries = await $.fs.list(rel === '' ? base : `${base}/${rel}`)
  const files = []
  for (const entry of entries) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.kind === 'dir') files.push(...(await listFiles($, base, path)))
    else if (entry.kind === 'file' && entry.name !== '.DS_Store') files.push(path)
  }
  return files
}

async function copyTemplates($, ctx, current) {
  const base = `${$.plugin.root}/templates`
  for (const rel of await listFiles($, base, '')) {
    const target = rel.replace(/\.tmpl$/, '')
    if (target === 'pubspec.yaml' || target.startsWith('fallback/')) continue
    const dest = `${ctx.appDir}/${target}`
    if (PROTECTED.test(target) && (await $.fs.exists(dest))) continue
    const source = await $.fs.read(`${base}/${rel}`)
    const text = rel.endsWith('.tmpl')
      ? fillPlaceholders(source, { PACKAGE: ctx.pkg, VERSION: current })
      : source
    await $.fs.write(dest, text)
  }
}

async function writeHostPubspec($, ctx, projectPubspec, hostSdk, current, frames) {
  const template = await $.fs.read(`${$.plugin.root}/templates/pubspec.yaml.tmpl`)
  const sdk = widerSdk(hostSdk, pubspecSdk(projectPubspec)) ?? '^3.0.0'
  const text = fillPlaceholders(template, {
    PACKAGE: ctx.pkg,
    PROJECT_ROOT: yamlQuote(ctx.root),
    SDK: yamlQuote(sdk),
    VERSION: current,
    DEVICE_FRAME: frames === 'device_frame' ? DEVICE_FRAME_DEPENDENCY : '',
  })
  await $.fs.write(`${ctx.appDir}/pubspec.yaml`, text)
  const source = await $.fs.read(`${$.plugin.root}/templates/${FRAMES_TEMPLATES[frames]}`)
  await $.fs.write(`${ctx.appDir}/lib/_host/frames.dart`, source)
}

async function pubGet($, ctx) {
  return $.process.run([ctx.flutter, 'pub', 'get'], { cwd: ctx.appDir, timeoutMs: LONG_MS })
}

async function disableSandbox($, ctx) {
  for (const name of ['DebugProfile', 'Release']) {
    const path = `${ctx.appDir}/macos/Runner/${name}.entitlements`
    if (!(await $.fs.exists(path))) continue
    const plist = await $.fs.read(path)
    const patched = withoutSandbox(plist)
    if (patched !== plist) await $.fs.write(path, patched)
  }
}

/** Creates or updates the temporary app; returns the failure reason or undefined. */
async function prepareHost($, ctx, projectPubspec) {
  const current = await pluginVersion($)
  const saved = await $.store.get(hostKey(ctx.root))
  const host = saved !== null && typeof saved === 'object' ? saved : {}
  let hostSdk = typeof host.sdk === 'string' ? host.sdk : undefined
  const hasRunner = await $.fs.exists(`${ctx.appDir}/macos/Runner.xcodeproj/project.pbxproj`)
  if (!hasRunner) {
    const created = await $.process.run(
      [ctx.flutter, 'create', '--platforms=macos', '--project-name', 'ui_variants_host',
        '--org', 'dev.uivariants', '--no-pub', ctx.appDir],
      { timeoutMs: LONG_MS },
    )
    if (created.exitCode !== 0) {
      return `flutter create: ${flutterError(created.stdout + created.stderr) ?? lastLine(created.stderr || created.stdout)}`
    }
    hostSdk = pubspecSdk(await $.fs.read(`${ctx.appDir}/pubspec.yaml`))
    // Leftovers of the flutter create template: the MyApp test and IDE files.
    await $.process.run(['rm', '-rf', 'test', '.idea', 'ui_variants_host.iml', 'README.md'], { cwd: ctx.appDir })
  }
  const hasHost = await $.fs.exists(`${ctx.appDir}/lib/_host/version.dart`)
  const isOutdated = !hasRunner || !hasHost || typeof host.version !== 'string' ||
    compareVersions(host.version, current) < 0
  if (isOutdated) {
    await copyTemplates($, ctx, current)
    await disableSandbox($, ctx)
  }
  const pubspecMtime = (await $.fs.stat(`${ctx.root}/pubspec.yaml`)).mtimeMs
  const hasPackages = await $.fs.exists(`${ctx.appDir}/.dart_tool/package_config.json`)
  if (isOutdated || host.pubspecMtime !== pubspecMtime || !hasPackages) {
    await writeHostPubspec($, ctx, projectPubspec, hostSdk, current, 'device_frame')
    let pub = await pubGet($, ctx)
    if (pub.exitCode !== 0) {
      // device_frame is incompatible with the project's dependencies: built-in frames.
      const reason = flutterError(`${pub.stdout}\n${pub.stderr}`) ?? lastLine(pub.stderr || pub.stdout)
      await logError($, ctx, `device_frame does not fit, using built-in frames: ${reason}`)
      await writeHostPubspec($, ctx, projectPubspec, hostSdk, current, 'builtin')
      pub = await pubGet($, ctx)
    }
    if (pub.exitCode !== 0) {
      await $.store.set(hostKey(ctx.root), { version: current, sdk: hostSdk, pubspecMtime: 0 })
      const output = `${pub.stdout}\n${pub.stderr}`
      const solving = output.split('\n').find(line => /version solving failed|Because /.test(line))
      return `flutter pub get: ${solving?.trim() ?? flutterError(output) ?? lastLine(output)}`
    }
  }
  await $.store.set(hostKey(ctx.root), { version: current, sdk: hostSdk, pubspecMtime })
  return undefined
}

// ---------- Activation ----------

async function readDecision($, ctx) {
  const path = `${ctx.stateDir}/decision.json`
  if (!(await $.fs.exists(path))) return undefined
  return parseDecision(await $.fs.read(path))
}

async function pruneStore($, now) {
  for (const key of await $.store.keys()) {
    if (key.startsWith('alive|') && now - Number(await $.store.get(key)) > ALIVE_TTL_MS) {
      await $.store.delete(key)
      continue
    }
    if (!key.startsWith('active|')) continue
    const value = await $.store.get(key)
    const at = value !== null && typeof value === 'object' ? Number(value.at) : 0
    if (now - at > STORE_TTL_MS) {
      await $.store.delete(key)
      await $.store.delete(`seen|${key.slice('active|'.length)}`)
    }
  }
}

async function activate($, ctx) {
  const now = await $.clock.now()
  const isSameProject = active !== null && active.root === ctx.root
  active = ctx
  await $.store.set(activeKey(ctx.root, ctx.sessionId), {
    appDir: ctx.appDir,
    stateDir: ctx.stateDir,
    pkg: ctx.pkg,
    flutter: ctx.flutter,
    at: now,
  })
  await $.store.set(ownerKey(ctx.root), { sessionId: ctx.sessionId, beatAt: now })
  ownerBeatAt = now
  await markAlive($, ctx, now)
  const previous = await $.store.get(seenKey(ctx.root, ctx.sessionId))
  if (!isSameProject || previous === undefined) {
    // A decision already in the file before the skill loaded never starts a
    // turn: choices are accepted only while the session watches the window.
    const decision = await readDecision($, ctx)
    seen = { choice: choiceSignature(decision), notes: notesSignature(decision) }
    if (decision !== undefined && decision.requests.length > 0) {
      const sent = await sentRequests($, ctx)
      const ids = decision.requests.map(request => request.id).filter(id => !sent.includes(id))
      await $.store.set(requestedKey(ctx.root), [...sent, ...ids].slice(-200))
    }
    await $.store.set(seenKey(ctx.root, ctx.sessionId), seen)
  }
  if (!isSameProject) lastFingerprint = await hostFingerprint($, ctx).catch(() => '')
  await pruneStore($, now)
  startWatch($)
}

async function deactivate($, ctx) {
  if (active !== null && active.root === ctx.root) {
    stopWatch()
    resetState()
  }
  await $.store.delete(activeKey(ctx.root, ctx.sessionId))
  await $.store.delete(seenKey(ctx.root, ctx.sessionId))
  await $.store.delete(aliveKey(ctx.root, ctx.sessionId))
  const owner = await $.store.get(ownerKey(ctx.root))
  if (owner !== null && typeof owner === 'object' && owner.sessionId === ctx.sessionId) {
    await $.store.delete(ownerKey(ctx.root))
  }
}

async function restore($) {
  const root = await $.session.root()
  const sessionId = await $.session.id()
  const saved = await $.store.get(activeKey(root, sessionId))
  if (saved === null || typeof saved !== 'object' || typeof saved.appDir !== 'string') return
  active = {
    root,
    sessionId,
    appDir: saved.appDir,
    stateDir: saved.stateDir,
    pkg: saved.pkg,
    flutter: saved.flutter,
  }
  const previous = await $.store.get(seenKey(root, sessionId))
  if (previous !== null && typeof previous === 'object') {
    seen = { choice: previous.choice ?? undefined, notes: previous.notes ?? '' }
  }
  const win = await $.store.get(windowKey(root))
  if (win !== null && typeof win === 'object' && win.pid === undefined && Number.isInteger(win.launcherPid)) {
    launching = { pid: win.launcherPid, startedAt: win.startedAt }
  }
  lastFingerprint = await hostFingerprint($, active).catch(() => '')
  startWatch($)
}

async function answerSkill($, text) {
  const command = parseArgs(text).toLowerCase()
  const root = await $.session.root()
  const pubspecPath = `${root}/pubspec.yaml`
  const pubspec = (await $.fs.exists(pubspecPath)) ? await $.fs.read(pubspecPath) : ''
  const pkg = pubspecName(pubspec)
  if (!isFlutterPubspec(pubspec) || pkg === undefined) return NOT_FLUTTER
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') throw new Error('HOME is not set')
  const sessionId = await $.session.id()
  const ctx = { root, sessionId, pkg, flutter: '', ...hostPaths(root, pkg, home) }

  if (command === 'close') {
    return (await closeWindow($, ctx)) ? 'The picker window is closed.' : 'The picker window was not open.'
  }
  if (command === 'clean') {
    await closeWindow($, ctx)
    await deactivate($, ctx)
    await $.process.run(['rm', '-rf', ctx.appDir])
    await $.store.delete(hostKey(root))
    return 'The picker window is closed and the temporary app is deleted.'
  }

  const flutter = await findFlutter($, root, home)
  if (flutter === undefined) return unavailableSkill(text, ctx, 'the flutter command was not found')
  ctx.flutter = flutter
  const failure = await prepareHost($, ctx, pubspec)
  if (failure !== undefined) {
    await logError($, ctx, failure)
    return unavailableSkill(text, ctx, failure)
  }
  await activate($, ctx)
  return fillSkill(text, ctx)
}

// ---------- Window ----------

/** Closes the project's window and its flutter run; returns whether anything was open. */
async function closeWindow($, ctx) {
  const pids = new Set()
  const saved = await $.store.get(windowKey(ctx.root))
  if (saved !== null && typeof saved === 'object') {
    pids.add(saved.pid)
    pids.add(saved.launcherPid)
  }
  if (launching !== null && active !== null && active.root === ctx.root) pids.add(launching.pid)
  const pidPath = `${ctx.stateDir}/flutter.pid`
  if (await $.fs.exists(pidPath)) pids.add(Number.parseInt((await $.fs.read(pidPath)).trim(), 10))
  const list = [...pids].filter(pid => Number.isInteger(pid) && pid > 0)
  // The app is closed even when it outlived its flutter run.
  const stopped = await $.process.run(['/bin/sh', '-c', STOP_SCRIPT], {
    env: { UIV_PIDS: list.join(' '), UIV_STATE: ctx.stateDir, UIV_APP_BUNDLE: appBundle(ctx) },
    timeoutMs: 5000,
  })
  await $.store.delete(windowKey(ctx.root))
  if (active !== null && active.root === ctx.root) {
    launching = null
    pendingRestart = false
    restartCheck = null
  }
  return lastLine(stopped.stdout) === '1'
}

/** Whether another live session watches the project (its mark is newer than OWNER_STALE_MS). */
async function hasOtherWatchers($, ctx, now) {
  const prefix = `alive|${ctx.root}|`
  const mine = aliveKey(ctx.root, ctx.sessionId)
  for (const key of await $.store.keys()) {
    if (!key.startsWith(prefix) || key === mine) continue
    if (now - Number(await $.store.get(key)) < OWNER_STALE_MS) return true
  }
  return false
}

async function launchWindow($, ctx) {
  const stream = $.process.spawn({
    argv: ['/bin/sh', '-c', LAUNCH_SCRIPT],
    cwd: ctx.appDir,
    env: {
      UIV_FLUTTER: ctx.flutter,
      UIV_STATE: ctx.stateDir,
      UIV_PACKAGE: ctx.pkg,
      UIV_APP_BUNDLE: appBundle(ctx),
    },
  })
  let output = ''
  for await (const piece of stream) {
    if (piece.stream === 'stdout') output += piece.text
  }
  const pid = Number.parseInt(lastLine(output), 10)
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`flutter run did not start: ${lastLine(output) || 'no PID'}`)
  const now = await $.clock.now()
  launching = { pid, startedAt: now }
  await $.store.set(windowKey(ctx.root), { launcherPid: pid, startedAt: now })
  $.ui.toast('Opening the variants window…')
}

async function hotRestart($, ctx, pid, isAnnounced) {
  const offset = await logSize($, ctx)
  const sent = await $.process.run(['kill', '-USR2', String(pid)])
  if (sent.exitCode !== 0) return false
  restartCheck = { offset, at: await $.clock.now() }
  if (isAnnounced) $.ui.toast('Variants window updated')
  return true
}

/** Opens the window or refreshes it with a hot restart. */
async function refreshWindow($) {
  const ctx = active
  if (ctx === null) return
  try {
    const pid = await windowPid($, ctx)
    if (pid !== undefined && (await hotRestart($, ctx, pid, true))) return
    if (launching !== null && (await isAlive($, launching.pid))) {
      // The window is still building: refresh it as soon as it opens.
      pendingRestart = true
      return
    }
    await launchWindow($, ctx)
    startWatch($)
  } catch (error) {
    $.ui.toast(`The variants window did not open: ${message(error)}`, { timeoutMs: 10000 })
    await logError($, ctx, `window launch: ${message(error)}`)
  }
}

// ---------- Watching ----------

/**
 * The session's liveness mark: in $.store (other sessions use it to decide
 * whether to close the window) and in .state/heartbeat.json (without a fresh one
 * for over a minute the window closes itself, if the session died before
 * session.end).
 */
async function markAlive($, ctx, now) {
  await $.store.set(aliveKey(ctx.root, ctx.sessionId), now)
  await $.fs.write(`${ctx.stateDir}/heartbeat.json`, JSON.stringify({ at: now, sessionId: ctx.sessionId }))
}

async function beat($, ctx) {
  const now = await $.clock.now()
  if (now - ownerBeatAt < OWNER_BEAT_MS) return
  ownerBeatAt = now
  await markAlive($, ctx, now)
  const owner = await $.store.get(ownerKey(ctx.root))
  const isFree = owner === null || typeof owner !== 'object' ||
    owner.sessionId === ctx.sessionId || now - Number(owner.beatAt ?? 0) > OWNER_STALE_MS
  if (isFree) await $.store.set(ownerKey(ctx.root), { sessionId: ctx.sessionId, beatAt: now })
}

async function trackLaunch($, ctx) {
  if (launching === null) return
  const pidPath = `${ctx.stateDir}/flutter.pid`
  if (await $.fs.exists(pidPath)) {
    const pid = Number.parseInt((await $.fs.read(pidPath)).trim(), 10)
    if (Number.isInteger(pid) && pid > 0) {
      const startedAt = launching.startedAt
      launching = null
      await $.store.set(windowKey(ctx.root), { pid, startedAt })
      $.ui.toast('Variants window is open')
      if (pendingRestart) {
        pendingRestart = false
        await hotRestart($, ctx, pid, false)
      }
      return
    }
  }
  if (await isAlive($, launching.pid)) return
  launching = null
  pendingRestart = false
  await $.store.delete(windowKey(ctx.root))
  const log = await logTail($, ctx)
  const reason = flutterError(log) ?? (lastLine(log) || 'flutter run exited')
  $.ui.toast(`The variants window did not open: ${reason}`, { timeoutMs: 10000 })
  await logError($, ctx, `flutter run: ${reason} (full output: ${ctx.stateDir}/flutter.log)`)
}

async function checkRestart($, ctx) {
  if (restartCheck === null) return
  const now = await $.clock.now()
  if (now - restartCheck.at < RESTART_CHECK_MS) return
  const log = await logTail($, ctx, restartCheck.offset)
  const error = flutterError(log)
  if (error !== undefined) {
    restartCheck = null
    $.ui.toast(`Variants error: ${error}`, { timeoutMs: 10000 })
    await logError($, ctx, `hot restart: ${error}`)
    return
  }
  if (/Restarted application|Hot restart performed/i.test(log) || now - restartCheck.at > RESTART_GIVE_UP_MS) {
    restartCheck = null
  }
}

/** The answer to the window: the choice was sent, or was sent before. */
async function writeAck($, ctx, decision, status) {
  const at = new Date(await $.clock.now()).toISOString()
  const ack = { round: decision.round, chosen: decision.chosen, chosenAt: decision.chosenAt, status, at }
  await $.fs.write(`${ctx.stateDir}/ack.json`, JSON.stringify(ack))
}

/** This session owns the project: it sends choices and revisions. */
async function isOwner($, ctx) {
  const now = await $.clock.now()
  const owner = await $.store.get(ownerKey(ctx.root))
  return owner === null || typeof owner !== 'object' ||
    owner.sessionId === ctx.sessionId || now - Number(owner.beatAt ?? 0) > OWNER_STALE_MS
}

async function sentRequests($, ctx) {
  const value = await $.store.get(requestedKey(ctx.root))
  return Array.isArray(value) ? value.filter(id => typeof id === 'string') : []
}

/**
 * Variant revisions from the window: new ones go to Claude at once, in one
 * message, without a choice. The window learns they were sent from
 * requests-ack.json.
 */
async function submitRevisions($, ctx, decision) {
  if (decision.requests.length === 0) return
  const sent = await sentRequests($, ctx)
  const fresh = decision.requests.filter(request => !sent.includes(request.id))
  if (fresh.length === 0 || !(await isOwner($, ctx))) return
  const all = [...sent, ...fresh.map(request => request.id)].slice(-200)
  await $.store.set(requestedKey(ctx.root), all)
  $.ui.toast(fresh.length === 1
    ? `Revision sent to Claude: ${noteLine(fresh[0], 80)}`
    : `Revisions sent to Claude: ${fresh.length}`)
  const text = revisionPrompt(fresh, `${ctx.appDir}/lib/variants`)
  $.prompt.submit({ text }).catch(error => void logError($, ctx, `sending a revision: ${message(error)}`))
  const ids = decision.requests.map(request => request.id).filter(id => all.includes(id))
  await $.fs.write(`${ctx.stateDir}/requests-ack.json`, JSON.stringify({ sent: ids }))
}

async function submitChoice($, ctx, decision) {
  if (!(await isOwner($, ctx))) return
  // Several sessions may watch the project and Choose may be pressed again:
  // the same choice is sent once.
  const signature = sendSignature(decision)
  if ((await $.store.get(submittedKey(ctx.root))) === signature) {
    $.ui.toast('This choice was already sent')
    await writeAck($, ctx, decision, 'duplicate')
  } else {
    await $.store.set(submittedKey(ctx.root), signature)
    const many = decisionChoices(decision).length > 1
    $.ui.toast(`${many ? 'Chosen variants' : 'Chosen variant'}: ${decision.chosenTitle || decision.chosen}`)
    const text = choicePrompt(decision, `${ctx.stateDir}/decision.json`)
    $.prompt.submit({ text }).catch(error => void logError($, ctx, `sending the choice: ${message(error)}`))
    await writeAck($, ctx, decision, 'sent')
  }
  // The choice is made, so the window has no reason to stay. The pause lets it
  // show that Claude got the choice. New variants open the window again.
  if (closeTimer !== null) closeTimer.cancel()
  closeTimer = $.clock.after(CLOSE_AFTER_CHOICE_MS, () => void closeAfterChoice($, ctx))
}

async function closeAfterChoice($, ctx) {
  closeTimer = null
  if (active === null || active.root !== ctx.root) return
  try {
    await closeWindow($, ctx)
  } catch (error) {
    await logError($, ctx, `closing the window after the choice: ${message(error)}`)
  }
}

async function checkDecision($, ctx) {
  const path = `${ctx.stateDir}/decision.json`
  if (!(await $.fs.exists(path))) return
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.mtimeMs === decisionMtime) return
  const decision = parseDecision(await $.fs.read(path).catch(() => ''))
  if (decision === undefined) return
  decisionMtime = stat.mtimeMs
  await submitRevisions($, ctx, decision)
  const choice = choiceSignature(decision)
  const notes = notesSignature(decision)
  if (choice !== undefined && choice !== seen.choice) {
    seen = { choice, notes }
    await $.store.set(seenKey(ctx.root, ctx.sessionId), seen)
    await submitChoice($, ctx, decision)
    return
  }
  if (notes !== seen.notes) {
    seen = { choice: seen.choice, notes }
    await $.store.set(seenKey(ctx.root, ctx.sessionId), seen)
    const last = decision.notes[decision.notes.length - 1]
    if (last !== undefined) $.ui.toast(`Note saved: ${noteLine(last, 100)}`)
  }
}

async function tick($) {
  const ctx = active
  if (ctx === null || isTicking) return
  isTicking = true
  try {
    await beat($, ctx)
    await trackLaunch($, ctx)
    await checkRestart($, ctx)
    await checkDecision($, ctx)
  } catch (error) {
    await logError($, ctx, `watching: ${message(error)}`).catch(() => undefined)
  } finally {
    isTicking = false
  }
}

// ---------- Hooks ----------

/** @type {import('claude-code').Register} */
export const register = on => {
  on('session.start', async ($, e, next) => {
    // After a mod reload the old timers are cancelled and activity is restored
    // if the skill was already loaded in this session.
    stopWatch()
    resetState()
    const started = await next(e)
    await restore($).catch(() => undefined)
    return started
  })

  on('session.end', async ($, e, next) => {
    if (active === null) return next(e)
    const ctx = active
    stopWatch()
    try {
      const now = await $.clock.now()
      await $.store.delete(aliveKey(ctx.root, ctx.sessionId))
      const owner = await $.store.get(ownerKey(ctx.root))
      if (owner !== null && typeof owner === 'object' && owner.sessionId === ctx.sessionId) {
        await $.store.delete(ownerKey(ctx.root))
      }
      if (e.reason === 'clear') await $.store.delete(activeKey(ctx.root, ctx.sessionId))
      // The window closes with the session (and on /clear) unless another live
      // session watches the project: then the window stays for it.
      if (!(await hasOtherWatchers($, ctx, now))) await closeWindow($, ctx)
    } catch {
      // The session is ending anyway: errors here do not matter.
    }
    resetState()
    return next(e)
  })

  on('skill.prompt', { skill: ['ui-variants', 'ui-variants:ui-variants'] }, async ($, e, next) => {
    const expanded = await next(e)
    try {
      return { text: await answerSkill($, expanded.text) }
    } catch (error) {
      $.ui.log(`ui-variants: ${message(error)}`, { to: 'debug' })
      return {
        text: `${expanded.text}\n\nIMPORTANT: the picker window is not available right now (${message(error)}). ` +
          'Describe the variants in text in your reply.',
      }
    }
  })

  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    if (active === null) return next(e)
    const ctx = active
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true && touchesHost(e, ctx.appDir)) {
      needsRefresh = true
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (active === null || e.agentId !== undefined) return next(e)
    const fingerprint = await hostFingerprint($, active).catch(() => lastFingerprint)
    if (!needsRefresh && fingerprint === lastFingerprint) return next(e)
    needsRefresh = false
    lastFingerprint = fingerprint
    $.clock.after(0, () => void refreshWindow($))
    startWatch($)
    return next(e)
  })
}

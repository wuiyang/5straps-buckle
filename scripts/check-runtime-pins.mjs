// Fails when @5straps/runtime or Buckle drifts from the reviewed Nitro, H3 and DB0 pins (Foundation gate F57).
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntryPoint } from './entry-point.mjs'

export const RUNTIME_PINS = Object.freeze({ nitro: '3.0.260903-beta', h3: '2.0.1-rc.32', db0: '0.4.1' })
const PEER_ONLY = ['nitro', 'h3']
const FORBIDDEN = ['better-sqlite3']
const RUNTIME_IMPORTER = 'packages/runtime'
// Buckle builds with nitro and srvx (development only) and serves through h3 at run time, one copy
// shared with @5straps/runtime/nitro (Buckle phase plan, section B).
const BUCKLE_IMPORTER = 'buckle'
const BUCKLE_BUILD_ONLY = ['nitro', 'srvx']

export function checkRuntimePins({ root }) {
  const manifest = JSON.parse(readFileSync(join(root, RUNTIME_IMPORTER, 'package.json'), 'utf8'))
  const buckle = JSON.parse(readFileSync(join(root, BUCKLE_IMPORTER, 'package.json'), 'utf8'))
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  return [
    ...checkManifest(manifest),
    ...checkBuckleManifest({ buckle, runtime: manifest }),
    ...checkOverrides(rootManifest),
    ...checkLockfile(lock),
    ...checkBuckleLockfile(lock),
  ]
}

function checkManifest(manifest) {
  const problems = []
  const declared = { ...manifest.dependencies, ...manifest.devDependencies }
  for (const [name, pin] of Object.entries(RUNTIME_PINS)) {
    if (declared[name] !== pin) problems.push(`${name} must be declared exactly as ${pin}, found ${declared[name] ?? 'nothing'}`)
  }
  for (const name of PEER_ONLY) {
    if (manifest.peerDependencies?.[name] !== RUNTIME_PINS[name]) problems.push(`${name} peer must be exactly ${RUNTIME_PINS[name]}`)
    if (manifest.peerDependenciesMeta?.[name]?.optional !== true) problems.push(`${name} peer must be optional`)
    if (manifest.dependencies?.[name]) problems.push(`${name} must not be a production dependency`)
  }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of FORBIDDEN) if (manifest[section]?.[name]) problems.push(`${name} is not allowed in ${section}; the runtime uses node:sqlite`)
  }
  return problems
}

function checkBuckleManifest({ buckle, runtime }) {
  const problems = []
  if (buckle.dependencies?.h3 !== RUNTIME_PINS.h3) problems.push(`${BUCKLE_IMPORTER}: h3 must be a production dependency pinned exactly to ${RUNTIME_PINS.h3}, found ${buckle.dependencies?.h3 ?? 'nothing'}`)
  const buildPins = { nitro: RUNTIME_PINS.nitro, srvx: runtime.devDependencies?.srvx }
  for (const name of BUCKLE_BUILD_ONLY) {
    if (buckle.devDependencies?.[name] !== buildPins[name]) problems.push(`${BUCKLE_IMPORTER}: ${name} must be a devDependency pinned exactly to ${buildPins[name]}, found ${buckle.devDependencies?.[name] ?? 'nothing'}`)
    if (buckle.dependencies?.[name]) problems.push(`${BUCKLE_IMPORTER}: ${name} builds .output and must not be a production dependency`)
  }
  return problems
}

function checkOverrides(rootManifest) {
  const overrides = Object.keys(rootManifest.pnpm?.overrides ?? {})
  return overrides
    .filter(key => Object.keys(RUNTIME_PINS).some(name => key === name || key.endsWith(`>${name}`) || key.startsWith(`${name}@`)))
    .map(key => `root pnpm.overrides must not pin ${key}; framework versions stay package-local`)
}

function checkLockfile(lock) {
  const importer = lockSection(lock, 'importers:', `  ${RUNTIME_IMPORTER}:`)
  if (!importer) return [`pnpm-lock.yaml has no ${RUNTIME_IMPORTER} importer; run pnpm install`]
  const problems = []
  for (const [name, pin] of Object.entries(RUNTIME_PINS)) {
    const version = importerVersion(importer, name)
    if (version !== pin) problems.push(`lockfile resolves ${name} to ${version ?? 'nothing'}, expected ${pin}`)
  }
  const nitro = lockSection(lock, 'snapshots:', `  nitro@${RUNTIME_PINS.nitro}:`)
  for (const name of ['h3', 'db0']) {
    const version = nitroDependency(nitro, name)
    if (version !== RUNTIME_PINS[name]) problems.push(`nitro resolves ${name} to ${version ?? 'nothing'}, expected the shared ${RUNTIME_PINS[name]} instance`)
  }
  // The real-hook tests import hookable directly; they only prove Nitro's behaviour on Nitro's own copy.
  const testHookable = importerVersion(importer, 'hookable')
  const nitroHookable = nitroDependency(nitro, 'hookable')
  if (!testHookable || testHookable !== nitroHookable) problems.push(`runtime tests use hookable ${testHookable ?? 'nothing'} but nitro resolves ${nitroHookable ?? 'nothing'}; declare the same version`)
  return problems
}

function checkBuckleLockfile(lock) {
  const importer = lockSection(lock, 'importers:', `  ${BUCKLE_IMPORTER}:`)
  if (!importer) return [`pnpm-lock.yaml has no ${BUCKLE_IMPORTER} importer; run pnpm install`]
  const problems = []
  for (const name of ['nitro', 'h3']) {
    const version = importerVersion(importer, name)
    if (version !== RUNTIME_PINS[name]) problems.push(`lockfile resolves ${BUCKLE_IMPORTER} ${name} to ${version ?? 'nothing'}, expected ${RUNTIME_PINS[name]}`)
  }
  // One h3 instance: the peer context Buckle resolves must be the one nitro and the runtime share.
  const runtimeH3 = fullImporterVersion(lockSection(lock, 'importers:', `  ${RUNTIME_IMPORTER}:`), 'h3')
  if (fullImporterVersion(importer, 'h3') !== runtimeH3) problems.push(`${BUCKLE_IMPORTER} resolves h3 as ${fullImporterVersion(importer, 'h3') ?? 'nothing'}, not the runtime's ${runtimeH3 ?? 'nothing'}; one copy is required`)
  return problems
}

function importerVersion(importer, name) {
  return fullImporterVersion(importer, name)?.split('(')[0]
}

function fullImporterVersion(importer, name) {
  return /^\s+version: (\S+)/m.exec((importer ?? '').split(new RegExp(`^ {6}'?${name}'?:$`, 'm'))[1] ?? '')?.[1]
}

function nitroDependency(nitro, name) {
  return new RegExp(`^ {6}${name}: (\\S+)`, 'm').exec(nitro ?? '')?.[1]?.split('(')[0]
}

function lockSection(lock, topLevel, heading) {
  const top = lock.indexOf(`\n${topLevel}\n`)
  if (top < 0) return undefined
  const start = lock.indexOf(`\n${heading}\n`, top)
  if (start < 0) return undefined
  const rest = lock.slice(start + heading.length + 2)
  const end = rest.search(/^\S|^ {2}\S/m)
  return end < 0 ? rest : rest.slice(0, end)
}

if (isEntryPoint(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const problems = checkRuntimePins({ root })
  if (problems.length > 0) {
    process.stderr.write(`Runtime pin check failed:\n${problems.map(problem => `- ${problem}`).join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`Runtime pins verified: ${Object.entries(RUNTIME_PINS).map(([name, pin]) => `${name} ${pin}`).join(', ')}\n`)
  }
}

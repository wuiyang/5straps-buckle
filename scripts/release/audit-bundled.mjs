// Plan section G, the audit gap: `pnpm audit --prod` sees Buckle's production dependencies, but not
// what the Nitro build bundled into .output from its build-time dependencies. The build records those
// as package@version (.output/bundled-packages.json); this audits every dependency and fails on any
// advisory for a bundled package at its bundled version.
//   node scripts/release/audit-bundled.mjs [--bundled <file>]... [--audit <pnpm audit --json output> [--audit-exit-code <n>]]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_BUNDLED = [join(repository, 'buckle', '.output', 'bundled-packages.json')]

/**
 * The advisories that name a bundled package at a bundled version. `audit` is `pnpm audit --json`
 * output (the npm v6 shape: advisories keyed by id, each with the versions found in the lockfile).
 */
export function bundledAdvisories({ audit, bundled }) {
  const wanted = new Set(bundled)
  return Object.values(audit.advisories).flatMap(advisory => (advisory.findings ?? [])
    .map(finding => `${advisory.module_name}@${finding.version}`)
    .filter(found => wanted.has(found))
    .map(found => ({ package: found, id: advisory.id, severity: advisory.severity, title: advisory.title, url: advisory.url })))
}

/** The bundled lists, each a JSON array of package@version the build wrote. */
export function readBundled(files) {
  return files.flatMap((file) => {
    if (!existsSync(file)) throw new Error(`${file} is missing: build the server first (pnpm --filter @5straps/buckle build)`)
    const list = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(list) || !list.every(item => typeof item === 'string' && /^(?:@[^/@]+\/)?[^/@]+@[^@]+$/.test(item))) throw new Error(`${file} is not a list of package@version`)
    return list
  })
}

/**
 * The audit as pnpm answered it, refused unless it is a real answer (review M7 of B20-B22): an `error`
 * key, or no `advisories` and `metadata` objects, means the audit itself failed, never that nothing
 * was found; and pnpm exits non-zero only when it found advisories, so a non-zero exit with none is a
 * failure too.
 */
export function checkedAudit({ output, exitCode = 0 }) {
  let audit
  try {
    audit = JSON.parse(output)
  } catch {
    throw new Error('pnpm audit did not answer JSON')
  }
  const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!isObject(audit)) throw new Error('pnpm audit answered something other than an object')
  if ('error' in audit) throw new Error(`pnpm audit failed: ${JSON.stringify(audit.error).slice(0, 300)}`)
  if (!isObject(audit.advisories) || !isObject(audit.metadata)) throw new Error('pnpm audit answered without its advisories and metadata')
  if (exitCode !== 0 && Object.keys(audit.advisories).length === 0) throw new Error(`pnpm audit exited ${exitCode} without naming an advisory`)
  return audit
}

/** Every dependency, dev ones included: that is where the bundled packages come from. pnpm exits non-zero when it finds any. */
function runAudit() {
  try {
    return { output: execFileSync('pnpm', ['audit', '--json'], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }), exitCode: 0 }
  } catch (error) {
    if (typeof error.stdout === 'string' && typeof error.status === 'number') return { output: error.stdout, exitCode: error.status }
    throw error
  }
}

function main() {
  const { values } = parseArgs({ options: { bundled: { type: 'string', multiple: true }, audit: { type: 'string' }, 'audit-exit-code': { type: 'string' } } })
  const bundled = readBundled(values.bundled ?? DEFAULT_BUNDLED)
  let audit
  try {
    audit = checkedAudit(values.audit ? { output: readFileSync(values.audit, 'utf8'), exitCode: Number(values['audit-exit-code'] ?? 0) } : runAudit())
  } catch (error) {
    process.stderr.write(`Bundled-package audit refused: ${error.message}\n`)
    return 1
  }
  const found = bundledAdvisories({ audit, bundled })
  if (found.length === 0) {
    process.stdout.write(`Bundled packages audited: ${bundled.length} (${bundled.join(', ')}), no advisory.\n`)
    return 0
  }
  for (const item of found) process.stderr.write(`${item.package} is bundled into .output and has advisory ${item.id} (${item.severity}): ${item.title} ${item.url ?? ''}\n`)
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()

// Plan section G, the audit gap: `pnpm audit --prod` sees Buckle's production dependencies, but not
// what the Nitro build bundled into .output from its build-time dependencies. The build records those
// as package@version (.output/bundled-packages.json); this audits every dependency and fails on any
// advisory for a bundled package at its bundled version.
//   node scripts/release/audit-bundled.mjs [--bundled <file>]... [--audit <pnpm audit --json output>]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_BUNDLED = [join(repository, 'harness-rpc', '.output', 'bundled-packages.json')]

/**
 * The advisories that name a bundled package at a bundled version. `audit` is `pnpm audit --json`
 * output (the npm v6 shape: advisories keyed by id, each with the versions found in the lockfile).
 */
export function bundledAdvisories({ audit, bundled }) {
  const wanted = new Set(bundled)
  return Object.values(audit.advisories ?? {}).flatMap(advisory => (advisory.findings ?? [])
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

/** Every dependency, dev ones included: that is where the bundled packages come from. pnpm exits non-zero when it finds any. */
function runAudit() {
  try {
    return execFileSync('pnpm', ['audit', '--json'], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] })
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) return error.stdout
    throw error
  }
}

function main() {
  const { values } = parseArgs({ options: { bundled: { type: 'string', multiple: true }, audit: { type: 'string' } } })
  const bundled = readBundled(values.bundled ?? DEFAULT_BUNDLED)
  const audit = JSON.parse(values.audit ? readFileSync(values.audit, 'utf8') : runAudit())
  const found = bundledAdvisories({ audit, bundled })
  if (found.length === 0) {
    process.stdout.write(`Bundled packages audited: ${bundled.length} (${bundled.join(', ')}), no advisory.\n`)
    return 0
  }
  for (const item of found) process.stderr.write(`${item.package} is bundled into .output and has advisory ${item.id} (${item.severity}): ${item.title} ${item.url ?? ''}\n`)
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()

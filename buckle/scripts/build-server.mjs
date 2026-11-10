// Builds the Nitro app (layers, custom entry, error handler) into .output, or --out-dir <dir>.
// --no-admin leaves the admin layer out, so that build serves no /setup route.
// The build cache goes under node_modules/.cache (or --build-dir), never into the source tree.
// It also writes .output/bundled-packages.json: package@version for every module the bundle took from
// node_modules, and for each package that generated code into it at build time, which `pnpm audit
// --prod` cannot see (plan section G; scripts/release/audit-bundled.mjs).
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'pathe'
import { parseArgs } from 'node:util'
import { build, copyPublicAssets, createNitro, prepare } from 'nitro/builder'

const { values } = parseArgs({ options: {
  root: { type: 'string', default: '.' },
  'out-dir': { type: 'string' },
  'build-dir': { type: 'string' },
  'no-admin': { type: 'boolean', default: false },
} })
const rootDir = resolve(values.root)
const outDir = resolve(values['out-dir'] ?? join(rootDir, '.output'))
// Read by nitro.config.ts; build-time only.
process.env.BUCKLE_BUILD_ADMIN_LAYER = values['no-admin'] ? 'false' : 'true'

// preset and baseURL are pinned so NITRO_PRESET or NITRO_APP_BASE_URL in the caller's shell cannot change the build.
const nitro = await createNitro({
  rootDir, dev: false, preset: 'node_middleware', baseURL: '/', logLevel: 1,
  buildDir: resolve(values['build-dir'] ?? join(rootDir, 'node_modules', '.cache', 'nitro')),
  output: { dir: outDir },
})
/**
 * Packages whose code lands in the bundle without being bundled as a module, resolved as nitro
 * resolves them: rou3 compiles the route table into the entry's findRoute (review, unverified item of
 * B20-B22). Listed so the bundled audit covers the code they wrote.
 */
const BUILD_TIME_GENERATORS = ['rou3']
const bundled = new Set()
nitro.hooks.hook('rollup:before', (_nitro, config) => { config.plugins.push(recordBundledPackages(bundled)) })
try {
  await prepare(nitro)
  await copyPublicAssets(nitro)
  await build(nitro)
} finally {
  await nitro.close()
}
for (const generator of BUILD_TIME_GENERATORS) bundled.add(packageOf(createRequire(import.meta.resolve('nitro/builder')).resolve(generator)))
writeFileSync(join(outDir, 'bundled-packages.json'), `${JSON.stringify([...bundled].sort(), null, 2)}\n`)

function recordBundledPackages(found) {
  return {
    name: 'buckle:bundled-packages',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const id of output.moduleIds) {
          const identified = packageOf(id)
          if (identified) found.add(identified)
        }
      }
    },
  }
}

function packageOf(id) {
  const path = id.replace(/^\0/, '').split('?')[0]
  const marker = '/node_modules/'
  const at = path.lastIndexOf(marker)
  if (at < 0) return null
  const [scope, name] = path.slice(at + marker.length).split('/')
  const packageName = scope.startsWith('@') ? `${scope}/${name}` : scope
  const manifest = JSON.parse(readFileSync(join(path.slice(0, at + marker.length), packageName, 'package.json'), 'utf8'))
  return `${manifest.name}@${manifest.version}`
}

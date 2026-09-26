// Fails when two Nitro route files claim the same path and method (layers.md, Security boundaries).
// Nitro 3.0.260903-beta keeps the first scanned handler and silently drops the rest, so a later
// layer could shadow, or be shadowed by, a security handler without any build error.
import { globSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROUTE_FILE = /\.(?:js|mjs|cjs|ts|mts|cts|tsx|jsx)$/
// Same suffix grammar as Nitro's scanServerRoutes at the pinned beta.
const SUFFIX = /(\.(?<method>connect|delete|get|head|options|patch|post|put|trace))?(\.(?<env>dev|prod|prerender))?$/
const ANY_METHOD = '*'

export async function findDuplicateRoutes({ rootDir }) {
  const nitro = await loadNitro(resolve(rootDir))
  try {
    const { scanDirs, apiDir, routesDir, apiBaseURL, ignore } = nitro.options
    const registrations = scanDirs.flatMap(dir => [
      ...scanRouteFiles({ dir, name: apiDir || 'api', prefix: apiBaseURL || '/api', ignore }),
      ...scanRouteFiles({ dir, name: routesDir || 'routes', prefix: '/', ignore }),
    ])
    return collisions(registrations)
  } finally {
    await nitro.close()
  }
}

async function loadNitro(rootDir) {
  const builderPath = createRequire(join(rootDir, 'package.json')).resolve('nitro/builder')
  const { createNitro } = await import(pathToFileURL(builderPath).href)
  return createNitro({ rootDir, dev: false, logLevel: 0 })
}

function scanRouteFiles({ dir, name, prefix, ignore }) {
  const base = join(dir, name)
  return globSync('**/*', { cwd: base, exclude: ignore ?? [] })
    .filter(path => ROUTE_FILE.test(path))
    .map(path => ({ ...routeFor(path, prefix), file: relative(process.cwd(), join(base, path)) }))
}

function routeFor(path, prefix) {
  let route = path.replace(/\.[A-Za-z]+$/, '')
    .replace(/\(([^(/\\]+)\)[/\\]/g, '')
    .replace(/\[\.{3}]/g, '**')
    .replace(/\[\.{3}([^\]]+)]/g, (_, param) => `**:${param.replace(/[^\w-]/g, '_')}`)
    .replace(/\[([^/\]]+)]/g, (_, param) => `:${param.replace(/[^\w-]/g, '_')}`)
  route = `/${[prefix, route].join('/').split('/').filter(Boolean).join('/')}`
  const suffix = SUFFIX.exec(route)
  const method = suffix?.groups?.method ?? ANY_METHOD
  const env = suffix?.groups?.env ?? ''
  route = route.slice(0, suffix?.index ?? route.length).replace(/\/index$/, '') || '/'
  // Parameter names do not change matching, so /a/:id and /a/:slug collide.
  return { route, pattern: route.replace(/:[\w-]+/g, ':'), method, env }
}

function collisions(registrations) {
  const problems = []
  for (const [index, first] of registrations.entries()) {
    for (const second of registrations.slice(index + 1)) {
      const sameEnv = first.env === '' || second.env === '' || first.env === second.env
      const sameMethod = first.method === ANY_METHOD || second.method === ANY_METHOD || first.method === second.method
      if (first.pattern === second.pattern && sameEnv && sameMethod) {
        problems.push({ route: first.route, method: first.method === ANY_METHOD ? second.method : first.method, files: [first.file, second.file] })
      }
    }
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = resolve(process.argv[2] ?? '.')
  const problems = await findDuplicateRoutes({ rootDir })
  if (problems.length > 0) {
    process.stderr.write(`Duplicate Nitro routes in ${rootDir}:\n${problems.map(item => `- ${item.method.toUpperCase()} ${item.route}: ${item.files.join(', ')}`).join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`No duplicate Nitro routes in ${rootDir}\n`)
  }
}

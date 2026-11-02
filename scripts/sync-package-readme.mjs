// Writes buckle/README.md from the root README.md, or with --check fails when the two have drifted.
// The root README links its pages relatively, which GitHub resolves. buckle/README.md ships in the npm
// package and renders on npmjs.com, where a repository-relative link breaks, so its copy points at the
// files on GitHub instead.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntryPoint } from './entry-point.mjs'

export const SOURCE = 'README.md'
export const TARGET = 'buckle/README.md'
export const BLOB_BASE = 'https://github.com/wuiyang/5straps-buckle/blob/main/'

const FENCE = /^\s*(?:```|~~~)/
const INLINE_LINK = /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g
// A scheme (https:, mailto:) or a bare #anchor is not a path in this repository.
const NOT_A_PATH = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i

/** Makes every relative markdown link target an absolute GitHub URL, keeping its #anchor. */
export function rewriteRelativeLinks(markdown) {
  let fenced = false
  return markdown
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced
        return line
      }
      return fenced ? line : line.replace(INLINE_LINK, (_, target, title) => `](${absoluteTarget(target)}${title})`)
    })
    .join('\n')
}

function absoluteTarget(target) {
  if (NOT_A_PATH.test(target)) return target
  const hash = target.indexOf('#')
  const path = hash < 0 ? target : target.slice(0, hash)
  const anchor = hash < 0 ? '' : target.slice(hash)
  const normalised = posix.normalize(path.replace(/^\/+/, ''))
  if (normalised === '..' || normalised.startsWith('../')) throw new Error(`The link ${target} points outside the repository`)
  return `${BLOB_BASE}${normalised}${anchor}`
}

export function generatePackageReadme({ root }) {
  return rewriteRelativeLinks(readFileSync(join(root, SOURCE), 'utf8'))
}

export function packageReadmeProblems({ root }) {
  const expected = generatePackageReadme({ root })
  const actual = readFileSync(join(root, TARGET), 'utf8')
  return actual === expected ? [] : [`${TARGET} differs from the text generated from ${SOURCE}; edit ${SOURCE} only, then run pnpm readme:sync and commit both files`]
}

if (isEntryPoint(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (process.argv.includes('--check')) {
    const problems = packageReadmeProblems({ root })
    if (problems.length > 0) {
      process.stderr.write(`Package readme check failed:\n${problems.map(problem => `- ${problem}`).join('\n')}\n`)
      process.exitCode = 1
    } else {
      process.stdout.write(`${TARGET} matches ${SOURCE}\n`)
    }
  } else {
    writeFileSync(join(root, TARGET), generatePackageReadme({ root }))
    process.stdout.write(`Wrote ${TARGET} from ${SOURCE}\n`)
  }
}

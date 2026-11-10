// The build stamp (Slice F2, item 0): the commit a build was made from, read from git at build time and written beside
// the build, so `buckle --version`, the serve log, and the manifest name it without a code change per release. A clean
// build of the release tag stamps nothing, so a package published from the tag shows the plain version.
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BUILD_INFO_FILE = 'build-info.json'
const COMMIT = /^[0-9a-f]{7,40}$/

/** The stamp for a build of `version` from the checkout at `cwd`, or null outside a git checkout and on a clean release tag. */
export function readBuildInfo({ cwd, version, now = () => new Date() }) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  let commit
  try { commit = git(['rev-parse', '--short=8', 'HEAD']).trim() } catch { return null }
  if (!COMMIT.test(commit)) return null
  const dirty = git(['status', '--porcelain']).trim() !== ''
  const tagged = git(['tag', '--points-at', 'HEAD']).split('\n').map(tag => tag.trim()).includes(`v${version}`)
  if (tagged && !dirty) return null
  return { commit, dirty, builtAt: now().toISOString() }
}

export function writeBuildInfo(outDir, info) {
  const file = join(outDir, BUILD_INFO_FILE)
  if (info === null) rmSync(file, { force: true })
  else writeFileSync(file, `${JSON.stringify(info)}\n`)
}

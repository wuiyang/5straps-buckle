import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpVersion, determineSemverChange, getGitDiff, loadChangelogConfig, parseCommits } from 'changelogen'
import { Refusal } from './command.mjs'
import { tagOf } from './packages.mjs'

export async function nextReleaseVersion({ previous, root }) {
  const config = await loadChangelogConfig(root, { from: tagOf(previous), to: 'HEAD' })
  const rawCommits = await getGitDiff(config.from, config.to, root)
  const commits = parseCommits(rawCommits, config).map(commit => ({ ...commit, type: commit.type.toLowerCase() }))
    .filter(commit => config.types[commit.type] && !(commit.type === 'chore' && commit.scope === 'deps' && !commit.isBreaking))
  return inferReleaseVersion({ previous, commits, config })
}

export async function inferReleaseVersion({ previous, commits, config }) {
  if (!determineSemverChange(commits, config)) throw new Refusal(`No releasable conventional commits since ${tagOf(previous)}; no release was prepared`)
  // changelogen bumps one manifest. Seed an isolated manifest with the three packages' shared version.
  const temporary = mkdtempSync(join(tmpdir(), 'buckle-release-version-'))
  try {
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ version: previous }))
    const version = await bumpVersion(commits, { ...config, cwd: temporary, newVersion: undefined })
    if (!version) throw new Refusal('changelogen could not infer a new release version')
    return version
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

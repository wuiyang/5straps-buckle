import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NODE_SETTINGS } from '../cli/node-settings.js'

// The repository's .env.example is the settings reference the README points to. Every BUCKLE_ variable the
// code reads appears in it, as a setting line or a commented-out one, and every BUCKLE_ name it mentions is
// one the code reads, so the example cannot drift from the code (public readiness review).

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLE = join(PACKAGE, '..', '.env.example')
// What `buckle` runs. Tests, build scripts and the Nitro build config read no settings.
const SOURCES = ['main.ts', 'cli', 'common', 'server', 'mcp', 'layers']
// Read from the environment, but set by Buckle itself for the git hook it runs (receive-pack-guard.ts).
const SET_BY_BUCKLE = ['BUCKLE_RECEIVE_REPOSITORY', 'BUCKLE_RECEIVE_GIT_DIRECTORY', 'BUCKLE_RECEIVE_REMEDY', 'BUCKLE_RECEIVE_NONCE']
// BUCKLE_ names in the sources that are not variables: a version constant, a pattern, and an error code.
const NOT_VARIABLES = ['BUCKLE_VERSION', 'BUCKLE_ASSIGNMENT', 'BUCKLE_SHUTTING_DOWN']

const NAME = /\b(BUCKLE_[A-Z0-9_]+)\b/g
// process.env.X, environment.X (a ProcessEnv parameter), and variables.X (a parsed environment file).
const PROPERTY_READ = /\b(?:process\.env|environment|variables)\??\.(BUCKLE_[A-Z0-9_]+)\b/g
const DESTRUCTURED_READ = /const\s*\{([^}]*)\}\s*=\s*process\.env\b/g
// A setting line, active or commented out.
const SETTING_LINE = /^#?[ \t]*(BUCKLE_[A-Z0-9_]+)=/gm

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return /\.(?:ts|mjs)$/.test(path) ? [path] : []
  return readdirSync(path).flatMap(name => sourceFiles(join(path, name)))
}

function names(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map(match => match[1]!)
}

const sources = SOURCES.flatMap(entry => sourceFiles(join(PACKAGE, entry))).map(file => readFileSync(file, 'utf8'))
const read = new Set([
  ...NODE_SETTINGS.map(setting => setting.key),
  ...sources.flatMap(text => names(text, PROPERTY_READ)),
  ...sources.flatMap(text => names(text, DESTRUCTURED_READ).flatMap(list => names(list, NAME))),
])
const settings = [...read].filter(name => !SET_BY_BUCKLE.includes(name)).sort()
const example = readFileSync(EXAMPLE, 'utf8')

describe('.env.example against the code', () => {
  it('has a setting line for every BUCKLE_ variable the code reads', () => {
    const lines = new Set(names(example, SETTING_LINE))
    expect(settings.filter(name => !lines.has(name))).toEqual([])
  })

  it('mentions no BUCKLE_ name the code does not read as a setting', () => {
    expect([...new Set(names(example, NAME))].filter(name => !settings.includes(name)).sort()).toEqual([])
  })

  it('sees every read: each BUCKLE_ name in the sources is one it found, or a known constant', () => {
    const mentioned = new Set(sources.flatMap(text => names(text, NAME)))
    expect([...mentioned].filter(name => !read.has(name) && !NOT_VARIABLES.includes(name)).sort()).toEqual([])
    expect(SET_BY_BUCKLE.filter(name => !read.has(name))).toEqual([])
    expect(NOT_VARIABLES.filter(name => !mentioned.has(name))).toEqual([])
    expect(settings.length).toBeGreaterThan(40)
  })
})

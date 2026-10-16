import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { nodeLocation } from '../common/runtime/environment.js'
import { addressOf, attachCommand } from '../common/services/node-service/attach.js'
import { parseServeOptions, useServiceLocation } from '../server/service-mode.js'

// Phase 3, item 1: `buckle serve` takes --background at a terminal, and what a service definition passes, which no
// terminal's serve takes; it refuses anything else rather than ignore it, as it ignored --background before.

describe('buckle serve\'s options', () => {
  it('reads a terminal\'s serve, --background, and what a service definition passes', () => {
    expect(parseServeOptions([])).toEqual({ help: false, background: false, service: null, location: {} })
    expect(parseServeOptions(['--background'])).toMatchObject({ background: true, service: null })
    expect(parseServeOptions(['--service', 'systemd', '--state-dir', '/srv/state', '--env-file', '/srv/node.env'])).toEqual({ help: false, background: false, service: 'systemd', location: { stateDirectory: '/srv/state', environmentFile: '/srv/node.env' } })
    expect(parseServeOptions(['--background', '--service', 'task-scheduler', '--state-dir', '/srv/state'])).toMatchObject({ background: true, service: 'task-scheduler' })
    // The macOS launchd agent (D85 Q4, owner ruling of 2026-10-17).
    expect(parseServeOptions(['--service', 'launchd', '--state-dir', '/Users/owner/.5straps/buckle'])).toEqual({ help: false, background: false, service: 'launchd', location: { stateDirectory: '/Users/owner/.5straps/buckle' } })
    expect(parseServeOptions(['-h']).help).toBe(true)
  })

  it.each([
    [['--bogus'], /Unknown option '--bogus'[\s\S]*Usage: buckle serve \[--background\]/],
    [['extra'], /Unexpected argument 'extra'[\s\S]*Usage: buckle serve/],
    [['--service', 'upstart'], /--service takes systemd, task-scheduler, launchd, background/],
    [['--state-dir', '/srv/state'], /--state-dir and --env-file are what a service definition passes; at a terminal, set BUCKLE_STATE_DIR or BUCKLE_ENV_FILE instead/],
    [['--service', 'systemd', '--state-dir', 'state'], /--state-dir must be an absolute path/],
    [['--service', 'systemd', '--env-file', 'node.env'], /--env-file must be an absolute path/],
  ])('refuses %j', (options, reason) => {
    expect(() => parseServeOptions(options)).toThrow(reason)
  })

  it('sets the node\'s location a service definition names, as paths, before anything reads the environment', () => {
    const environment: NodeJS.ProcessEnv = { BUCKLE_STATE_DIR: '/shell/state' }
    useServiceLocation({ stateDirectory: '/srv/state', environmentFile: '/srv/node.env' }, environment)
    expect(environment).toEqual({ BUCKLE_STATE_DIR: '/srv/state', BUCKLE_ENV_FILE: '/srv/node.env' })
  })
})

describe('where the node lives, read before its environment file', () => {
  it('is BUCKLE_STATE_DIR, else the line a named file holds, else the default, reading no other value of the file', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-node-location-')))
    const file = join(root, 'node.env')
    writeFileSync(file, `BUCKLE_STATE_DIR=${root}/moved\nBUCKLE_ADMIN_TOKEN=never-read-fixture\n`)
    const environment: NodeJS.ProcessEnv = { HOME: root, BUCKLE_ENV_FILE: file }
    expect(nodeLocation(environment, 'linux')).toEqual({ stateDirectory: `${root}/moved`, environmentFile: file })
    expect(environment.BUCKLE_ADMIN_TOKEN).toBeUndefined()
    expect(nodeLocation({ HOME: root, BUCKLE_ENV_FILE: file, BUCKLE_STATE_DIR: `${root}/shell` }, 'linux').stateDirectory).toBe(`${root}/shell`)
    expect(nodeLocation({ HOME: root }, 'linux')).toEqual({ stateDirectory: expect.stringMatching(/\.5straps\/buckle$/), environmentFile: null })
  })
})

describe('the command that answers a running node\'s approvals', () => {
  function registry(workspaces: Array<{ dir: string; online: boolean }>): { state: string; root: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-attach-')))
    const state = join(root, 'state')
    mkdirSync(state)
    const stored = workspaces.map((workspace, index) => {
      mkdirSync(workspace.dir.replace('<root>', root), { recursive: true })
      return { id: `00000000-0000-4000-8000-00000000000${index}`, name: `w${index}`, dir: workspace.dir.replace('<root>', root), online: workspace.online, tokens: [], revision: 0, updatedAt: '2026-10-16T00:00:00.000Z' }
    })
    writeFileSync(join(state, 'workspaces.json'), JSON.stringify({ version: 2, workspaces: stored }))
    return { state, root }
  }

  it('answers the workspace holding this directory where it is the one online, and every one otherwise', () => {
    const one = registry([{ dir: '<root>/site', online: true }, { dir: '<root>/docs', online: false }])
    expect(attachCommand(one.state, join(one.root, 'site', 'src'), 'linux')).toBe('buckle approvals --watch')
    expect(attachCommand(one.state, join(one.root, 'docs'), 'linux')).toBe('buckle approvals --watch --all')
    expect(attachCommand(one.state, one.root, 'linux')).toBe('buckle approvals --watch --all')
    const two = registry([{ dir: '<root>/site', online: true }, { dir: '<root>/docs', online: true }])
    expect(attachCommand(two.state, join(two.root, 'site'), 'linux')).toBe('buckle approvals --watch --all')
  })

  it('names every workspace where the registry cannot be read', () => {
    const { state, root } = registry([])
    writeFileSync(join(state, 'workspaces.json'), '{"version":1}')
    expect(attachCommand(state, root, 'linux')).toBe('buckle approvals --watch --all')
  })

  it('reaches an unspecified listening address at loopback', () => {
    expect(addressOf({ host: '127.0.0.1', port: 4320 })).toBe('http://127.0.0.1:4320')
    expect(addressOf({ host: '0.0.0.0', port: 1 })).toBe('http://127.0.0.1:1')
    expect(addressOf({ host: '::', port: 2 })).toBe('http://[::1]:2')
    expect(addressOf({ host: '::1', port: 3 })).toBe('http://[::1]:3')
  })
})

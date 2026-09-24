import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInit, type InitPrompt } from '../src/faces/cli/init.js'

let workspace: string
let out: string

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-init-settings-'))
  workspace = join(root, 'workspace')
  out = join(root, 'node.env')
  mkdirSync(workspace)
})

/** Answers the questions in order; the workspace root, mount and name come first. */
function scripted(answers: string[], interactive = true): InitPrompt & { asked: string[]; said: string[] } {
  const queue = [...answers]
  const asked: string[] = []
  const said: string[] = []
  return {
    interactive, asked, said,
    question: async text => { asked.push(text); return queue.shift() ?? '' },
    say: text => void said.push(text),
    close: () => {},
  }
}

async function init(prompt: InitPrompt, extra: string[] = []) {
  let printed = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
  try {
    const result = await runInit(['--out', out, '--port', '4399', ...extra], prompt)
    return { ...result, printed, written: readFileSync(out, 'utf8') }
  } finally { stdout.mockRestore() }
}

describe('buckle init asks for node settings after the workspace', () => {
  it('shows each default, and Enter keeps the shipped ones', async () => {
    const prompt = scripted([workspace, '', 'Fixture'])
    const result = await init(prompt)

    expect(prompt.asked.slice(3)).toEqual([
      expect.stringContaining('[all]'),
      expect.stringContaining('[Y/n]'),
      expect.stringContaining('[y/N]'),
      expect.stringContaining('[none]'),
      expect.stringContaining('[none]'),
    ])
    expect(prompt.said).toContainEqual(expect.stringContaining('BUCKLE-D17'))
    for (const id of ['fs', 'web', 'git', 'forge', 'dev', 'browser', 'shell', 'environment']) expect(prompt.said.join('\n')).toContain(`  ${id} `)

    const env = parseEnv(result.written)
    expect(env.BUCKLE_ALLOW_SHELL).toBe('true')
    for (const key of ['BUCKLE_PACKS', 'BUCKLE_ALLOW_HOST_GIT', 'BUCKLE_NETWORK_ALLOW', 'BUCKLE_ALLOWED_HOSTS']) expect(env[key]).toBeUndefined()
    expect(result.written).toContain('# BUCKLE_ALLOW_HOST_GIT=true')
  })

  it('writes the answers that move off a default', async () => {
    const result = await init(scripted([workspace, '', 'Fixture', 'fs, shell', 'n', 'y', 'localhost:3000,*.example.com', 'db.internal']))

    const env = parseEnv(result.written)
    expect(env).toMatchObject({
      BUCKLE_PACKS: 'fs,shell',
      BUCKLE_ALLOW_SHELL: 'false',
      BUCKLE_ALLOW_HOST_GIT: 'true',
      BUCKLE_NETWORK_ALLOW: 'localhost:3000,*.example.com',
      BUCKLE_ALLOWED_HOSTS: 'db.internal',
    })
    expect(result.printed).toMatch(/Packs\s+fs, shell/)
    expect(result.printed).toMatch(/Host Git\s+on/)
  })

  it('asks again after an answer the settings check refuses, saying why', async () => {
    const prompt = scripted([workspace, '', 'Fixture', 'fs,rocket', 'fs', 'maybe', '', '', '*', '', '*.0.0.1', ''])
    const result = await init(prompt)

    expect(prompt.said).toContainEqual(expect.stringContaining('Unknown pack rocket'))
    expect(prompt.said).toContainEqual('Answer y or n, or press Enter for the default.')
    expect(prompt.said).toContainEqual(expect.stringContaining('Invalid BUCKLE_NETWORK_ALLOW entry'))
    expect(prompt.said).toContainEqual(expect.stringContaining('Invalid BUCKLE_ALLOWED_HOSTS entry'))
    expect(parseEnv(result.written)).toMatchObject({ BUCKLE_PACKS: 'fs', BUCKLE_ALLOW_SHELL: 'true' })
    expect(parseEnv(result.written).BUCKLE_NETWORK_ALLOW).toBeUndefined()
  })
})

describe('buckle init without questions', () => {
  it.each([
    ['--yes', scripted([], true), ['--yes']],
    ['no terminal', scripted([], false), []],
  ])('keeps the defaults under %s, asks nothing, and prints what it kept', async (_label, prompt, flags) => {
    const result = await init(prompt, ['--root', workspace, ...flags])

    expect(prompt.asked).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(result.printed).toMatch(/Packs\s+all, and plugins/)
    expect(result.printed).toMatch(/Shell\s+on/)
    expect(result.printed).toMatch(/Host Git\s+off/)
    expect(result.printed).toContain('These are the defaults')
    const env = parseEnv(result.written)
    expect(env.BUCKLE_ALLOW_SHELL).toBe('true')
    expect(env.BUCKLE_ALLOW_HOST_GIT).toBeUndefined()
    expect(env.BUCKLE_PACKS).toBeUndefined()
  })
})

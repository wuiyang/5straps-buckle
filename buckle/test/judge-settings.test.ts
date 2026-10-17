import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsCommand } from '../cli/settings.js'
import { buildChildEnvironment } from '../common/domain/environment.js'
import { configureRootLogger, flushLogs, logger } from '../common/runtime/log.js'
import { loadConfig, unreadWorkspaceDefaults } from '../common/runtime/config.js'
import { openSettingsFile, resolveSettings, settingsPath, STANDARD_SCRIPTS, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { runCli } from './support/cli.js'
import { idOf, workspacesOf } from './support/workspaces.js'

// The decision AI's settings (D91 and its addendum): approval.judge (off, on-request, or automated), judgeProvider and
// judgeModel with no default of Buckle's own, and judgeStandardScripts, per workspace over the node's BUCKLE_APPROVAL_JUDGE
// and its kin (D85, Q3); and the node's alone BUCKLE_JUDGE_API_KEY and BUCKLE_JUDGE_BASE_URL, which no command, log line,
// or settings listing shows.

const KEY = 'sk-judge-settings-fixture-0123456789'
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); configureRootLogger({}); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-judge-settings-')))
  roots.push(root)
  return root
}

function captured() {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  return { out: () => out, err: () => err, clear: () => { out = ''; err = '' } }
}

describe('a workspace\'s decision AI settings', () => {
  it('are its own, else the node\'s, else off with an OpenAI-compatible endpoint, gpt-6-luna, and the built-in standard scripts, naming where each came from', () => {
    const unset = WorkspaceSettingsSchema.parse({ version: 1 })
    const builtIn = resolveSettings(unset, loadConfig({}).workspaceDefaults)
    expect(builtIn.approval).toEqual({ judge: 'off', judgeProvider: 'openai-compatible', judgeModel: 'gpt-6-luna', judgeStandardScripts: STANDARD_SCRIPTS })
    expect(builtIn.sources).toMatchObject({ 'approval.judge': 'built-in', 'approval.judgeProvider': 'built-in', 'approval.judgeModel': 'built-in', 'approval.judgeStandardScripts': 'built-in' })
    expect(STANDARD_SCRIPTS).toEqual(expect.arrayContaining(['npm run *', 'pnpm dev', 'npx vitest *', 'bunx tsc *']))

    const node = loadConfig({ BUCKLE_APPROVAL_JUDGE: 'automated', BUCKLE_APPROVAL_JUDGE_PROVIDER: 'openai-compatible', BUCKLE_APPROVAL_JUDGE_MODEL: 'GPT-6-luna', BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS: 'npm test;;make *' }).workspaceDefaults
    expect(resolveSettings(unset, node)).toMatchObject({ approval: { judge: 'automated', judgeProvider: 'openai-compatible', judgeModel: 'GPT-6-luna', judgeStandardScripts: ['npm test', 'make *'] }, sources: { 'approval.judge': 'node', 'approval.judgeProvider': 'node', 'approval.judgeModel': 'node', 'approval.judgeStandardScripts': 'node' } })

    const own = WorkspaceSettingsSchema.parse({ version: 1, approval: { judge: 'on-request', judgeProvider: 'openai-compatible', judgeModel: 'claude-opus-5-5', judgeStandardScripts: [] } })
    expect(resolveSettings(own, node)).toMatchObject({ approval: { judge: 'on-request', judgeProvider: 'openai-compatible', judgeModel: 'claude-opus-5-5', judgeStandardScripts: [] }, sources: { 'approval.judge': 'workspace', 'approval.judgeProvider': 'workspace', 'approval.judgeModel': 'workspace', 'approval.judgeStandardScripts': 'workspace' } })
  })

  it('hold no mode outside the three, no provider outside the two, no model with a blank, no glob Buckle cannot read, and no other key', () => {
    for (const approval of [{ judge: 'interpreters' }, { judge: 'always' }, { judgeProvider: 'mistral' }, { judgeModel: 'claude opus' }, { judgeModel: '' }, { judgeStandardScripts: [''] }, { judgeApiKey: KEY }]) {
      expect(() => WorkspaceSettingsSchema.parse({ version: 1, approval }), JSON.stringify(approval)).toThrow()
    }
  })

  it('come from the node\'s environment file alone, and a value the node refuses stops it, naming the variable', () => {
    const caller = { BUCKLE_APPROVAL_JUDGE: 'automated', BUCKLE_APPROVAL_JUDGE_PROVIDER: 'openai-compatible', BUCKLE_APPROVAL_JUDGE_MODEL: 'claude-opus-5-5', BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS: 'npm test' }
    const layers = { file: { path: '/state/buckle.env', values: {} }, caller }
    expect(loadConfig({ ...caller }, process.platform, layers).workspaceDefaults.approval).toEqual({})
    expect(unreadWorkspaceDefaults(layers)).toEqual(['BUCKLE_APPROVAL_JUDGE', 'BUCKLE_APPROVAL_JUDGE_PROVIDER', 'BUCKLE_APPROVAL_JUDGE_MODEL', 'BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS'])
    expect(() => loadConfig({ BUCKLE_APPROVAL_JUDGE: 'interpreters' })).toThrow('Invalid BUCKLE_APPROVAL_JUDGE: off, on-request, automated')
    expect(() => loadConfig({ BUCKLE_APPROVAL_JUDGE_PROVIDER: 'mistral' })).toThrow('Invalid BUCKLE_APPROVAL_JUDGE_PROVIDER: openai-compatible')
    expect(() => loadConfig({ BUCKLE_APPROVAL_JUDGE_MODEL: 'claude opus' })).toThrow('Invalid BUCKLE_APPROVAL_JUDGE_MODEL')
    expect(() => loadConfig({ BUCKLE_JUDGE_BASE_URL: 'file:///etc/passwd' })).toThrow('Invalid BUCKLE_JUDGE_BASE_URL: an http or https URL')
  })
})

describe('buckle workspace set approval.*', () => {
  async function workspace(environment: Record<string, string> = {}) {
    const root = scratch()
    const folder = join(root, 'site')
    mkdirSync(folder)
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'judge-settings-admin-credential', BUCKLE_SANDBOX: 'none', ...environment })
    const output = captured()
    const buckle = (argv: string[]) => runCli({ argv: ['workspace', ...argv], config, confirm: null, cwd: folder })
    expect((await buckle(['init'])).exitCode).toBe(0)
    const manager = await workspacesOf(config)
    const stored = () => openSettingsFile({ filePath: settingsPath(config.stateDirectory, idOf(manager, 'site')) }).read().approval
    output.clear()
    return { buckle, output, stored, manager }
  }

  it('store an own value, show it with its source, and unset takes it out', async () => {
    const { buckle, output, stored, manager } = await workspace()
    await buckle(['show'])
    expect(output.out()).toMatch(/approval\.judge +off +built-in/)
    expect(output.out()).toMatch(/approval\.judgeProvider +openai-compatible +built-in/)
    expect(output.out()).toMatch(/approval\.judgeModel +gpt-6-luna +built-in/)
    for (const [key, value] of [['approval.judge', 'On-Request'], ['approval.judgeProvider', 'openai-compatible'], ['approval.judgeModel', 'GPT-6-luna'], ['approval.judgeStandardScripts', 'npm test ;; npx vitest *']] as const) {
      expect((await buckle(['set', key, value])).exitCode, key).toBe(0)
    }
    expect(stored()).toEqual({ judge: 'on-request', judgeProvider: 'openai-compatible', judgeModel: 'GPT-6-luna', judgeStandardScripts: ['npm test', 'npx vitest *'] })
    output.clear()
    await buckle(['show'])
    expect(output.out()).toMatch(/approval\.judge +on-request +workspace/)
    expect(output.out()).toMatch(/approval\.judgeModel +GPT-6-luna +workspace/)
    expect(output.out()).toMatch(/approval\.judgeStandardScripts +npm test;;npx vitest \* +workspace/)
    expect((await buckle(['set', 'approval.judgeStandardScripts', ''])).exitCode).toBe(0)
    expect(stored().judgeStandardScripts).toEqual([])
    expect((await buckle(['unset', 'approval.judgeProvider'])).exitCode).toBe(0)
    expect((await buckle(['unset', 'approval.judgeStandardScripts'])).exitCode).toBe(0)
    expect(stored()).toEqual({ judge: 'on-request', judgeModel: 'GPT-6-luna' })
    await manager.close()
  })

  it.each([
    ['approval.judge', 'interpreters', 'approval.judge is off, on-request, automated'],
    ['approval.judgeProvider', 'mistral', 'approval.judgeProvider is openai-compatible'],
    ['approval.judgeModel', 'claude opus', 'approval.judgeModel is a model name, with no blank'],
    ['approval.judgeStandardScripts', 'npm run [', 'approval.judgeStandardScripts:'],
  ])('refuse %s %s, writing nothing', async (key, value, refusal) => {
    const { buckle, output, stored, manager } = await workspace()
    expect((await buckle(['set', key, value])).exitCode).toBe(1)
    expect(output.err()).toContain(refusal)
    expect(stored()).toEqual({})
    await manager.close()
  })

  it('refuse the judge key and base URL as node settings, and a variable holding the key, never echoing it', async () => {
    const { buckle, output, manager } = await workspace({ BUCKLE_JUDGE_API_KEY: KEY })
    expect((await buckle(['set', 'judge-api-key', KEY])).exitCode).toBe(1)
    expect(output.err()).toContain('judge-api-key is a node setting (BUCKLE_JUDGE_API_KEY), the same for every workspace, so no workspace sets it. buckle settings set does not write it: change it in the node\'s buckle.env')
    expect((await buckle(['set', 'judge-base-url', 'http://127.0.0.1:11434/v1'])).exitCode).toBe(1)
    expect(output.err()).toContain('judge-base-url is a node setting (BUCKLE_JUDGE_BASE_URL)')
    expect((await buckle(['set', 'env.HELPER', `prefix-${KEY}`])).exitCode).toBe(1)
    expect(output.err()).toContain('That value holds one of this node\'s credentials')
    expect(output.out() + output.err()).not.toContain(KEY)
    await manager.close()
  })

  it('refuse a variable holding the judge\'s base URL, which can carry a credential of its own', async () => {
    const baseUrl = 'https://gateway.test/v1?key=gateway-secret-0123'
    const { buckle, output, manager } = await workspace({ BUCKLE_JUDGE_BASE_URL: baseUrl })
    expect((await buckle(['set', 'env.GATEWAY', baseUrl])).exitCode).toBe(1)
    expect(output.err()).toContain('That value holds one of this node\'s credentials')
    expect(output.out() + output.err()).not.toContain('gateway-secret-0123')
    await manager.close()
  })
})

describe('the node\'s decision AI settings in buckle settings', () => {
  function node() {
    const root = scratch()
    const file = join(root, 'buckle.env')
    writeFileSync(file, `BUCKLE_STATE_DIR=${join(root, 'state')}\nBUCKLE_JUDGE_API_KEY=${KEY}\nBUCKLE_JUDGE_BASE_URL=https://gateway.test/v1?key=${KEY}\n`, { mode: 0o600 })
    const settings = async (argv: string[]) => {
      const output = captured()
      const result = await settingsCommand({ argv, environment: {}, environmentFile: file, cwd: root, home: root })
      vi.restoreAllMocks()
      return { ...result, out: output.out(), printed: output.out() + output.err() }
    }
    return { file, settings }
  }

  it('lists the mode, provider, model, and standard scripts among the workspace defaults, and the key and base URL by name alone', async () => {
    const { settings } = node()
    const shown = await settings(['show'])
    const defaults = shown.out.slice(shown.out.indexOf('Workspace defaults'))
    expect(defaults).toMatch(/approval-judge\s+BUCKLE_APPROVAL_JUDGE\s+off\s+default/)
    expect(defaults).toMatch(/approval-judge-provider\s+BUCKLE_APPROVAL_JUDGE_PROVIDER\s+openai-compatible\s+default/)
    expect(defaults).toMatch(/approval-judge-model\s+BUCKLE_APPROVAL_JUDGE_MODEL\s+gpt-6-luna\s+default/)
    expect(defaults).toContain('BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS')
    expect(shown.out).toContain('BUCKLE_JUDGE_API_KEY (set, hidden)')
    expect(shown.out).toContain('BUCKLE_JUDGE_BASE_URL (set, hidden)')
    expect(shown.printed).not.toContain(KEY)
  })

  it('writes the mode, provider, model, and standard scripts, refusing a value outside them, and leaves the key to a hand edit', async () => {
    const { file, settings } = node()
    for (const [alias, value] of [['approval-judge', 'automated'], ['approval-judge-provider', 'openai-compatible'], ['approval-judge-model', 'claude-opus-5-5'], ['approval-judge-standard-scripts', 'npm test;;npx vitest *']]) {
      expect((await settings(['set', alias!, value!])).exitCode, alias).toBe(0)
    }
    expect(readFileSync(file, 'utf8')).toContain('BUCKLE_APPROVAL_JUDGE=automated\nBUCKLE_APPROVAL_JUDGE_PROVIDER=openai-compatible\nBUCKLE_APPROVAL_JUDGE_MODEL=claude-opus-5-5\nBUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS=npm test;;npx vitest *\n')
    const refused = await settings(['set', 'approval-judge', 'interpreters'])
    expect(refused.exitCode).toBe(1)
    expect(refused.printed).toContain('BUCKLE_APPROVAL_JUDGE is off, on-request, automated')
    const key = await settings(['set', 'BUCKLE_JUDGE_API_KEY', 'sk-other'])
    expect(key.exitCode).toBe(1)
    expect(key.printed).toContain('BUCKLE_JUDGE_API_KEY is not a node setting buckle settings writes')
    expect(readFileSync(file, 'utf8')).toContain(`BUCKLE_JUDGE_API_KEY=${KEY}\n`)
  })
})

describe('the judge key and base URL', () => {
  it('are read from the node\'s environment alone', () => {
    expect(loadConfig({ BUCKLE_JUDGE_API_KEY: KEY, BUCKLE_JUDGE_BASE_URL: 'http://127.0.0.1:11434/v1' })).toMatchObject({ judgeApiKey: KEY, judgeBaseUrl: 'http://127.0.0.1:11434/v1' })
    expect(loadConfig({ ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://proxy.invalid' })).toMatchObject({ judgeApiKey: undefined, judgeBaseUrl: undefined })
  })

  it('never reach a program Buckle runs', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const child = buildChildEnvironment({ parent: { PATH: '/usr/bin', BUCKLE_JUDGE_API_KEY: KEY, BUCKLE_JUDGE_BASE_URL: 'https://gateway.test/v1' }, extra: {}, platform })
      expect(child).not.toHaveProperty('BUCKLE_JUDGE_API_KEY')
      expect(child).not.toHaveProperty('BUCKLE_JUDGE_BASE_URL')
    }
  })

  it('keep the key out of a log line by its name', async () => {
    let text = ''
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { text += String(chunk); return true })
    try {
      logger.warn('judge configured', { BUCKLE_JUDGE_API_KEY: KEY, judgeApiKey: KEY })
      await flushLogs()
    } finally { spy.mockRestore() }
    expect(text).toContain('judge configured')
    expect(text).not.toContain(KEY)
  })
})

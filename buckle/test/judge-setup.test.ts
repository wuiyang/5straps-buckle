import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { judgeSetupNotice } from '../common/services/judge/judge-setup.js'
import { WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { serveHttp } from '../server/serve.js'
import { idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'

// buckle serve says once at start where a workspace's decision AI is on but cannot rate (D91, addendum A), naming the
// settings or the key it lacks, and never a value.

const KEY = 'sk-judge-setup-fixture-0123456789'
const workspace = (name: string, approval: Record<string, unknown> = {}) => ({ name, settings: WorkspaceSettingsSchema.parse({ version: 1, approval }) })

describe('the decision AI notice at start', () => {
  it('says nothing where every judge is off or set up', () => {
    expect(judgeSetupNotice({ config: loadConfig({}), workspaces: [workspace('off')] })).toBeNull()
    expect(judgeSetupNotice({ config: loadConfig({ BUCKLE_JUDGE_API_KEY: KEY }), workspaces: [workspace('ready', { judge: 'automated', judgeProvider: 'anthropic', judgeModel: 'claude-opus-5-5' })] })).toBeNull()
  })

  it('names, in one line, each workspace whose judge is on and what it lacks, by name and never by value', () => {
    const notice = judgeSetupNotice({
      config: loadConfig({ BUCKLE_APPROVAL_JUDGE_PROVIDER: 'openai' }),
      workspaces: [workspace('alpha', { judge: 'automated' }), workspace('beta', { judge: 'on-request', judgeModel: 'GPT-6-luna' }), workspace('gamma')],
    })
    expect(notice).toBe('The decision AI is on but stays off until it is set up, in workspaces alpha (approval.judgeModel, BUCKLE_JUDGE_API_KEY); beta (BUCKLE_JUDGE_API_KEY): buckle workspace set names a provider and a model, buckle settings set does so for every workspace, and the key goes in buckle.env by hand')
    const keyed = judgeSetupNotice({ config: loadConfig({ BUCKLE_JUDGE_API_KEY: KEY }), workspaces: [workspace('alpha', { judge: 'automated', judgeModel: 'm' })] })
    expect(keyed).toContain('workspace alpha (approval.judgeProvider)')
    expect(keyed).not.toContain(KEY)
  })
})

describe('buckle serve at start', () => {
  it('warns once, naming what a workspace\'s decision AI lacks', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-judge-serve-')))
    mkdirSync(join(root, 'alpha'))
    const config = { ...loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none' }), host: '127.0.0.1', port: 0 }
    const manager = await workspacesOf(config)
    await registerWorkspace(manager, { id: 'alpha', dir: join(root, 'alpha') })
    await manager.updateSettings(idOf(manager, 'alpha'), settings => ({ ...settings, approval: { judge: 'automated', judgeProvider: 'anthropic' } }))
    const closers: Array<() => unknown> = []
    const common = { owner: { onClose: (...args: unknown[]) => { closers.push(args.at(-1) as () => unknown) } }, start: async () => {}, services: { getWorkspaces: async () => manager } }
    const logger = { info: vi.fn(), warn: vi.fn() }
    try {
      await serveHttp({ config, common: common as never, logger: logger as never, server: { middleware: (_request: unknown, response: { end(): void }) => response.end() } as never, write: () => {} })
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith('The decision AI is on but stays off until it is set up, in workspace alpha (approval.judgeModel, BUCKLE_JUDGE_API_KEY): buckle workspace set names a provider and a model, buckle settings set does so for every workspace, and the key goes in buckle.env by hand')
    } finally {
      for (const close of closers.reverse()) await close()
      await manager.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, type InvokeResponse } from '@5straps/protocol'
import { configFromEnvironment, nodeConfigOf } from './support/workspace-config.js'
import { initializeCommon } from '../common/runtime/initialize.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { byName } from './support/workspaces.js'

// The environment validator, and every other program Buckle runs on the host, inherited the node's PATH, which `npx`
// and `pnpm exec` start at the default workspace's node_modules/.bin: a trusted validator that starts
// `#!/usr/bin/env node` ran the `node` the agent planted there. And the validator itself was refused only inside the
// calling workspace, so a child workspace ran one the default workspace's agent wrote.

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-environment-validator-'))
  roots.push(root)
  return root
}

function script(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

const tokens = { authToken: 'validator-agent-token-fixture-000', adminToken: 'validator-admin-token-fixture-000' }

/**
 * A node whose default workspace holds a planted `node` first on PATH, with a registered child workspace; `validator`
 * places the validator. Each runtime's env_validate answer comes back with what ran, as the scripts logged it.
 */
async function validateOnNode(validator: (scene: { workspace: string; outside: string; log: string }) => string): Promise<Array<{ response: InvokeResponse; ran: string[] }>> {
  const workspace = scratch()
  const child = scratch()
  const outside = scratch()
  const state = join(scratch(), 'state')
  mkdirSync(state, { mode: 0o700 })
  const log = join(outside, 'ran.log')
  script(join(workspace, 'node_modules', '.bin', 'node'), `#!/bin/sh\necho PLANTED-NODE >> '${log}'\nexit 0\n`)
  const command = validator({ workspace, outside, log })
  vi.stubEnv('PATH', `${join(workspace, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`)
  const common = initializeCommon({ role: 'cli', config: nodeConfigOf(configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state, BUCKLE_PACKS: 'environment', BUCKLE_ENV_VALIDATOR_COMMAND: command,
  })) })
  try {
    await common.start()
    const workspaces = await common.services.getWorkspaces()
    await workspaces.create({ id: 'child', name: 'Child', dir: child, policy: emptyWorkspacePolicy(), settings: settings => ({ ...settings, packs: { ...settings.packs, enabled: ['environment'] } }) })
    const answers: Array<{ response: InvokeResponse; ran: string[] }> = []
    for (const runtime of [(await byName(workspaces, basename(workspace))).runtime, (await byName(workspaces, 'child')).runtime] as BuckleRuntime[]) {
      rmSync(log, { force: true })
      const response = await runtime.invoke({ request: { requestId: `validate-${runtime.workspaceId}`, tool: 'env_validate', args: {}, approvalTokens: [] }, sessionId: 'validator' })
      answers.push({ response, ran: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] })
    }
    return answers
  } finally { await common.owner.close() }
}

describe('the environment validator on a node whose PATH starts in a workspace', () => {
  it('runs a trusted node script under the node on PATH past the workspace, never the planted one, in the default and a registered workspace', async () => {
    const answers = await validateOnNode(({ outside, log }) => script(join(outside, 'tools', 'varlock'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, 'REAL-NODE\\n')\n`))
    for (const { response, ran } of answers) {
      expect(response).toMatchObject({ outcome: 'ok', output: { valid: true, timedOut: false } })
      expect(ran).toEqual(['REAL-NODE'])
    }
  })

  it('is refused in every workspace where it lies in the default workspace, and runs nowhere', async () => {
    const answers = await validateOnNode(({ workspace, log }) => script(join(workspace, 'node_modules', '.bin', 'varlock'), `#!/bin/sh\necho VALIDATOR-IN-DEFAULT >> '${log}'\nexit 0\n`))
    for (const { response, ran } of answers) {
      expect(response).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('The validator BUCKLE_ENV_VALIDATOR_COMMAND names is found in or through a workspace of this node, where an agent can write, so Buckle does not run it. Ask the owner to inspect buckle policy show --workspace ') } })
      expect(ran).toEqual([])
    }
  })
})

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../src/config.js'
import { createHttpApp } from '../src/faces/http-app.js'
import { createRuntime } from '../src/runtime.js'
const AGENT = 'skill-agent'
const SETUP = 'skill-setup'
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

it('returns only the requested skill body through the execution credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-skills-'))
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_SETUP_TOKEN: SETUP, BUCKLE_ALLOW_SHELL: 'false' })
  const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
  const app = createHttpApp({ config, runtime, authToken: AGENT })
  const skill = runtime.skills()[0]!
  const path = `/v1/skills/${encodeURIComponent(skill.id)}`
  expect((await app.request(path, { headers: bearer(SETUP) })).status).toBe(401)
  const response = await app.request(path, { headers: bearer(AGENT) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ skill: { id: skill.id, name: skill.name, description: skill.description, contentHash: skill.contentHash, pack: skill.pack, content: skill.content } })
  expect((await app.request('/v1/skills/not-a-skill', { headers: bearer(AGENT) })).status).toBe(404)
})

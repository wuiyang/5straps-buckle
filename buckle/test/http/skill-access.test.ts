import { expect, it } from 'vitest'
import { createBuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

const AGENT = 'skill-agent'
const SETUP = 'skill-setup'
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

it('returns only the requested skill body through the execution credential', async () => {
  // Buckle's state lives outside the workspace, which is the only layout loadConfig accepts.
  const buckle = await createBuckleHttp({ environment: nodeEnvironment('buckle-skills-', { BUCKLE_AUTH_TOKEN: AGENT, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ADMIN_TOKEN: SETUP }).environment })
  try {
    const skill = buckle.runtime.skills()[0]!
    const path = `/v1/skills/${encodeURIComponent(skill.id)}`
    expect((await buckle.request(path, { headers: bearer(SETUP) })).status).toBe(401)
    const response = await buckle.request(path, { headers: bearer(AGENT) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ skill: { id: skill.id, name: skill.name, description: skill.description, contentHash: skill.contentHash, pack: skill.pack, content: skill.content } })
    const missing = await buckle.request('/v1/skills/not-a-skill', { headers: bearer(AGENT) })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'Skill not found' })
    const listed = await (await buckle.request('/v1/skills', { headers: bearer(AGENT) })).json() as { skills: Array<Record<string, unknown>> }
    expect(listed.skills.map(item => item.id)).toContain(skill.id)
    expect(listed.skills.every(item => !('path' in item))).toBe(true)
  } finally {
    await buckle.close()
  }
})

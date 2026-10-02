import { getRouterParam } from 'h3'
import { notFound } from '../../../utils/errors.js'
import { requireAgent } from '../../../utils/guards.js'
import { defineOperationHandler } from '../../../utils/operation.js'
import { skillBody } from '../../../utils/skills.js'
import { useTarget } from '../../../utils/target.js'

// Only the requested skill's body, through the execution credential.
export default defineOperationHandler({
  guards: [requireAgent()],
  handler: async (event) => {
    const skillId = getRouterParam(event, 'skillId', { decode: true })
    const skill = (await useTarget(event)).runtime.skills().find(item => item.id === skillId)
    if (!skill) throw notFound('Skill not found')
    return { skill: skillBody(skill) }
  },
})

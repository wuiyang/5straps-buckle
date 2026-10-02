import { requireAgent } from '../../utils/guards.js'
import { defineOperationHandler } from '../../utils/operation.js'
import { skillBody } from '../../utils/skills.js'
import { useTarget } from '../../utils/target.js'

export default defineOperationHandler({
  guards: [requireAgent()],
  handler: async event => ({ skills: (await useTarget(event)).runtime.skills().map(skillBody) }),
})

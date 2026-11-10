import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { toolNameToCommand } from './arguments.js'
import { ownerHoldsToolGroup } from './commands.js'
import type { CliResult } from './result.js'
import { fail } from './output.js'

/** Each tool by the command that runs it: its group and verb, or `call <name>` where an owner command holds that group (history). */
export function printTools(runtime: BuckleRuntime): CliResult {
  for (const capability of runtime.registry().capabilities()) {
    const { group, verb } = toolNameToCommand(capability.name)
    const command = ownerHoldsToolGroup(group) ? `call ${capability.name}` : `${group} ${verb}`
    process.stdout.write(`${command.padEnd(24)} ${capability.risk.padEnd(8)} ${capability.description}\n`)
  }
  return { exitCode: 0 }
}

export function printSkills(runtime: BuckleRuntime, argv: string[]): CliResult {
  const [name] = argv
  const skills = runtime.skills()
  if (!name) {
    for (const skill of skills) process.stdout.write(`${skill.name.padEnd(24)} ${skill.description}\n`)
    return { exitCode: 0 }
  }
  const skill = skills.find(candidate => candidate.name === name)
  if (!skill) return fail(`Unknown skill: ${name}`)
  process.stdout.write(`${skill.content}\n`)
  return { exitCode: 0 }
}

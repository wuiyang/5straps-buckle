import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { CliResult } from './result.js'
import { fail } from './output.js'
export { PLUGIN_USAGE } from './usage.js'

export async function pluginCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [action, id, specifier] = argv
  if (action === 'add') {
    if (!id || !specifier) return fail('Usage: buckle plugin add <id> <module-specifier>')
    await runtime.plugins.add({ id, specifier })
    await runtime.reload()
    process.stdout.write(`Added plugin ${id}\n`)
    return { exitCode: 0 }
  }
  if (action === 'remove') {
    if (!id) return fail('Usage: buckle plugin remove <id>')
    if (!await runtime.plugins.remove(id)) return fail(`Plugin not found: ${id}`)
    await runtime.reload()
    process.stdout.write(`Removed plugin ${id}\n`)
    return { exitCode: 0 }
  }
  for (const entry of runtime.plugins.list()) {
    process.stdout.write(`${entry.id.padEnd(24)} ${entry.enabled ? 'enabled ' : 'disabled'} ${entry.specifier}\n`)
  }
  return { exitCode: 0 }
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerWithoutConfiguration } from '../cli/main.js'
import { policyCommand } from '../cli/policy.js'
import type { WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

// The top-level help once omitted the dangerously-allow switch, and `buckle policy --help` printed its usage but
// exited 1, so a wrapper that treats a non-zero exit as failure saw asking for help as an error (public docs review).

afterEach(() => vi.restoreAllMocks())

const captured = () => {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true })
  return { out: () => out, err: () => err }
}

describe('buckle --help', () => {
  it('lists the dangerously-allow switch under policy, with its warning, and exits 0', () => {
    const io = captured()
    const result = answerWithoutConfiguration(['--help'])
    expect(result).toEqual({ exitCode: 0 })
    expect(io.out()).toContain('buckle policy dangerously-allow on|off')
    expect(io.out()).toContain('DANGEROUS')
  })
})

describe('buckle policy --help', () => {
  // The help case returns before any runtime or workspace is touched, so neither is built for this call.
  const runtime = {} as unknown as BuckleRuntime
  const workspaces = {} as unknown as WorkspaceManager

  it.each(['--help', '-h', 'help'])('prints the usage to stdout and exits 0 for %s', async (flag) => {
    const io = captured()
    const result = await policyCommand(runtime, [flag], workspaces)
    expect(result.exitCode).toBe(0)
    expect(io.out()).toContain('buckle policy dangerously-allow on|off')
    expect(io.err()).toBe('')
  })

  it('still exits 1 and prints the usage to stderr for an unknown subcommand', async () => {
    const io = captured()
    const result = await policyCommand(runtime, ['not-a-subcommand'], workspaces)
    expect(result.exitCode).toBe(1)
    expect(io.err()).toContain('buckle policy show')
    expect(io.out()).toBe('')
  })
})

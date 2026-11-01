import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

// Slice F4, item 1: a Buckle node with no console (a service, a detached serve) opened a console window for each
// agent-browser it started. A request that asks for no console window reaches spawn as windowsHide.

const spawned: Array<Record<string, unknown>> = []
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: (_command: string, _args: string[], options: Record<string, unknown>) => {
    spawned.push(options)
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
    setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null) })
    return child
  },
}))

const { runProcess } = await import('../common/adapters/process-runner.js')

describe('the process runner on a node with no console', () => {
  it('starts a process that asks for no console window with windowsHide, and every other one as before', async () => {
    await runProcess({ command: 'agent-browser', args: ['snapshot'], cwd: '/', timeoutMs: 1000, environment: {}, windowsHide: true })
    await runProcess({ command: 'rg', args: ['x'], cwd: '/', timeoutMs: 1000, environment: {} })
    expect(spawned.map(options => options.windowsHide)).toEqual([true, false])
  })
})

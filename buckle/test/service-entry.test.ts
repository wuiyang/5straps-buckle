import { afterEach, describe, expect, it, vi } from 'vitest'

// Fix brief 1, H6: `buckle service logs` renders for a person only where stdout is a terminal (the CLI display slice,
// C6), so the entry hands the command whether it is one.

const entry = vi.hoisted(() => ({ serviceCommand: vi.fn(async () => ({ exitCode: 0 })) }))
vi.mock('../cli/service.js', async importOriginal => ({ ...await importOriginal<typeof import('../cli/service.js')>(), serviceCommand: entry.serviceCommand }))

const { runServiceCommand } = await import('../cli/main.js')

describe('the entry of buckle service', () => {
  const before = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  afterEach(() => {
    if (before) Object.defineProperty(process.stdout, 'isTTY', before)
    else Reflect.deleteProperty(process.stdout, 'isTTY')
  })

  it.each([true, false])('hands the command whether stdout is a terminal: %s', async (isTTY) => {
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true, writable: true })
    expect(await runServiceCommand(['logs'])).toEqual({ exitCode: 0 })
    expect(entry.serviceCommand).toHaveBeenLastCalledWith(expect.objectContaining({ argv: ['logs'], stdoutIsTerminal: isTTY }))
  })
})

import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { createStdioWire } from '../mcp/stdio-wire.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function fixture(maxBufferBytes = 1024) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const transport = createStdioWire({ stdin, stdout, maxBufferBytes })
  const received = vi.fn()
  const errors = vi.fn()
  const closed = vi.fn()
  transport.onmessage = received
  transport.onerror = errors
  transport.onclose = closed
  await transport.start()
  cleanup.push(async () => { await transport.close(); stdin.destroy(); stdout.destroy() })
  return { stdin, stdout, transport, received, errors, closed }
}

it('preserves split UTF-8 frames and multiple newline-delimited requests', async () => {
  const { stdin, received, errors } = await fixture()
  const first = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fs_read', arguments: { path: 'café.txt' } } }
  const bytes = Buffer.from(`${JSON.stringify(first)}\r\n`)
  const split = bytes.indexOf(Buffer.from('é')) + 1
  stdin.write(bytes.subarray(0, split))
  expect(received).not.toHaveBeenCalled()
  stdin.write(Buffer.concat([bytes.subarray(split), Buffer.from('{"jsonrpc":"2.0","id":2,"method":"ping"}\n')]))
  expect(received).toHaveBeenCalledTimes(2)
  expect(received.mock.calls[0]?.[0]).toEqual(first)
  expect(errors).not.toHaveBeenCalled()
})

it('reports invalid JSON, invalid RPC envelopes and invalid UTF-8 without forwarding them', async () => {
  const { stdin, received, errors } = await fixture()
  stdin.write('not json\n{"not":"rpc"}\n')
  stdin.write(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]))
  expect(errors).toHaveBeenCalledTimes(3)
  expect(received).not.toHaveBeenCalled()
  expect(errors.mock.calls.every(([error]) => (error as Error).message === 'Invalid MCP stdio message')).toBe(true)
})

it('closes on oversized input before forwarding a frame', async () => {
  const { stdin, received, errors, closed } = await fixture(16)
  stdin.write(Buffer.alloc(17, 'x'))
  expect(errors).toHaveBeenCalledOnce()
  expect(received).not.toHaveBeenCalled()
  expect(closed).toHaveBeenCalledOnce()
})

it('records incomplete EOF framing and closes exactly once', async () => {
  const { stdin, transport, errors, closed } = await fixture()
  stdin.end('{"jsonrpc":')
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
  expect(errors).toHaveBeenCalledOnce()
  expect(errors.mock.calls[0]?.[0]).toEqual(new Error('Incomplete MCP stdio message at end of input'))
  await transport.close()
  expect(closed).toHaveBeenCalledOnce()
})

it('keeps stdout as newline-delimited protocol JSON and refuses sends after close', async () => {
  const { stdout, transport } = await fixture()
  let output = ''
  stdout.on('data', chunk => { output += String(chunk) })
  await transport.send({ jsonrpc: '2.0', id: 1, result: {} })
  expect(output).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n')
  await transport.close()
  await expect(transport.send({ jsonrpc: '2.0', id: 2, result: {} })).rejects.toThrow('closed')
})

it('reports stdout failures safely and rejects the write promise', async () => {
  const stdin = new PassThrough()
  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('private-stream-error-fixture')) } })
  const transport = createStdioWire({ stdin, stdout, maxBufferBytes: 1024 })
  const errors = vi.fn()
  transport.onerror = errors
  await transport.start()
  await expect(transport.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toThrow('MCP stdio write failed')
  await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce())
  expect(errors.mock.calls[0]?.[0]).toEqual(new Error('MCP stdio stream failed'))
  await transport.close()
  stdin.destroy()
})

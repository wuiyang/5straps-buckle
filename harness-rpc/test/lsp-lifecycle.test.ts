import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { createLspConnection } from '../src/packs/dev/lsp-client.js'

function fixture() {
  const input = new PassThrough()
  const output = new PassThrough()
  const onClose = vi.fn()
  return { input, output, onClose, connection: createLspConnection({ input, output, onClose }) }
}

it('rejects pending requests immediately when the language server disconnects', async () => {
  const { input, connection, onClose } = fixture()
  const request = connection.request('initialize', {}, 10000)
  const rejected = expect(request).rejects.toThrow('closed')
  input.emit('end')
  await rejected
  connection.close()
  expect(onClose).toHaveBeenCalledTimes(1)
  await expect(connection.request('initialize', {}, 10000)).rejects.toThrow('closed')
})

it('handles broken output pipes without an uncaught stream error', async () => {
  const { output, connection } = fixture()
  const request = connection.request('initialize', {}, 10000)
  const rejected = expect(request).rejects.toThrow('closed')
  output.emit('error', new Error('broken pipe'))
  await rejected
})

it('rejects oversized frames before buffering an unbounded body', async () => {
  const { input, connection } = fixture()
  const request = connection.request('initialize', {}, 10000)
  const rejected = expect(request).rejects.toThrow('closed')
  input.write('Content-Length: 999999999\r\n\r\n')
  await rejected
})

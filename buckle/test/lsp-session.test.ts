import { beforeEach, expect, it, vi } from 'vitest'
const transport = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn() }))
vi.mock('../common/services/packs/dev/lsp-client.js', () => ({ spawnLspServer: transport.spawn, connectLspSocket: transport.connect }))
import { createSessionPool } from '../common/services/packs/dev/session.js'

/** Every server found outside the workspace, so the pool spawns it by that path. */
const found = (name: string) => ({ path: `/opt/servers/${name}`, argv0: `/opt/bin/${name}` })
function connection() { return { request: vi.fn().mockResolvedValue({}), notify: vi.fn(), close: vi.fn(), diagnosticsFor: vi.fn() } }
beforeEach(() => vi.resetAllMocks())

it('closes failed initialization and allows the next call to retry', async () => {
  const failed = connection(); failed.request.mockRejectedValue(new Error('initialization failed'))
  const ready = connection()
  transport.spawn.mockReturnValueOnce(failed).mockReturnValueOnce(ready)
  const pool = createSessionPool('/workspace', found)
  await expect(pool.get('typescript', null)).rejects.toThrow('initialization failed')
  expect(failed.close).toHaveBeenCalledOnce()
  expect((await pool.get('typescript', null)).connection).toBe(ready)
  pool.closeAll()
})

it('keeps spawned and attached endpoints in separate cached sessions', async () => {
  const spawned = connection(); const attached = connection()
  transport.spawn.mockReturnValue(spawned); transport.connect.mockResolvedValue(attached)
  const pool = createSessionPool('/workspace', found)
  expect((await pool.get('typescript', null)).connection).toBe(spawned)
  expect((await pool.get('typescript', { host: '127.0.0.1', port: 9000 })).connection).toBe(attached)
  expect((await pool.get('typescript', null)).connection).toBe(spawned)
  expect(transport.spawn).toHaveBeenCalledOnce()
  expect(transport.spawn).toHaveBeenCalledWith(expect.objectContaining({ program: { path: '/opt/servers/typescript-language-server', argv0: '/opt/bin/typescript-language-server' } }))
  pool.closeAll()
})

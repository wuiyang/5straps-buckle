import { expect, it, vi } from 'vitest'
import { createDevPack } from '../common/services/packs/dev/index.js'
import { createPathView } from '../common/domain/path-view.js'
import { availableTools } from '../common/domain/pack.js'
import { configFromEnvironment } from './support/workspace-config.js'

const options = { cwd: '/workspace', paths: createPathView({ root: '/workspace', mount: null }), runProcess: vi.fn() }

it('withholds host language servers unless the owner explicitly enables them', () => {
  const disabled = createDevPack(options)
  expect(disabled.unavailableReason).toContain('packs.hostLsp')
  expect(availableTools([disabled])).toEqual([])
  expect(availableTools([createDevPack({ ...options, allowHostLsp: true })]).map(tool => tool.capability.name)).toContain('lsp_hover')
  expect(configFromEnvironment({}).allowHostLsp).toBe(false)
  expect(configFromEnvironment({ BUCKLE_ALLOW_HOST_LSP: 'true' }).allowHostLsp).toBe(true)
})

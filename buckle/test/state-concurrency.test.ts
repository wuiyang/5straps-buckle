import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createJsonFileStore, replaceFile } from '../common/adapters/json-file-store.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { SPAWN_TEST_TIMEOUT_MS } from './spawn-timeout.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function directory() { const root = mkdtempSync('/tmp/buckle-state-'); roots.push(root); return root }

describe('cross-process state updates', () => {
  it('keeps every update from concurrent processes', async () => {
    const root = directory()
    const filePath = join(root, 'state.json')
    const script = join(root, 'increment.mts')
    writeFileSync(script, `
      import { createJsonFileStore } from ${JSON.stringify(new URL('../common/adapters/json-file-store.ts', import.meta.url).href)};
      import { z } from ${JSON.stringify(import.meta.resolve('zod'))};
      const store = createJsonFileStore({filePath: process.argv[2], schema:z.object({count:z.number()}), fallback:{count:0}});
      for(let i=0;i<20;i++) await store.update(state => { const count=state.count; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2); state.count=count+1; });
    `)
    await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), script, filePath])))
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ count: 80 })
  }, SPAWN_TEST_TIMEOUT_MS)

  it('fails closed on corrupt state instead of resetting policy', async () => {
    const filePath = join(directory(), 'policy.json')
    writeFileSync(filePath, '{broken')
    const store = createJsonFileStore({ filePath, schema: z.object({ deny: z.boolean() }), fallback: { deny: false } })
    expect(() => store.read()).toThrow('owner repair')
    await expect(store.update(state => { state.deny = false })).rejects.toThrow('owner repair')
    expect(readFileSync(filePath, 'utf8')).toBe('{broken')
  })

  it('preserves session grants and standing grants independently', async () => {
    const filePath = join(directory(), 'grants.json')
    const first = createFileGrantStore({ filePath, workspace: '/workspace' })
    const second = createFileGrantStore({ filePath, workspace: '/workspace' })
    for (const sessionId of ['first-session', 'second-session']) await first.grant({ sessionId, rule: 'write_scope', subject: '/workspace', scope: 'session' })
    const standing = await second.grant({ sessionId: 'owner', rule: 'write_scope', subject: '/workspace', scope: 'always' })
    expect(first.list()).toHaveLength(3)
    await second.revoke(standing.id)
    expect(first.activeSubjects({ sessionId: 'first-session', rule: 'write_scope' })).toEqual(['/workspace'])
    expect(second.activeSubjects({ sessionId: 'second-session', rule: 'write_scope' })).toEqual(['/workspace'])
    await first.endSession('first-session')
    expect(second.activeSubjects({ sessionId: 'second-session', rule: 'write_scope' })).toEqual(['/workspace'])
    expect(first.activeSubjects({ sessionId: 'first-session', rule: 'write_scope' })).toEqual([])
  })
})

describe('in-process state updates', () => {
  it('runs concurrent updates of one file in turn, each awaited change seeing the one before', async () => {
    const filePath = join(directory(), 'counter.json')
    const store = createJsonFileStore({ filePath, schema: z.object({ count: z.number() }), fallback: { count: 0 } })
    await Promise.all(Array.from({ length: 10 }, () => store.update(async (state) => {
      const count = state.count
      await new Promise(resolve => setImmediate(resolve))
      state.count = count + 1
    })))
    expect(store.read()).toEqual({ count: 10 })
  })

  it('refuses an update nested in another update of the same file instead of waiting for itself', async () => {
    const filePath = join(directory(), 'nested.json')
    const store = createJsonFileStore({ filePath, schema: z.object({ count: z.number() }), fallback: { count: 0 } })
    await expect(store.update(() => store.update(state => { state.count = 1 }))).rejects.toThrow('nested updates are not supported')
    expect(store.read()).toEqual({ count: 0 })
  })

  it('allows an update that merely started inside another one and runs after it ended', async () => {
    const filePath = join(directory(), 'follow-up.json')
    const store = createJsonFileStore({ filePath, schema: z.object({ count: z.number() }), fallback: { count: 0 } })
    const followUp = Promise.withResolvers<void>()
    await store.update(state => {
      state.count = 1
      setTimeout(() => { store.update(later => { later.count += 1 }).then(followUp.resolve, followUp.reject) }, 50)
    })
    await followUp.promise
    expect(store.read()).toEqual({ count: 2 })
  })
})

// Windows refuses a rename over a file another handle holds open, with EPERM or EBUSY, until that handle closes.
describe('replacing a state file another handle holds open', () => {
  const failing = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })

  it('tries the rename again a short pause apart until it lands', async () => {
    const rename = vi.fn().mockImplementationOnce(() => { throw failing('EPERM') }).mockImplementationOnce(() => { throw failing('EBUSY') }).mockImplementation(() => {})
    const pause = vi.fn(async () => {})
    await replaceFile('state.json.tmp', 'state.json', { rename, pause })
    expect(rename).toHaveBeenCalledTimes(3)
    expect(pause.mock.calls).toEqual([[20], [40]])
  })

  it('gives up after five tries with the last failure, and throws any other failure at once', async () => {
    const held = vi.fn(() => { throw failing('EBUSY') })
    const pause = vi.fn(async () => {})
    await expect(replaceFile('a', 'b', { rename: held, pause })).rejects.toMatchObject({ code: 'EBUSY' })
    expect(held).toHaveBeenCalledTimes(5)
    expect(pause).toHaveBeenCalledTimes(4)
    const missing = vi.fn(() => { throw failing('ENOENT') })
    await expect(replaceFile('a', 'b', { rename: missing, pause: vi.fn(async () => {}) })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(missing).toHaveBeenCalledTimes(1)
  })

  it('replaces the file on disk', async () => {
    const root = directory()
    writeFileSync(join(root, 'state.json'), 'old')
    writeFileSync(join(root, 'state.json.tmp'), 'new')
    await replaceFile(join(root, 'state.json.tmp'), join(root, 'state.json'))
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe('new')
  })
})

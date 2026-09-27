import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createJsonFileStore } from '../common/adapters/json-file-store.js'
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
      for(let i=0;i<20;i++) store.update(state => { const count=state.count; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2); state.count=count+1; });
    `)
    await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), script, filePath])))
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ count: 80 })
  }, SPAWN_TEST_TIMEOUT_MS)

  it('fails closed on corrupt state instead of resetting policy', () => {
    const filePath = join(directory(), 'policy.json')
    writeFileSync(filePath, '{broken')
    const store = createJsonFileStore({ filePath, schema: z.object({ deny: z.boolean() }), fallback: { deny: false } })
    expect(() => store.read()).toThrow('owner repair')
    expect(() => store.update(state => { state.deny = false })).toThrow('owner repair')
    expect(readFileSync(filePath, 'utf8')).toBe('{broken')
  })

  it('preserves session grants and standing grants independently', () => {
    const filePath = join(directory(), 'grants.json')
    const first = createFileGrantStore({ filePath, workspace: '/workspace' })
    const second = createFileGrantStore({ filePath, workspace: '/workspace' })
    for (const sessionId of ['first-session', 'second-session']) first.grant({ sessionId, rule: 'write_scope', subject: '/workspace', scope: 'session' })
    const standing = second.grant({ sessionId: 'owner', rule: 'write_scope', subject: '/workspace', scope: 'always' })
    expect(first.list()).toHaveLength(3)
    second.revoke(standing.id)
    expect(first.activeSubjects({ sessionId: 'first-session', rule: 'write_scope' })).toEqual(['/workspace'])
    expect(second.activeSubjects({ sessionId: 'second-session', rule: 'write_scope' })).toEqual(['/workspace'])
    first.endSession('first-session')
    expect(second.activeSubjects({ sessionId: 'second-session', rule: 'write_scope' })).toEqual(['/workspace'])
    expect(first.activeSubjects({ sessionId: 'first-session', rule: 'write_scope' })).toEqual([])
  })
})

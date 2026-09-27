import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { readFileEntry, writeFileEntry } from '../common/services/packs/fs/operations.js'
import { readInput, writeInput } from '../common/services/packs/fs/schemas.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(content: string | Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'buckle-editor-'))
  roots.push(root)
  await writeFile(join(root, 'note.txt'), content)
  const context = { paths: createPathView({ root, mount: '/workspace' }) }
  const result = await readFileEntry(readInput.parse({ path: 'note.txt' }), context) as { hash: string }
  return { root, context, hash: result.hash }
}
it('rejects an editor save when the file has changed', async () => {
  const { root, context, hash } = await fixture('original')
  await writeFile(join(root, 'note.txt'), 'owner edit')
  await expect(writeFileEntry(writeInput.parse({ path: 'note.txt', content: 'agent edit', expectedHash: hash }), context)).rejects.toThrow('changed since')
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('owner edit')
})
it('supports saving an empty file using its read revision', async () => {
  const { root, context, hash } = await fixture('')
  await writeFileEntry(writeInput.parse({ path: 'note.txt', content: 'new text', expectedHash: hash }), context)
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('new text')
})

// Load allowance, not a slow test: this spins up a full runtime and can miss the
// default 5000 ms budget when the whole workspace suite runs concurrently.
it('omits credential and denied symlink names from directory listing and file search', async () => {
  const { root } = await fixture('visible')
  const { symlink } = await import('node:fs/promises')
  const { createRuntime } = await import('../common/services/workspaces/workspace-runtime.js')
  const { loadConfig } = await import('../common/runtime/config.js')
  const state = await mkdtemp(join(tmpdir(), 'buckle-editor-state-'))
  roots.push(state)
  await writeFile(join(root, '.env'), 'PRIVATE_FIXTURE=value')
  await symlink('/etc/passwd', join(root, 'outside-link'))
  const runtime = await createRuntime({ config: loadConfig({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_WORKSPACE_MOUNT: '/workspace', BUCKLE_STATE_DIR: state, BUCKLE_ALLOW_SHELL: 'false' }) })
  for (const tool of ['fs_list', 'fs_find_names']) {
    const response = await runtime.invoke({ request: { requestId: tool, tool, args: { path: '.', pattern: '*', includeIgnored: true }, approvalTokens: [] }, sessionId: 'editor' })
    expect(response.outcome).toBe('ok')
    const output = JSON.stringify(response)
    expect(output).toContain('note.txt')
    expect(output).not.toContain('.env')
    expect(output).not.toContain('outside-link')
    expect(output).not.toContain('actions.jsonl')
  }
}, 20000)

it('marks invalid UTF-8 as unsafe to edit without rejecting a valid replacement character', async () => {
  const invalid = await fixture(Buffer.from([0x61, 0xc3, 0x28]))
  expect(await readFileEntry(readInput.parse({ path: 'note.txt' }), invalid.context)).toMatchObject({ encoding: 'utf8', validUtf8: false })
  const valid = await fixture('valid \uFFFD text')
  expect(await readFileEntry(readInput.parse({ path: 'note.txt' }), valid.context)).toMatchObject({ encoding: 'utf8', validUtf8: true })
})

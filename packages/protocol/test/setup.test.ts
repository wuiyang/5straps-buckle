import { describe, expect, it } from 'vitest'
import { SetupWorkspaceStatusSchema } from '../src/index.js'

// The workspace-model follow-up, M2: the setup face's status names the workspace's mount table in `workspace.mounts`,
// an additive and optional field, so a reader written before it, Rings among them, ignores it (protocol version 1).

const OLDER_NODE = { root: '/srv/project', mount: '/workspace', displayRoot: '/workspace' }
const NEWER_NODE = {
  ...OLDER_NODE,
  mounts: [
    { source: '/srv/project', target: '/workspace', access: 'rw', from: 'folder' },
    { source: '/srv/data', target: '/data', access: 'ro', from: 'workspace' },
    { source: '/srv/docs', target: '/docs', access: 'ro', from: 'node default' },
    { source: '/srv/scratch', target: '/srv/scratch', access: 'rw', from: 'node scratch root' },
  ],
}

describe('the setup status workspace object', () => {
  it('validates an older node\'s answer, which names no mount table', () => {
    expect(SetupWorkspaceStatusSchema.parse(OLDER_NODE)).toEqual(OLDER_NODE)
    expect(SetupWorkspaceStatusSchema.parse({ ...OLDER_NODE, mount: null, displayRoot: '/srv/project' }).mount).toBeNull()
  })

  it('carries the mount table rows as buckle workspace mount list --json prints them', () => {
    expect(SetupWorkspaceStatusSchema.parse(NEWER_NODE)).toEqual(NEWER_NODE)
  })

  it('stays additive: a reader built on the fields before it still reads a newer answer, the table left aside', () => {
    const older = SetupWorkspaceStatusSchema.omit({ mounts: true })
    expect(older.parse(NEWER_NODE)).toEqual(OLDER_NODE)
    expect(Object.keys(SetupWorkspaceStatusSchema.shape)).toEqual(['root', 'mount', 'displayRoot', 'mounts'])
    expect(SetupWorkspaceStatusSchema.shape.mounts.safeParse(undefined).success).toBe(true)
  })

  it('refuses a row whose access or origin it does not know', () => {
    expect(SetupWorkspaceStatusSchema.safeParse({ ...OLDER_NODE, mounts: [{ ...NEWER_NODE.mounts[0], access: 'write' }] }).success).toBe(false)
    expect(SetupWorkspaceStatusSchema.safeParse({ ...OLDER_NODE, mounts: [{ ...NEWER_NODE.mounts[0], from: 'system' }] }).success).toBe(false)
  })
})

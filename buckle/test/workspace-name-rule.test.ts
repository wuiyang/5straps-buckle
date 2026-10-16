import { describe, expect, it } from 'vitest'
import { SignedRequestPayloadSchema, SIGNED_WORKSPACE_MAX } from '@5straps/protocol/signed-request'
import { NewWorkspaceNameSchema, WorkspaceNameSchema } from '../common/services/workspaces/registry.js'
import { WorkspacePatchSchema, WorkspaceRegistrationSchema } from '../common/services/workspaces/workspace-manager.js'

// Fix brief 4, findings 37 and 38: a name given now reaches every route as one path segment as typed, and fits what a
// signed request names a workspace by. A name already stored keeps whatever 0.1 or the move gave it.

const UNREACHABLE = ['team/api', 'team\\api', '.', '..', 'a%2Fb', '100%', 'tab\there', 'bell\u0007', 'n'.repeat(SIGNED_WORKSPACE_MAX + 1),
  // A command line reads a leading dash as an option, and no URL carries an unpaired surrogate (finding 49 of the third re-check).
  '-site', '--all', '--', '-', 'a\ud800b', 'b\udc00']

describe('a workspace name given now', () => {
  it.each(UNREACHABLE)('refuses %j, at registration, at rename, and as a name', (name) => {
    expect(NewWorkspaceNameSchema.safeParse(name).success).toBe(false)
    expect(WorkspaceRegistrationSchema.safeParse({ name, dir: '/srv/site' }).success).toBe(false)
    expect(WorkspaceRegistrationSchema.safeParse({ id: name, dir: '/srv/site' }).success).toBe(false)
    expect(WorkspacePatchSchema.safeParse({ name }).success).toBe(false)
  })

  it.each(['site', 'The site', 'café', 'a.b', '.hidden', 'my-project_2', 'n'.repeat(SIGNED_WORKSPACE_MAX)])('takes %j', (name) => {
    expect(NewWorkspaceNameSchema.parse(name)).toBe(name)
    expect(WorkspaceRegistrationSchema.safeParse({ name, dir: '/srv/site' }).success).toBe(true)
  })

  it('says what a name may be when it refuses one', () => {
    const issue = (name: string) => NewWorkspaceNameSchema.safeParse(name).error?.issues.map(item => item.message).join('; ')
    expect(issue('a/b')).toBe('A name cannot hold /, \\, %, or a control character, and is not . or ..')
    expect(issue('n'.repeat(65))).toBe('A name is at most 64 characters')
    expect(issue('-site')).toBe('A name does not begin with -')
    expect(issue('a\ud800b')).toBe('A name holds no unpaired surrogate')
  })

  it('is no longer than a signed request can name', () => {
    const payload = { v: 1, purpose: 'buckle-setup', node: 'n', nodeKey: `SHA256:${'A'.repeat(43)}`, method: 'GET', path: '/x', bodySha256: 'a'.repeat(64), nonce: 'A'.repeat(22), issuedAt: 1, expiresAt: 2, keyId: `SHA256:${'A'.repeat(43)}` }
    expect(SignedRequestPayloadSchema.safeParse({ ...payload, workspace: 'n'.repeat(SIGNED_WORKSPACE_MAX) }).success).toBe(true)
    expect(SignedRequestPayloadSchema.safeParse({ ...payload, workspace: 'n'.repeat(SIGNED_WORKSPACE_MAX + 1) }).success).toBe(false)
  })
})

describe('a workspace name already stored', () => {
  it.each(['team/api', 'n'.repeat(120), '..', '-site'])('is still read when it is %j, so a registry from 0.1 or the move stays readable', (name) => {
    expect(WorkspaceNameSchema.safeParse(name).success).toBe(true)
  })
})

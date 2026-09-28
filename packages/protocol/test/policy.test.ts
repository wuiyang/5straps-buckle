import { describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy, WorkspacePolicySchema, WorkspacePolicyUpdateSchema } from '../src/index.js'

describe('a workspace policy document (review H1 of B20-B22)', () => {
  it('holds no dangerously-allow switch: Buckle keeps the switch in its own file', () => {
    const named = { ...emptyWorkspacePolicy(), dangerouslyAllow: { commands: true, fileReads: true } }
    expect(Object.keys(WorkspacePolicySchema.parse(named))).not.toContain('dangerouslyAllow')
    expect(Object.keys(WorkspacePolicyUpdateSchema.parse(named))).not.toContain('dangerouslyAllow')
    expect(Object.keys(WorkspacePolicySchema.shape)).not.toContain('dangerouslyAllow')
  })
})

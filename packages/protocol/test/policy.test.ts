import { describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy, WorkspacePolicySchema, WorkspacePolicyUpdateSchema } from '../src/index.js'

describe('the dangerously-allow switch in a workspace policy (B20)', () => {
  it('is optional, so a policy without it reads as off', () => {
    const parsed = WorkspacePolicySchema.parse(emptyWorkspacePolicy())
    expect(parsed.dangerouslyAllow).toBeUndefined()
  })

  it('carries both flags, in a stored policy and in an update', () => {
    const flags = { commands: true, fileReads: true }
    expect(WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), dangerouslyAllow: flags }).dangerouslyAllow).toEqual(flags)
    expect(WorkspacePolicyUpdateSchema.parse({ ...emptyWorkspacePolicy(), dangerouslyAllow: flags }).dangerouslyAllow).toEqual(flags)
  })

  it('refuses a missing flag or an unknown key', () => {
    expect(WorkspacePolicySchema.safeParse({ ...emptyWorkspacePolicy(), dangerouslyAllow: { commands: true } }).success).toBe(false)
    expect(WorkspacePolicySchema.safeParse({ ...emptyWorkspacePolicy(), dangerouslyAllow: { commands: true, fileReads: true, writes: true } }).success).toBe(false)
  })
})

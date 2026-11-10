import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { ApprovalDecisionSchema, ApprovalRequestSchema, GrantRecordSchema, InvokeResponseSchema } from '../src/index.js'
import { ApprovalChallengeSchema } from '../src/signed-request.js'

// The file floor's prefixed subjects ride under write_scope (the fs-verbs brief), and the delete policy brief adds an
// ask's optional `widerSubject` and a decision's optional `subject`. A reader pinned to protocol 0.1.7, Rings among them,
// must still parse every ask and every answer: these are the 0.1.7 shapes, copied as released, which strip a field they
// do not know.

const RULES_0_1_7 = z.enum(['sensitive_path', 'destructive_command', 'network_egress', 'filesystem_policy', 'read_scope', 'write_scope', 'process_probe', 'command_policy', 'tool_policy'])
const SCOPES_0_1_7 = z.enum(['once', 'session', 'always'])
const REQUEST_0_1_7 = z.object({
  token: z.string().min(1), rule: RULES_0_1_7, subject: z.string().min(1), reason: z.string().min(1), tool: z.string().min(1),
  offeredScopes: z.array(SCOPES_0_1_7).min(1), expiresAt: z.iso.datetime(),
})
const DECISION_0_1_7 = z.object({ token: z.string().min(1), approved: z.boolean(), scope: SCOPES_0_1_7.default('once'), note: z.unknown().optional() })
const APPROVAL_REQUIRED_0_1_7 = z.object({ requestId: z.string(), outcome: z.literal('approval_required'), approvals: z.array(REQUEST_0_1_7).min(1) })

const FOLDER = '/srv/data/build'
const ask = (subject: string, extra: Record<string, unknown> = {}) => ({
  token: 't1', rule: 'write_scope', subject, reason: 'Deleting /srv/data/build/a.txt asks a person, whatever the folder\'s write grant says',
  tool: 'fs_delete', offeredScopes: ['once', 'session', 'always'], expiresAt: '2026-10-28T12:00:00.000Z', ...extra,
})
const SUBJECTS = [`delete:${FOLDER}`, `delete-tree:${FOLDER}`, `move-tree:${FOLDER}`, `delete-below:${FOLDER}`, `delete-batch:${FOLDER}`, `overwrite:${FOLDER}/a.txt`, `rewrite-batch:${FOLDER}`]

describe('an ask under write_scope with a prefixed subject', () => {
  it.each(SUBJECTS)('parses as %s for a 0.1.7 reader and for this one, its subject unchanged', (subject) => {
    expect(REQUEST_0_1_7.parse(ask(subject)).subject).toBe(subject)
    expect(ApprovalRequestSchema.parse(ask(subject)).subject).toBe(subject)
  })

  it('carries its wider subject to this reader, and a 0.1.7 reader drops it and keeps the subject it approves', () => {
    const wider = ask(`delete:${FOLDER}`, { widerSubject: `delete-below:${FOLDER}` })
    expect(ApprovalRequestSchema.parse(wider)).toMatchObject({ subject: `delete:${FOLDER}`, widerSubject: `delete-below:${FOLDER}` })
    expect(REQUEST_0_1_7.parse(wider)).toEqual(ask(`delete:${FOLDER}`))
    const response = { requestId: 'r1', outcome: 'approval_required', approvals: [wider] }
    expect(APPROVAL_REQUIRED_0_1_7.parse(response).approvals[0]).toEqual(ask(`delete:${FOLDER}`))
    expect(InvokeResponseSchema.parse(response)).toMatchObject({ approvals: [{ widerSubject: `delete-below:${FOLDER}` }] })
  })

  it.each(['warn', 'danger'])('carries optional %s severity and remains readable by a 0.1.7 client', (severity) => {
    const request = ask(`delete-tree:${FOLDER}`, { severity, reason: `[${severity}] Major file change needs approval` })
    expect(ApprovalRequestSchema.parse(request)).toMatchObject({ severity })
    expect(REQUEST_0_1_7.parse(request)).toMatchObject({ reason: `[${severity}] Major file change needs approval` })
    expect(REQUEST_0_1_7.parse(request)).not.toHaveProperty('severity')
    const response = { requestId: 'r1', outcome: 'approval_required', approvals: [request] }
    expect(InvokeResponseSchema.parse(response)).toMatchObject({ approvals: [{ severity }] })
    expect(APPROVAL_REQUIRED_0_1_7.safeParse(response).success).toBe(true)
  })

  it('accepts older asks without severity, rejects unknown labels, and keeps strict challenges unchanged', () => {
    expect(ApprovalRequestSchema.parse(ask(`delete:${FOLDER}`))).not.toHaveProperty('severity')
    expect(ApprovalRequestSchema.safeParse(ask(`delete:${FOLDER}`, { severity: 'safe' })).success).toBe(false)
    expect(ApprovalChallengeSchema.shape).not.toHaveProperty('severity')
  })

  it('is absent from an ask that offers none, and is never empty', () => {
    expect(ApprovalRequestSchema.parse(ask(`delete:${FOLDER}`)).widerSubject).toBeUndefined()
    expect(ApprovalRequestSchema.safeParse(ask(`delete:${FOLDER}`, { widerSubject: '' })).success).toBe(false)
  })

  // APPROVAL-37: a device offers the folder and its subfolders too, so the node signs the wider subject into the challenge
  // of a device that asks for it. A challenge without it reads as before; a device's strict parse refuses one with it,
  // which is why a node sends it only on request.
  it('is signed into a challenge where the node sends it, and a challenge without it reads as before', () => {
    const challenge = {
      v: 1, purpose: 'buckle-approval-challenge', node: 'node-1', workspace: 'w1', token: 't1', requestId: null, sessionId: 's1', actor: null,
      tool: 'fs_delete', rule: 'write_scope', subject: `delete:${FOLDER}`, reason: 'asks', offeredScopes: ['once', 'session', 'always'],
      arguments: { paths: [`${FOLDER}/a.txt`] }, cwd: '/w', callDigest: 'a'.repeat(64), description: null, effects: [], expiresAt: '2026-10-28T12:00:00.000Z',
    }
    expect(ApprovalChallengeSchema.parse({ ...challenge, widerSubject: `delete-below:${FOLDER}` }).widerSubject).toBe(`delete-below:${FOLDER}`)
    expect(ApprovalChallengeSchema.parse(challenge)).not.toHaveProperty('widerSubject')
    expect(ApprovalChallengeSchema.safeParse({ ...challenge, widerSubject: '' }).success).toBe(false)
    expect(ApprovalChallengeSchema.omit({ widerSubject: true }).strict().safeParse({ ...challenge, widerSubject: `delete-below:${FOLDER}` }).success).toBe(false)
  })
})

describe('a decision', () => {
  it('from a 0.1.7 sender names no subject, and grants the ask\'s own', () => {
    const decision = DECISION_0_1_7.parse({ token: 't1', approved: true, scope: 'session' })
    expect(ApprovalDecisionSchema.parse(decision)).toEqual({ token: 't1', approved: true, scope: 'session' })
  })

  it('may name the subject it grants, which a 0.1.7 reader drops', () => {
    const named = { token: 't1', approved: true, scope: 'always', subject: `delete-below:${FOLDER}` }
    expect(ApprovalDecisionSchema.parse(named).subject).toBe(`delete-below:${FOLDER}`)
    expect(DECISION_0_1_7.parse(named)).toEqual({ token: 't1', approved: true, scope: 'always' })
    expect(ApprovalDecisionSchema.safeParse({ ...named, subject: '' }).success).toBe(false)
  })

  it('leaves a grant\'s record as it was: the wider subject is a subject like any other', () => {
    const grant = { id: 'g1', workspace: 'w1', rule: 'write_scope', subject: `delete-below:${FOLDER}`, scope: 'always', sessionId: null, createdAt: '2026-10-28T12:00:00.000Z', expiresAt: null }
    expect(GrantRecordSchema.parse(grant).subject).toBe(`delete-below:${FOLDER}`)
  })
})

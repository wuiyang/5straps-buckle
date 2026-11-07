import type { ApprovalRequest } from '@5straps/protocol'
import { describe, expect, it } from 'vitest'
import { askViewDetails, readAskHeadline, readAskView, type AskView } from '../common/domain/approval/ask-view.js'
import { questionFor } from '../common/services/approvals/approval-service.js'

// The typed view of one ask that the serve terminal and the pending log line read, carried as flat details because the
// question may cross to another process (the approval backend design, slice 2).

const whole: AskView = {
  tool: 'fs_delete', rule: 'write_scope', subject: 'delete:/w/one', widerSubject: 'delete-below:/w/one', reason: '[warn] Deleting /w/one/a.txt asks a person',
  severity: 'warn', offeredScopes: ['once', 'session', 'always'], expiresAt: '2026-11-07T10:00:00.000Z', workspaceId: 'w-1', workspaceName: 'The site', node: 'node-1',
  approve: 'buckle approve t-1 --scope session --workspace \'The site\'', judge: 'not asked; the decision AI rates it on request',
  call: { arguments: { paths: ['one/a.txt'], note: 'x\ny' }, cwd: '/workspace', description: 'Delete 1 file', effects: ['delete /w/one/a.txt'] },
}

describe('the ask view a question carries', () => {
  it('reads back every field it was given', () => {
    expect(readAskView(askViewDetails(whole))).toEqual(whole)
  })

  it('reads back a call with no description and no effects, and an ask with no call', () => {
    const bare: AskView = { ...whole, call: { arguments: null, cwd: '/workspace', description: null } }
    expect(readAskView(askViewDetails(bare))).toEqual(bare)
    const { call: _call, ...uncalled } = whole
    expect(readAskView(askViewDetails(uncalled))).toEqual(uncalled)
  })

  it('refuses details that offer no scope or name no known rule', () => {
    expect(() => readAskView({ ...askViewDetails(whole), scopes: '' })).toThrow()
    expect(() => readAskView({ ...askViewDetails(whole), rule: 'made_up' })).toThrow()
  })

  it('reads the pending line\'s fields one by one, where the rest are missing', () => {
    expect(readAskHeadline(askViewDetails(whole))).toEqual({ tool: 'fs_delete', rule: 'write_scope', offeredScopes: ['once', 'session', 'always'], workspaceId: 'w-1', workspaceName: 'The site', approve: whole.approve })
    expect(readAskHeadline({ approve: 'buckle approve t-1' })).toEqual({ approve: 'buckle approve t-1' })
  })
})

describe('the serve terminal\'s question', () => {
  const approval: ApprovalRequest = { token: 't-1', tool: 'fs_write', rule: 'write_scope', subject: '/w/one', reason: 'outside', severity: 'danger', offeredScopes: ['once', 'session'], expiresAt: '2026-11-07T10:00:00.000Z' }
  const call = { arguments: { path: '/w/one/a.md', content: 'a' }, cwd: '/workspace', description: 'Write 1 character', effects: ['write /w/one/a.md'], complete: true as const }

  it('carries the same details, in the same order, as before the view', () => {
    const details = questionFor({ approval, workspaceId: 'w-1', workspaceName: 'The site', node: 'node-1', context: { correlationId: 'c', sessionId: 's', call } }).action.details
    expect(details).toEqual({
      tool: 'fs_write', rule: 'write_scope', subject: '/w/one', reason: 'outside', severity: 'danger', scopes: 'once,session', expiresAt: '2026-11-07T10:00:00.000Z', workspace: 'w-1',
      workspaceName: 'The site', approve: 'buckle approve t-1 --scope session --workspace \'The site\'', node: 'node-1',
      arguments: JSON.stringify(call.arguments), cwd: '/workspace', description: 'Write 1 character', effects: JSON.stringify(call.effects),
    })
    expect(Object.keys(details!)).toEqual(['tool', 'rule', 'subject', 'reason', 'severity', 'scopes', 'expiresAt', 'workspace', 'workspaceName', 'approve', 'node', 'arguments', 'cwd', 'description', 'effects'])
  })

  it('reads back as the ask it was asked about', () => {
    const details = questionFor({ approval: { ...approval, widerSubject: 'delete-below:/w/one' }, workspaceId: 'w-1', context: { correlationId: 'c', sessionId: 's', call } }).action.details
    expect(readAskView(details)).toEqual({
      tool: 'fs_write', rule: 'write_scope', subject: '/w/one', widerSubject: 'delete-below:/w/one', reason: 'outside', severity: 'danger', offeredScopes: ['once', 'session'],
      expiresAt: '2026-11-07T10:00:00.000Z', workspaceId: 'w-1', approve: 'buckle approve t-1 --scope session --workspace w-1',
      call: { arguments: call.arguments, cwd: '/workspace', description: 'Write 1 character', effects: call.effects },
    })
  })
})

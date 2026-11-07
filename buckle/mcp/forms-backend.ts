import { acceptedContent, inputRequired } from '@modelcontextprotocol/server'
import type { ApprovalRequest, GrantScope } from '@5straps/protocol'
import { describeAsk, describeAskOfShownCall, describeCallAsks, type ShownCall } from '../common/domain/approval-instruction.js'
import type { ApprovalBackend, ApprovalHost, BackendCapabilities, DecisionBody, FullAsk, SubmitResult } from '../common/types/ports/approval-backend.js'

interface FormAnswer extends Record<string, unknown> {
  approve?: boolean
  action?: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_session' | 'always_deny'
  scope?: GrantScope
}

export interface FormsBackendOptions {
  /** The workspace each form names, by id and by its name as it stands. */
  workspace: () => { id: string; name: string }
  /** The node's serverId, which each form names as the node's terminal names it. */
  node?: string
  /** Whether --approve-if-safe can approve a safe verdict here, read as each form is drawn. */
  approves: () => boolean
}

/** A stdio MCP host's forms: drawn in the call's own answer, and decided when the retried call carries them back. */
export interface FormsBackend extends ApprovalBackend {
  /** One form per ask of the call. */
  forms(approvals: ApprovalRequest[]): ReturnType<typeof inputRequired>
  /** Decides each accepted answer through the host, and gives the tokens it recorded, which the retried call spends. */
  answer(responses: Record<string, unknown> | undefined): Promise<string[]>
}

const CAPABILITIES: BackendCapabilities = { contractVersion: 1, decides: true, scopes: ['once', 'session', 'always'], cancels: false, revokes: false }
const IN_THE_ANSWER: SubmitResult = { kind: 'declined', reason: 'a stdio host\'s forms ride in the answer to the call that asked' }
const ALLOW_LABELS: Readonly<Record<GrantScope, string>> = { once: 'Allow once', session: 'Allow this session', always: 'Always allow' }

export function createFormsBackend(options: FormsBackendOptions): FormsBackend {
  let host: ApprovalHost | undefined
  let closed = false
  const live = () => (closed ? undefined : host)

  return {
    async open(opener) {
      host ??= opener
      return CAPABILITIES
    },

    submit: async () => IN_THE_ANSWER,

    async notify() {},

    async close() {
      closed = true
    },

    forms(approvals) {
      return formsFor({ approvals, waiting: live()?.pending() ?? [], options })
    },

    async answer(responses) {
      const opened = live()
      if (!opened || !responses) return []
      const waiting = new Map(opened.pending().map(ask => [ask.token, ask]))
      const tokens: string[] = []
      for (const token of Object.keys(responses)) {
        const answer = acceptedContent<FormAnswer>(responses, token)
        if (!answer) continue
        const decision = decisionOf(token, answer)
        // Owner decision D17: an ask whose whole call was never kept was never shown whole, so no answer approves it.
        const asked = waiting.get(token)
        if (decision.outcome === 'approve' && asked !== undefined && asked.action === undefined) {
          opened.log('warn', 'Elicited approval refused: the ask was recorded before this build, so its whole action was never shown')
          continue
        }
        const receipt = await opened.decide({ kind: 'plain', decision })
        if (receipt.status !== 'refused') tokens.push(token)
        else opened.log('warn', 'Elicited approval was rejected', { reason: receipt.error.message })
      }
      return tokens
    },
  }
}

function decisionOf(token: string, answer: FormAnswer): DecisionBody {
  const approved = answer.action ? answer.action.startsWith('allow_') : answer.approve === true
  const scope: GrantScope = answer.action === 'deny_session' || answer.action === 'allow_session' ? 'session' : answer.action === 'always_deny' || answer.action === 'allow_always' ? 'always' : answer.action ? 'once' : answer.scope ?? 'once'
  return { token, outcome: approved ? 'approve' : 'deny', scope }
}

/**
 * One form per ask, whose message is the whole action as the node's terminal shows it (owner decision D17): the ask, then
 * every argument, the directory, the effects and the node's summary from the call the ask recorded. An ask whose whole
 * call was not kept has none: its form says so and offers denials only. A call that made several asks is shown whole
 * once, in the form of its first ask, which lists the others; each other form names that ask.
 */
function formsFor(input: { approvals: ApprovalRequest[]; waiting: FullAsk[]; options: FormsBackendOptions }) {
  const { options } = input
  const workspace = options.workspace()
  const asked = new Map(input.waiting.map(ask => [ask.token, ask]))
  const groupOf = (token: string) => asked.get(token)?.group
  const shownWith = new Map<string, string>()
  const inputRequests = Object.fromEntries(input.approvals.map((approval) => {
    const ask = asked.get(approval.token)
    const call = ask === undefined ? undefined : shownCallOf(ask)
    const group = groupOf(approval.token)
    const shown = { ...approval, workspaceId: workspace.id, workspaceName: workspace.name, approves: options.approves(), ...(options.node === undefined ? {} : { node: options.node }), ...(call ? { call } : {}) }
    const earlier = group === undefined ? undefined : shownWith.get(group)
    if (call && group !== undefined && earlier === undefined) shownWith.set(group, approval.token)
    const asks = group === undefined ? [] : input.approvals.filter(other => groupOf(other.token) === group)
    const lines = !call ? describeAsk(shown) : earlier !== undefined ? describeAskOfShownCall(shown, earlier) : [...describeAsk(shown), ...(asks.length > 1 ? describeCallAsks(asks) : [])]
    const message = lines.join('\n')
    return [approval.token, call ? approvalForm({ approval, message }) : denialForm({ approval, message })]
  }))
  return inputRequired({ inputRequests })
}

/** The whole call a form shows, where the ask came with one. */
function shownCallOf(ask: FullAsk): ShownCall | undefined {
  return ask.action === undefined ? undefined : { ...ask.action, judge: ask.risk.notes }
}

function approvalForm(input: { approval: ApprovalRequest; message: string }) {
  const { approval } = input
  return inputRequired.elicit({
    message: input.message,
    requestedSchema: {
      type: 'object',
      // A credential file is allowed once; a secret file's use offers each scope its ask does (docs/user/how-to/secrets.md).
      properties: approval.rule === 'sensitive_path' ? {
        action: { type: 'string', enum: [...approval.offeredScopes.map(scope => `allow_${scope}`), 'deny', 'deny_session', 'always_deny'], description: `${approval.offeredScopes.map(scope => ALLOW_LABELS[scope]).join(', ')}, Deny, Deny this session, Always deny` },
      } : {
        approve: { type: 'boolean', description: 'Allow this operation' },
        scope: {
          type: 'string',
          enum: approval.offeredScopes,
          description: 'once, this session, or always for this subject',
        },
      },
      required: [approval.rule === 'sensitive_path' ? 'action' : 'approve'],
    },
  })
}

/** An ask nobody was shown whole: it may be denied here, never approved. */
function denialForm(input: { approval: ApprovalRequest; message: string }) {
  const sensitive = input.approval.rule === 'sensitive_path'
  return inputRequired.elicit({
    message: input.message,
    requestedSchema: {
      type: 'object',
      properties: {
        action: sensitive
          ? { type: 'string', enum: ['deny', 'deny_session', 'always_deny'], description: 'Deny, Deny this session, Always deny' }
          : { type: 'string', enum: ['deny'], description: 'Deny' },
      },
      required: ['action'],
    },
  })
}

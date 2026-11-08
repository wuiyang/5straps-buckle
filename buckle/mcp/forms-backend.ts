import { acceptedContent, inputRequired } from '@modelcontextprotocol/server'
import type { ApprovalRequest, GrantScope } from '@5straps/protocol'
import { approveCommand, describeAsk, describeAskOfShownCall, describeCallAsks, type ShownCall } from '../common/domain/approval-instruction.js'
import type { AnswerSender, ApprovalBackend, ApprovalHost, BackendCapabilities, DecisionBody, FullAsk, SourceReach, SubmitResult } from '../common/types/ports/approval-backend.js'

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

/**
 * An MCP host's forms: drawn in the call's own answer, and decided when the retried call carries them back. Each form
 * offers what its host's source may decide, and no more.
 */
export interface FormsBackend extends ApprovalBackend {
  /** One form per ask of the call. */
  forms(approvals: ApprovalRequest[]): ReturnType<typeof inputRequired>
  /**
   * Decides each accepted answer through the host, with the sender the face's transport authenticated, and gives the
   * tokens it recorded, which the retried call spends.
   */
  answer(responses: Record<string, unknown> | undefined, sender?: AnswerSender): Promise<string[]>
}

const CAPABILITIES: BackendCapabilities = { contractVersion: 1, decides: true, scopes: ['once', 'session', 'always'], cancels: false, revokes: false }
const IN_THE_ANSWER: SubmitResult = { kind: 'declined', reason: 'an MCP host\'s forms ride in the answer to the call that asked' }
const ALLOW_LABELS: Readonly<Record<GrantScope, string>> = { once: 'Allow once', session: 'Allow this session', always: 'Always allow' }
type Denial = 'deny' | 'deny_session' | 'always_deny'
const DENIAL_LABELS: Readonly<Record<Denial, string>> = { deny: 'Deny', deny_session: 'Deny this session', always_deny: 'Always deny' }
// Forms that are not open draw what nothing that outlives the call or approves a floor ask may answer.
const NO_REACH: SourceReach = { lasting: false, floor: false }

export function createFormsBackend(options: FormsBackendOptions): FormsBackend {
  let host: ApprovalHost | undefined
  let closed = false
  // The answers still being decided, which close waits for.
  const answering = new Set<Promise<string[]>>()
  const live = () => (closed ? undefined : host)

  async function decideAnswers(responses: Record<string, unknown>, sender: AnswerSender | undefined): Promise<string[]> {
    const tokens: string[] = []
    for (const token of Object.keys(responses)) {
      const answer = acceptedContent<FormAnswer>(responses, token)
      if (!answer) continue
      const opened = live()
      if (!opened) break
      const receipt = await opened.decide({ kind: 'plain', decision: decisionOf(token, answer) }, sender)
      if (receipt.status === 'refused') {
        opened.log('warn', 'Elicited approval was rejected', { reason: receipt.error.message })
        continue
      }
      tokens.push(token)
      if (receipt.save === 'owed') opened.log('warn', 'An elicited approval was recorded, but the lasting grant it makes is not written yet, so its calls ask again until it is', { token })
    }
    return tokens
  }

  return {
    async open(opener) {
      host ??= opener
      return CAPABILITIES
    },

    submit: async () => IN_THE_ANSWER,

    async notify() {},

    async close() {
      closed = true
      await Promise.allSettled([...answering])
    },

    forms(approvals) {
      const opened = live()
      return formsFor({ approvals, waiting: opened?.pending() ?? [], reach: opened?.reach ?? NO_REACH, options })
    },

    answer(responses, sender) {
      if (!live() || !responses) return Promise.resolve([])
      const run = decideAnswers(responses, sender)
      answering.add(run)
      const forget = () => { answering.delete(run) }
      run.then(forget, forget)
      return run
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
 * once, in the form of its first ask, which lists the others; each other form names that ask. Each form offers what the
 * host's source may decide: a floor ask it may not approve is a denial naming where a person approves it, and a scope
 * past the call it may not grant is left out, naming where it is granted.
 */
function formsFor(input: { approvals: ApprovalRequest[]; waiting: FullAsk[]; reach: SourceReach; options: FormsBackendOptions }) {
  const { options, reach } = input
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
    const named = { workspaceId: workspace.id, workspaceName: workspace.name, request: approval }
    const scopes = reach.lasting ? approval.offeredScopes : approval.offeredScopes.filter(scope => scope === 'once')
    const approvable = call !== undefined && scopes.length > 0 && (reach.floor || ask?.policy.floor !== true)
    const note = call === undefined ? [] : !approvable ? [floorNote(approveCommand(named))] : scopes.length < approval.offeredScopes.length ? [onceNote(approveCommand(named))] : []
    const message = [...lines, ...note].join('\n')
    return [approval.token, approvable ? approvalForm({ approval, message, scopes, reach }) : denialForm({ approval, message, reach })]
  }))
  return inputRequired({ inputRequests })
}

function floorNote(command: string): string {
  return `  approve:  a person approves this at the node, at the serve terminal or with ${command}; this form only denies it`
}

function onceNote(command: string): string {
  return `  scope:    this form approves it once; for the session or always, approve it at the serve terminal or with ${command}`
}

/** The whole call a form shows, where the ask came with one. */
function shownCallOf(ask: FullAsk): ShownCall | undefined {
  return ask.action === undefined ? undefined : { ...ask.action, judge: ask.risk.notes }
}

/** The denials a form offers a credential file's ask: a lasting one only where the host's source may decide past the call. */
function denialsOf(reach: SourceReach): Denial[] {
  return reach.lasting ? ['deny', 'deny_session', 'always_deny'] : ['deny']
}

function approvalForm(input: { approval: ApprovalRequest; message: string; scopes: GrantScope[]; reach: SourceReach }) {
  const { approval, scopes } = input
  const denials = denialsOf(input.reach)
  return inputRequired.elicit({
    message: input.message,
    requestedSchema: {
      type: 'object',
      // A credential file is allowed once; a secret file's use offers each scope its ask does (docs/user/how-to/secrets.md).
      properties: approval.rule === 'sensitive_path' ? {
        action: { type: 'string', enum: [...scopes.map(scope => `allow_${scope}`), ...denials], description: [...scopes.map(scope => ALLOW_LABELS[scope]), ...denials.map(denial => DENIAL_LABELS[denial])].join(', ') },
      } : {
        approve: { type: 'boolean', description: 'Allow this operation' },
        scope: {
          type: 'string',
          enum: scopes,
          description: scopes.length === 1 ? 'once, for this call alone' : 'once, this session, or always for this subject',
        },
      },
      required: [approval.rule === 'sensitive_path' ? 'action' : 'approve'],
    },
  })
}

/** An ask nobody was shown whole, or one the host's source may not approve: it may be denied here, never approved. */
function denialForm(input: { approval: ApprovalRequest; message: string; reach: SourceReach }) {
  const denials = input.approval.rule === 'sensitive_path' ? denialsOf(input.reach) : ['deny' as const]
  return inputRequired.elicit({
    message: input.message,
    requestedSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: denials, description: denials.map(denial => DENIAL_LABELS[denial]).join(', ') },
      },
      required: ['action'],
    },
  })
}

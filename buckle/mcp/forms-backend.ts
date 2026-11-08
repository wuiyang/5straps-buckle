import { acceptedContent, inputRequired, inputResponse } from '@modelcontextprotocol/server'
import { GrantScopeSchema, type ApprovalRequest, type GrantScope } from '@5straps/protocol'
import { z } from 'zod'
import { saveEndingLine, settleUnsaved, unsavedOf, type SaveAnswer, type SaveEnding, type SaveRoute, type Unsaved, type UnsavedKind } from '../common/adapters/approval/grant-save-question.js'
import { approveCommand, describeAsk, describeAskOfShownCall, describeCallAsks, type ShownCall } from '../common/domain/approval-instruction.js'
import type { AnswerSender, ApprovalBackend, ApprovalHost, BackendCapabilities, DecisionBody, FullAsk, SourceReach, SubmitResult } from '../common/types/ports/approval-backend.js'

// An approval form's answer names its approval or its action; one that names neither, a save answer among them, is none.
const FormAnswerSchema = z.object({
  approve: z.boolean().optional(),
  action: z.enum(['allow_once', 'allow_session', 'allow_always', 'deny', 'deny_session', 'always_deny']).optional(),
  scope: GrantScopeSchema.optional(),
}).refine(answer => answer.approve !== undefined || answer.action !== undefined)
type FormAnswer = z.infer<typeof FormAnswerSchema>
const SaveAnswerSchema = z.object({ save: z.enum(['retry', 'skip']) })

export interface FormsBackendOptions {
  /** The workspace each form names, by id and by its name as it stands. */
  workspace: () => { id: string; name: string }
  /** The node's serverId, which each form names as the node's terminal names it. */
  node?: string
  /** Whether --approve-if-safe can approve a safe verdict here, read as each form is drawn. */
  approves: () => boolean
}

/** A decision whose lasting part did not save, which a save form asks about before the call runs. */
export interface UnsavedDecision { decision: DecisionBody; unsaved: Unsaved }

/** What a call's answers came to: the tokens the call sent again spends, and the decisions whose lasting part did not save. */
export interface FormsAnswered { tokens: string[]; unsaved: UnsavedDecision[] }

/**
 * An MCP host's forms: drawn in the call's own answer, and decided when the retried call carries them back. Each form
 * offers what its host's source may decide, and no more.
 */
export interface FormsBackend extends ApprovalBackend {
  /** One form per ask of the call. */
  forms(approvals: ApprovalRequest[]): ReturnType<typeof inputRequired>
  /**
   * Decides each accepted answer through the host, with the sender the face's transport authenticated: an approval form's
   * under its ask's token, and a save form's under `save:<token>`, read only where this backend drew that sender that
   * save form. A save answer is settled once and draws no further save form.
   */
  answer(responses: Record<string, unknown> | undefined, sender?: AnswerSender): Promise<FormsAnswered>
  /** One save form per decision that did not save, drawn for `sender`; none where every decision saved. */
  saveForms(unsaved: UnsavedDecision[], sender?: AnswerSender): ReturnType<typeof inputRequired> | undefined
}

const CAPABILITIES: BackendCapabilities = { contractVersion: 1, decides: true, scopes: ['once', 'session', 'always'], cancels: false, revokes: false }
const IN_THE_ANSWER: SubmitResult = { kind: 'declined', reason: 'an MCP host\'s forms ride in the answer to the call that asked' }
const ALLOW_LABELS: Readonly<Record<GrantScope, string>> = { once: 'Allow once', session: 'Allow this session', always: 'Always allow' }
type Denial = 'deny' | 'deny_session' | 'always_deny'
const DENIAL_LABELS: Readonly<Record<Denial, string>> = { deny: 'Deny', deny_session: 'Deny this session', always_deny: 'Always deny' }
// Forms that are not open draw what nothing that outlives the call or approves a floor ask may answer.
const NO_REACH: SourceReach = { lasting: false, floor: false, sameCaller: true }
/** A call makes at most as many asks as one session keeps waiting (50), so one round of its forms comes back under no more keys. */
export const MOST_FORM_ANSWERS = 50
/** The key a save form's answer comes under, before its decision's token, so it never reads as an approval form's. */
const SAVE_KEY = 'save:'
const SETTLED: ReadonlySet<SaveEnding['ending']> = new Set(['saved', 'skipped', 'denied_once'])

/** Per kind of save: the answers its form takes, and what each answer, a decline, and a cancel do. */
const SAVE_FORMS: Readonly<Record<UnsavedKind, { answers: SaveAnswer[]; choices: string }>> = {
  approval: { answers: ['retry', 'skip'], choices: 'Retry the save; skip gives it up, so later calls ask again. Declining skips it, and cancelling leaves it to be saved later. Either way the call runs once.' },
  denial: { answers: ['retry', 'skip'], choices: 'Retry the save; skip denies this call once instead. Declining skips it, and cancelling leaves the call waiting.' },
  removal: { answers: ['retry'], choices: 'Retry the removal; declining or cancelling leaves it to the next decision or the workspace opening again, which remove it.' },
}

export function createFormsBackend(options: FormsBackendOptions): FormsBackend {
  let host: ApprovalHost | undefined
  let closed = false
  // The answers still being decided, which close waits for.
  const answering = new Set<Promise<FormsAnswered>>()
  // The save forms drawn and not answered yet, by token, with the caller each was drawn for.
  const saveQuestions = new Map<string, UnsavedDecision & { caller: string | undefined }>()
  const live = () => (closed ? undefined : host)

  async function decideAnswers(responses: Record<string, unknown>, sender: AnswerSender | undefined): Promise<FormsAnswered> {
    const answered: FormsAnswered = { tokens: [], unsaved: [] }
    const host = live()
    if (!host) return answered
    const keys = roundKeys({ host, responses })
    const waiting = answerableAsks({ host, sender, keys })
    for (const key of keys) {
      const opened = live()
      if (!opened) break
      if (key.startsWith(SAVE_KEY)) {
        const token = key.slice(SAVE_KEY.length)
        if (await settleSave({ host: opened, token, answer: saveAnswerIn(responses, key), sender })) answered.tokens.push(token)
        continue
      }
      if (!waiting.has(key)) continue
      const answer = acceptedContent(responses, key, FormAnswerSchema)
      if (!answer) continue
      const decision = decisionOf(key, answer)
      const receipt = await opened.decide({ kind: 'plain', decision }, sender)
      const unsaved = unsavedOf({ decision, receipt })
      if (unsaved) answered.unsaved.push({ decision, unsaved })
      if (receipt.status === 'refused') {
        opened.log('warn', 'Elicited approval was rejected', { reason: receipt.error.message })
        continue
      }
      answered.tokens.push(key)
      if (receipt.save === 'owed') opened.log('warn', 'An elicited approval was recorded, but the lasting grant it makes is not written yet, so its calls ask again until it is', { token: key })
    }
    return answered
  }

  /** A save form's answer from the caller it was drawn for: settled once, as the shared save question settles it. */
  async function settleSave(input: { host: ApprovalHost; token: string; answer: SaveAnswer | undefined; sender: AnswerSender | undefined }): Promise<boolean> {
    const question = saveQuestions.get(input.token)
    if (question === undefined || question.caller !== input.sender?.caller) return false
    saveQuestions.delete(input.token)
    const { decision, unsaved } = question
    let given = input.answer
    const route: SaveRoute = {
      // One save form per call: a save that fails again is left, and asked about no more.
      ask: async () => {
        const answer = given
        given = undefined
        return answer
      },
      retry: () => input.host.decide({ kind: 'plain', decision }, input.sender),
      skipSave: () => input.host.skipSave(decision.token, input.sender),
      denyOnce: () => input.host.decide({ kind: 'plain', decision: { token: decision.token, outcome: 'deny', scope: 'once' } }, input.sender),
    }
    const ending = await settleUnsaved({ decision, unsaved, route })
    input.host.log(SETTLED.has(ending.ending) ? 'info' : 'warn', saveEndingLine(ending), { token: input.token })
    return true
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
      saveQuestions.clear()
      await Promise.allSettled([...answering])
    },

    forms(approvals) {
      const opened = live()
      return formsFor({ approvals, waiting: opened?.pending() ?? [], reach: opened?.reach ?? NO_REACH, options })
    },

    answer(responses, sender) {
      if (!live() || !responses) return Promise.resolve({ tokens: [], unsaved: [] })
      const run = decideAnswers(responses, sender)
      answering.add(run)
      const forget = () => { answering.delete(run) }
      run.then(forget, forget)
      return run
    },

    saveForms(unsaved, sender) {
      if (unsaved.length === 0 || !live()) return undefined
      for (const question of unsaved) saveQuestions.set(question.decision.token, { ...question, caller: sender?.caller })
      return inputRequired({ inputRequests: Object.fromEntries(unsaved.map(question => [`${SAVE_KEY}${question.decision.token}`, saveForm(question.unsaved)])) })
    },
  }
}

/** A round's answer keys, at most MOST_FORM_ANSWERS of them, since one call's forms are never more. */
function roundKeys(input: { host: ApprovalHost; responses: Record<string, unknown> }): string[] {
  const keys = Object.keys(input.responses)
  if (keys.length <= MOST_FORM_ANSWERS) return keys
  input.host.log('warn', 'An MCP form round carried more answers than one call has forms, so the rest were not read', { answers: keys.length, read: MOST_FORM_ANSWERS })
  return keys.slice(0, MOST_FORM_ANSWERS)
}

/**
 * The asks an approval answer under these keys may decide, read once: those waiting, and where the host's source answers
 * its own caller's asks alone, those its sender raised. A key naming any other is sent nowhere, so it costs no record.
 */
function answerableAsks(input: { host: ApprovalHost; sender: AnswerSender | undefined; keys: string[] }): Map<string, FullAsk> {
  const { host, sender } = input
  const named = input.keys.filter(key => !key.startsWith(SAVE_KEY))
  if (named.length === 0) return new Map()
  const asks = new Map(host.pending().filter(ask => !host.reach.sameCaller || (sender !== undefined && ask.requester.actor === sender.caller)).map(ask => [ask.token, ask]))
  const unnamed = named.filter(key => !asks.has(key)).length
  if (unnamed > 0) host.log('info', 'MCP form answers named no ask waiting for their caller, so nothing was sent for them', { answers: unnamed })
  return asks
}

/** A save form's answer: retry or skip as accepted, a decline as a skip, and a cancel, or none, as leaving it. */
function saveAnswerIn(responses: Record<string, unknown>, key: string): SaveAnswer | undefined {
  const view = inputResponse(responses, key)
  if (view.kind === 'elicit' && view.action === 'decline') return 'skip'
  return acceptedContent(responses, key, SaveAnswerSchema)?.save
}

function saveForm(unsaved: Unsaved) {
  const { answers, choices } = SAVE_FORMS[unsaved.kind]
  return inputRequired.elicit({
    message: `${unsaved.warning}.\n${choices}`,
    requestedSchema: {
      type: 'object',
      properties: { save: { type: 'string', enum: answers, description: answers.join(' or ') } },
      required: ['save'],
    },
  })
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

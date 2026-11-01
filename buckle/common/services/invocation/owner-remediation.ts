import { ToolNameSchema, type InvokeResponse, type PackDescriptor, type PermissionRuleId, type WorkspacePolicy } from '@5straps/protocol'
import { builtinToolPack } from '../../domain/action-phrase.js'
import { READ_LIMITS } from '../../domain/command-forms.js'
import { toolPolicyBlockers } from '../../domain/tool-policy.js'
import { workspaceArgument } from '../../domain/approval-instruction.js'
import type { BuckleConfig } from '../../runtime/config.js'
import { OLD_ENGINE_REASON } from '../history/journal.js'

type FeatureConfig = Pick<BuckleConfig, 'enabledPacks' | 'enableShell' | 'allowCode' | 'allowHistory' | 'allowHostGit' | 'allowHostLsp'>

export function unavailableToolReason(input: { tool: string; workspaceId: string; packs: readonly PackDescriptor[]; config: FeatureConfig }): string | null {
  const pack = input.packs.find(candidate => candidate.toolNames.includes(input.tool))
  const id = pack?.id ?? builtinToolPack(input.tool)
  if (id === null) return null
  const workspace = workspaceArgument(input.workspaceId)
  if (!pack && input.config.enabledPacks && !input.config.enabledPacks.includes(id)) {
    const selected = [...input.config.enabledPacks, id].join(',')
    return `Tool is not available: ${input.tool}. The ${id} pack is not enabled. Ask the owner to add it while keeping the selected packs: buckle workspace set packs.enabled ${selected} --workspace ${workspace}`
  }
  if (!pack?.unavailableReason) return null
  const setting = disabledSetting(id, input.config)
  const action = setting
    ? `Ask the owner to enable this feature with buckle workspace set ${setting} on --workspace ${workspace}.`
    : `Ask the owner to inspect buckle workspace show --workspace ${workspace} and the manifest's ${id} pack reason, then repair that prerequisite. Approval cannot override it.`
  return `Tool is not available: ${input.tool}. ${pack.unavailableReason}. ${action}`
}

function disabledSetting(pack: string, config: FeatureConfig): string | null {
  if (pack === 'shell' && !config.enableShell) return 'packs.shell'
  if (pack === 'code' && !config.allowCode) return 'packs.code'
  if (pack === 'history' && !config.allowHistory) return 'packs.history'
  if ((pack === 'git' || pack === 'forge') && !config.allowHostGit) return 'packs.hostGit'
  if (pack === 'dev' && !config.allowHostLsp) return 'packs.hostLsp'
  return null
}

export function withOwnerRemediation(input: { response: InvokeResponse; tool: string; workspaceId: string; rule?: PermissionRuleId; policy?: Pick<WorkspacePolicy, 'tools'> }): InvokeResponse {
  const { response } = input
  if (response.outcome !== 'error') return response
  if (response.error.code === 'RESTORE_REFUSED' && response.error.message.includes('permitted trusted host git')) {
    const workspace = workspaceArgument(input.workspaceId)
    // An earlier shadow-git checkpoint keeps its content, so permitting git makes it restorable (Slice F2, item 7).
    const earlier = response.error.message.includes(OLD_ENGINE_REASON)
    const outcome = earlier ? 'This earlier checkpoint can be restored once host Git is permitted, until its store is deleted after 10 turns of new checkpoints.' : 'Existing hash-only checkpoints cannot become restorable; only new checkpoints captured with Git can be restored.'
    const guidance = `Ask the owner to ${earlier ? 'permit host Git' : 'enable future content capture'} with buckle workspace set packs.hostGit on --workspace ${workspace}, ensure a trusted Git installation is on the node PATH outside folders writable by agents, then check buckle manifest --workspace ${workspace} for history engine git and restorable true. Enabling permission does not install Git. ${outcome}`
    return { ...response, error: { ...response.error, message: `${response.error.message}. ${guidance}` } }
  }
  if (response.error.code !== 'PERMISSION_DENIED') return response
  const workspace = workspaceArgument(input.workspaceId)
  const owner = ownerAction({ ...input, message: response.error.message, workspace })
  return { ...response, error: { ...response.error, message: `${response.error.message}. ${owner}` } }
}

function ownerAction(input: { tool: string; workspace: string; message: string; rule?: PermissionRuleId; policy?: Pick<WorkspacePolicy, 'tools'> }): string {
  const target = `--workspace ${input.workspace}`
  if (input.rule === 'tool_policy' && input.message === 'Disabled by workspace tool policy' && ToolNameSchema.safeParse(input.tool).success) {
    const blockers = input.policy ? toolPolicyBlockers(input.policy, input.tool) : [input.tool]
    const inherited = blockers.filter(tool => tool !== input.tool)
    const note = inherited.length ? `This tool inherits the ${inherited.join(', ')} refusal; the owner must review that shared permission. ` : ''
    const commands = blockers.map(tool => `buckle policy allow-tool ${tool} ${target}`).join('; ')
    return `${note}Ask the owner to review buckle policy show ${target}, then enable only the blocked tool policies they approve with ${commands}. The pack's prerequisites still apply.`
  }
  if (input.message === 'Approval was declined') return `The owner declined this call. Stop and ask them to review their decision. Only after they explicitly authorize a new request, submit it for a new approval; the owner reviews it with buckle approvals ${target} and approves the selected ask with buckle approve <approval-token> --scope once ${target}.`
  if (input.rule === 'filesystem_policy') return `Approval cannot override a deny. Ask the owner to export the policy with buckle policy export ${target}, change only the matching filesystem rule, and apply it with buckle policy import <policy-file.json> ${target}.`
  if (input.rule === 'network_egress' && input.message.includes('approved list')) return `Approval cannot override this URL list. Ask the owner to review the destination and allow only the required host or URL prefix with buckle policy allow-url <host-or-url-prefix> ${target}; a node URL list must permit it too.`
  if (input.rule === 'command_policy') {
    if (input.message.includes('cannot administer')) return `Only the owner can administer Buckle from their own terminal. A tool approval or allow rule cannot enable this action.`
    if (input.message.startsWith(`${READ_LIMITS.interpreter}: `)) return `Ask the owner to review buckle policy show ${target}. If they approve the named interpreter, use the scoped command buckle policy allow-interpreter <name> ${target} for each name above. Matching command denies still win, and all other approval rules still apply. A command allow alone cannot resolve this interpreter refusal.`
    return `Ask the owner to inspect buckle policy show ${target} and adjust only the matching command rule, using buckle policy allow-command '<exact-command-pattern>' ${target} where needed. A matching deny still wins and must be reviewed separately; an approval cannot override it.`
  }
  if (input.rule === 'read_scope' || input.rule === 'write_scope') return `An approval cannot cross this workspace boundary. Ask the owner to inspect buckle workspace mount list ${target} and explicitly share only the required location with buckle workspace mount add <local>:<sandbox> ${target}, using --read-only for reads. Existing read-only mounts need an owner configuration change for writes.`
  if (input.tool === 'shell_exec' && input.message.startsWith('Shell networking is disabled')) return `Ask the owner to review buckle workspace show ${target}. Use web_fetch for scoped network access; enabling shell.network requires an explicit owner change and does not bypass URL-list restrictions.`
  return `Ask the owner to inspect buckle policy show ${target} and buckle workspace show ${target}, then repair the specific restriction or prerequisite named above. This refusal is not a pending approval; safety boundaries cannot be overridden with an approval token.`
}

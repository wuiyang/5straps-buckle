import { formsOpenerOf } from '../common/services/workspaces/forms-opener.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { FormsFace } from '../common/types/ports/approval-source.js'
import { createFormsBackend, type FormsBackend } from './forms-backend.js'

/**
 * An MCP face's forms, opened on the runtime's approvals under the face's forms source, which core binds and rates. They
 * stay open while the forms setting is off, so turning it on applies from the next call.
 */
export function openForms(runtime: BuckleRuntime, input: { face: FormsFace; node?: string }): FormsBackend {
  const forms = createFormsBackend({ workspace: () => ({ id: runtime.workspaceId, name: runtime.workspaceName() }), ...(input.node === undefined ? {} : { node: input.node }), approves: () => runtime.judgeApproves() })
  formsOpenerOf(runtime)(forms, input.face)
  return forms
}

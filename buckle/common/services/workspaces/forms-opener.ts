import type { ApprovalBackend } from '../../types/ports/approval-backend.js'
import type { FormsFace } from '../../types/ports/approval-source.js'
import type { BuckleRuntime } from './workspace-runtime.js'

/** Opens an MCP host's forms on a runtime's approvals, under its face's forms source, which core holds and rates. */
export type FormsOpener = (backend: ApprovalBackend, face: FormsFace) => void

// Off the runtime every face holds: only the MCP faces' forms module imports this one (test/approval-boundary.test.ts).
const openers = new WeakMap<BuckleRuntime, FormsOpener>()

/** Core binds each runtime's opener as it builds the runtime. */
export function bindFormsOpener(runtime: BuckleRuntime, opener: FormsOpener): void {
  openers.set(runtime, opener)
}

export function formsOpenerOf(runtime: BuckleRuntime): FormsOpener {
  const opener = openers.get(runtime)
  if (opener === undefined) throw new Error('This runtime has no forms opener: core binds one as it builds a runtime')
  return opener
}

import type { InvokeResponse } from '@5straps/protocol'
import { builtinToolPack, TOOL_CALL_COMPLETED } from '../../domain/action-phrase.js'
import { logger } from '../../runtime/log.js'

export function logCallFeedback(input: { tool: string; knownTool?: boolean; response?: InvokeResponse; code?: string; durationMs: number; nested?: boolean; replayed?: boolean }): void {
  const { response } = input
  const code = response?.outcome === 'error' ? response.error.code : input.code
  const known = builtinToolPack(input.tool) !== null || input.knownTool === true
  logger.info(TOOL_CALL_COMPLETED, {
    tool: known && /^[a-z][a-z0-9_]{0,127}$/.test(input.tool) ? input.tool : 'unknown',
    outcome: response?.outcome === 'error' && response.error.code === 'PERMISSION_DENIED' ? 'denied' : response?.outcome ?? 'error',
    durationMs: Math.max(0, Math.round(input.durationMs)),
    nested: input.nested === true,
    replayed: input.replayed === true,
    ...executionFeedback(input),
    ...(code === undefined ? {} : { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'TOOL_EXECUTION_FAILED' }),
  })
}

const NATIVE_ERROR_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EIO', 'EROFS', 'EMFILE', 'ENFILE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOSPC'])

export function safeErrorDetails(error: unknown): Record<string, string> {
  const errorType = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : error instanceof SyntaxError ? 'SyntaxError' : error instanceof ReferenceError ? 'ReferenceError' : error instanceof Error ? 'Error' : 'Unknown'
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return { errorType, ...(typeof code === 'string' && NATIVE_ERROR_CODES.has(code) ? { code } : {}) }
}

function executionFeedback(input: { tool: string; response?: InvokeResponse }): { executionStatus?: 'failed'; exitCode?: number } {
  const { response } = input
  if (response?.outcome !== 'ok' || typeof response.output !== 'object' || response.output === null || Array.isArray(response.output)) return {}
  const output = response.output
  if (input.tool === 'code_run') return output['ok'] === false ? { executionStatus: 'failed' } : {}
  if (input.tool !== 'shell_exec' && input.tool !== 'script_run') return {}
  const exitCode = output['exitCode']
  const numeric = typeof exitCode === 'number' && Number.isSafeInteger(exitCode)
  const failed = output['timedOut'] === true || exitCode === null || numeric && exitCode !== 0
  return { ...(failed ? { executionStatus: 'failed' as const } : {}), ...(numeric ? { exitCode } : {}) }
}

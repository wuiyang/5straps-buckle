// Checked structurally, so a RuntimeError from another loaded copy of this package still matches.
const RUNTIME_ERROR_BRAND = Symbol.for('@5straps/runtime/error')

// Typed runtime failures. Callers branch on `code`, never on message text.
export class RuntimeError extends Error {
  readonly code: string
  readonly [RUNTIME_ERROR_BRAND] = true

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = code
    this.code = code
  }
}

export function isRuntimeError(error: unknown, code?: string): error is RuntimeError {
  if (!(error instanceof Error) || (error as Partial<RuntimeError>)[RUNTIME_ERROR_BRAND] !== true) return false
  return code === undefined || (error as RuntimeError).code === code
}

export const RuntimeErrorCode = Object.freeze({
  missingScope: 'MissingScopeError',
  disposedScope: 'DisposedScopeError',
  foreignScope: 'ForeignScopeError',
  backgroundWorkLimit: 'BackgroundWorkLimitError',
  unregisteredService: 'UnregisteredServiceError',
  undeclaredDependency: 'UndeclaredDependencyError',
  circularDependency: 'CircularDependencyError',
  captiveDependency: 'CaptiveDependencyError',
  disposedRuntime: 'DisposedRuntimeError',
  notReady: 'NotReadyError',
  disposal: 'DisposalError',
  waitInsideTransaction: 'WaitInsideTransactionError',
  lockBusy: 'LockBusyError',
  lockAborted: 'LockAbortedError',
  asyncTransactionBody: 'AsyncTransactionBodyError',
  drainTimeout: 'DrainTimeoutError',
  closeStepTimeout: 'CloseStepTimeoutError',
  singletonInsideTransaction: 'SingletonInsideTransactionError',
} as const)

export class DisposalError extends AggregateError {
  readonly code = RuntimeErrorCode.disposal
  readonly [RUNTIME_ERROR_BRAND] = true

  // The original failure leads: first in errors, named in the message, and the cause.
  constructor(errors: unknown[], message: string, original?: unknown) {
    super(original === undefined ? errors : [original, ...errors], original === undefined ? message : `${message}: ${toError(original).message}`, original === undefined ? undefined : { cause: original })
    this.name = RuntimeErrorCode.disposal
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

// Structural, so a DisposalError from another loaded copy of this package is recognised too.
export function isDisposalError(error: unknown): error is DisposalError {
  return error instanceof AggregateError && isRuntimeError(error, RuntimeErrorCode.disposal)
}

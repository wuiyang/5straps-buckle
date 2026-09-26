// Typed runtime failures. Callers branch on `code`, never on message text.
export class RuntimeError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = code
    this.code = code
  }
}

export function isRuntimeError(error: unknown, code?: string): error is RuntimeError {
  return error instanceof RuntimeError && (code === undefined || error.code === code)
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
  asyncTransactionBody: 'AsyncTransactionBodyError',
} as const)

export class DisposalError extends AggregateError {
  readonly code = RuntimeErrorCode.disposal

  constructor(errors: unknown[], message: string, original?: unknown) {
    super(original === undefined ? errors : [original, ...errors], message, original === undefined ? undefined : { cause: original })
    this.name = RuntimeErrorCode.disposal
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

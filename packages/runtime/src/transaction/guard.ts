import { AsyncLocalStorage } from 'node:async_hooks'
import { RuntimeError, RuntimeErrorCode } from '../errors.js'

// Marks code running inside a database transaction so human waits can refuse to start there.
const activeTransaction = new AsyncLocalStorage<string>()

export function runInTransactionMarker<T>(label: string, fn: () => T): T {
  return activeTransaction.run(label, fn)
}

export function activeTransactionLabel(): string | undefined {
  return activeTransaction.getStore()
}

export function assertNoActiveTransaction(action: string): void {
  const label = activeTransaction.getStore()
  if (label !== undefined) throw new RuntimeError(RuntimeErrorCode.waitInsideTransaction, `Cannot ${action} while transaction ${label} is open; commit or roll back first`)
}

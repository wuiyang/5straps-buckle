import { AsyncLocalStorage } from 'node:async_hooks'
import type { OperationScope } from '../scope/als.js'

// Process-wide slots under registered symbols, so two loaded copies of this package (for example
// one inlined by a Nitro build and one imported by main.ts) share one scope and marker state.
export function globalSlot<T>(name: string, create: () => T): T {
  const key = Symbol.for(`@5straps/runtime/${name}`)
  const slots = globalThis as typeof globalThis & Record<symbol, unknown>
  slots[key] ??= create()
  return slots[key] as T
}

export const scopeStorage = globalSlot('scope-storage', () => new AsyncLocalStorage<OperationScope>())
export const transactionStorage = globalSlot('transaction-storage', () => new AsyncLocalStorage<string>())

// Runtime-held values (singletons, their timers and listeners) must not capture the first caller's scope or transaction.
export function runDetached<T>(fn: () => T): T {
  return scopeStorage.exit(() => transactionStorage.exit(fn))
}

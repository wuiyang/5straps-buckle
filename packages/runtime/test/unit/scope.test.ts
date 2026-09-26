import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { captureCorrelation, createOperationScope, DisposalError, isRuntimeError, registerBackgroundWork, runInScope, RuntimeErrorCode, useScope, useScopeSafe, withOperationScope } from '../../src/index.js'

const owner = Symbol('test-runtime')

describe('operation scopes', () => {
  it('fails clearly outside a scope and returns undefined from the safe accessor', () => {
    expect(() => useScope()).toThrow(expect.objectContaining({ code: RuntimeErrorCode.missingScope }))
    expect(useScopeSafe()).toBeUndefined()
  })

  it('keeps 100 concurrent contexts apart across awaits', async () => {
    const seen = await Promise.all(Array.from({ length: 100 }, (_, index) => withOperationScope(createOperationScope({ owner, context: { correlationId: `c-${index}`, actor: `actor-${index}` } }), async () => {
      await delay(Math.floor(Math.random() * 10))
      await Promise.resolve()
      const context = useScope().context
      return context.correlationId === `c-${index}` && context.actor === `actor-${index}`
    })))
    expect(seen.filter(Boolean)).toHaveLength(100)
  })

  it('captures immutable correlation data for delayed work', async () => {
    const captured = await withOperationScope(createOperationScope({ owner, context: { correlationId: 'c-1', attributes: { tool: 'fs' } } }), () => captureCorrelation())
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured.attributes)).toBe(true)
    expect(() => { (captured as { actor?: string }).actor = 'mallory' }).toThrow(TypeError)
  })

  it('drains background work before cleanups and reports failures after draining everything', async () => {
    const order: string[] = []
    const scope = createOperationScope({ owner, context: {} })
    runInScope(scope, () => {
      registerBackgroundWork(delay(20).then(() => { order.push('slow work') }))
      registerBackgroundWork(Promise.reject(new Error('work failed')))
    })
    scope.onDispose(() => { order.push('cleanup a') })
    scope.onDispose(() => { throw new Error('cleanup b failed') })
    const error = await scope.dispose().then(() => undefined, (failure: unknown) => failure)
    expect(order).toEqual(['slow work', 'cleanup a'])
    expect(error).toBeInstanceOf(DisposalError)
    expect((error as DisposalError).errors.map(item => (item as Error).message)).toEqual(['work failed', 'cleanup b failed'])
    expect(scope.state).toBe('disposed')
  })

  it('bounds background work registration', () => {
    const scope = createOperationScope({ owner, context: {}, maxBackgroundWork: 1 })
    scope.registerBackgroundWork(delay(5))
    expect(() => scope.registerBackgroundWork(delay(5))).toThrow(expect.objectContaining({ code: RuntimeErrorCode.backgroundWorkLimit }))
  })

  it('aborts the scope signal on parent abort and on dispose', async () => {
    const parent = new AbortController()
    const scope = createOperationScope({ owner, context: {}, signal: parent.signal })
    parent.abort(new Error('client went away'))
    expect(scope.signal.aborted).toBe(true)
    const second = createOperationScope({ owner, context: {} })
    await second.dispose()
    expect(isRuntimeError(second.signal.reason, RuntimeErrorCode.disposedScope)).toBe(true)
  })

  it('keeps the body error primary when disposal also fails', async () => {
    const error = await withOperationScope(createOperationScope({ owner, context: {} }), (scope) => {
      scope.onDispose(() => { throw new Error('close failed') })
      throw new Error('body failed')
    }).then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(DisposalError)
    expect((error as DisposalError).cause).toEqual(new Error('body failed'))
    expect((error as DisposalError).errors.map(item => (item as Error).message)).toEqual(['body failed', 'close failed'])
  })
})

import { H3Core } from 'h3'
import { describe, expect, it } from 'vitest'
import plugin from '../layers/common/server/plugins/20.head.js'

// Review L11 and L12 of the second proof-of-possession re-review, on an h3 app of its own: the head plugin
// locks the app it is given, and refuses a route with middleware rather than half locking it.

type Route = { data: Record<string, unknown>; params: Record<string, string> }

function lockedApp(data: Record<string, unknown>) {
  const app = new H3Core()
  const raw = app as unknown as Record<string, unknown>
  raw['~findRoute'] = () => ({ data, params: {} })
  ;(plugin as unknown as (nitroApp: { h3: H3Core }) => void)({ h3: app })
  const find = () => (raw['~findRoute'] as (event: unknown) => Route | undefined)({ req: { method: 'GET' }, url: new URL('http://127.0.0.1/probe'), context: {} })
  return { app, raw, find }
}

describe('the head plugin\'s lock', () => {
  it('refuses to serve a route that carries middleware: it fails closed instead of locking half of it', () => {
    const data = { method: 'GET', route: '/probe', handler: () => 'probe', middleware: [() => undefined] }
    const { find } = lockedApp(data)
    expect(find).toThrow(/route with middleware/)
  })

  it('freezes a route without middleware whole as the router hands it out', () => {
    const data = { method: 'GET', route: '/probe', handler: () => 'probe' }
    const { find } = lockedApp(data)
    expect(find()?.data).toBe(data)
    expect(Object.isFrozen(data)).toBe(true)
  })

  it('fixes the app\'s config and every method it runs on the app, and leaves the shared prototype writable', () => {
    const { raw } = lockedApp({ method: 'GET', route: '/probe', handler: () => 'probe' })
    expect(Object.isFrozen(raw.config)).toBe(true)
    expect(() => { raw.config = {} }).toThrow(TypeError)
    const prototype = Object.getPrototypeOf(raw) as Record<string, unknown>
    for (const name of ['fetch', 'handler', '~request', '~findRoute']) {
      expect(Object.getOwnPropertyDescriptor(raw, name), name).toMatchObject({ writable: false, configurable: false })
      expect(() => { raw[name] = () => 'wrapped' }, name).toThrow(TypeError)
    }
    expect(Object.isFrozen(prototype)).toBe(false)
    expect(Object.getOwnPropertyDescriptor(prototype, 'fetch')?.writable).toBe(true)
  })
})

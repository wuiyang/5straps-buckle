import { describe, expect, it } from 'vitest'
import { EXECUTION_LIMIT, EXECUTION_TTL_MS } from '../common/services/invocation/executions.js'
import { createResendJoin } from '../mcp/resend-join.js'

// The MCP asks brief, item 2, and the review of that slice (finding minor-7): the memory of calls that asked lasts the
// replay window, ten minutes from a call's last use and 256 calls at most, the oldest dropped first.

function memory() {
  const clock = { now: 1_000 }
  return { clock, joins: createResendJoin({ now: () => clock.now }) }
}

describe('the calls an MCP runtime remembers for a re-send', () => {
  it('remembers a call under its key and gives its requestId back', () => {
    const { joins } = memory()
    joins.remember('call-a', 'id-a')
    expect(joins.requestIdOf('call-a')).toBe('id-a')
    expect(joins.requestIdOf('call-b')).toBeUndefined()
  })

  it('forgets a call ten minutes after its last use, and not before', () => {
    const { clock, joins } = memory()
    joins.remember('call-a', 'id-a')
    clock.now += EXECUTION_TTL_MS - 1
    expect(joins.requestIdOf('call-a')).toBe('id-a')
    clock.now += 1
    expect(joins.requestIdOf('call-a')).toBeUndefined()
  })

  it('keeps a call that is remembered again ten minutes from then', () => {
    const { clock, joins } = memory()
    joins.remember('call-a', 'id-a')
    clock.now += EXECUTION_TTL_MS - 1
    joins.remember('call-a', 'id-a')
    clock.now += EXECUTION_TTL_MS - 1
    expect(joins.requestIdOf('call-a')).toBe('id-a')
    clock.now += 1
    expect(joins.requestIdOf('call-a')).toBeUndefined()
  })

  it('forgets a call when told to', () => {
    const { joins } = memory()
    joins.remember('call-a', 'id-a')
    joins.forget('call-a')
    expect(joins.requestIdOf('call-a')).toBeUndefined()
  })

  it(`keeps ${EXECUTION_LIMIT} calls at most: the 257th drops the oldest, and a call remembered again counts as the newest`, () => {
    const { joins } = memory()
    for (let index = 0; index < EXECUTION_LIMIT; index += 1) joins.remember(`call-${index}`, `id-${index}`)
    // The oldest is used again, so the next one in line is the oldest now.
    joins.remember('call-0', 'id-0')
    joins.remember('call-new', 'id-new')

    expect(joins.requestIdOf('call-1')).toBeUndefined()
    expect(joins.requestIdOf('call-0')).toBe('id-0')
    expect(joins.requestIdOf('call-new')).toBe('id-new')
    expect(joins.requestIdOf(`call-${EXECUTION_LIMIT - 1}`)).toBe(`id-${EXECUTION_LIMIT - 1}`)
  })
})

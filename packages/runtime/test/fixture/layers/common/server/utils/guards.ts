import { HTTPError, type H3Event } from 'h3'
import type { Guard } from '@5straps/runtime/nitro'
import type { Credential } from '../../../../common/access.js'
import type { FixtureServices } from '../../../../common/types.js'

const BEARER = /^Bearer ([\w-]{1,256})$/
const ACTOR = /^[\w.:-]{1,64}$/

export function bearerToken(event: H3Event): string | undefined {
  return BEARER.exec(event.req.headers.get('authorization') ?? '')?.[1]
}

export function useServices(event: H3Event): FixtureServices {
  const services = event.context.services
  if (!services) throw HTTPError.status(503, 'Service Unavailable', { message: 'Services are not attached to this request' })
  return services
}

// Each guard accepts exactly one credential kind; nothing set earlier in the context counts.
export function requireCredential(kind: Credential): Guard {
  return async (event) => {
    const actor = (await useServices(event).getAccess()).verify(kind, bearerToken(event))
    if (!actor) throw HTTPError.status(401, 'Unauthorized')
    // Fixture only: an authenticated caller may name a sub-actor (F19), always under its own credential,
    // so x-actor can never pose as another identity such as the owner CLI or admin.
    const named = event.req.headers.get('x-actor')
    return { actor: named && ACTOR.test(named) ? `${actor}:${named}` : actor }
  }
}

export const requireAgent = requireCredential('agent')

import { BUILT_IN_SOURCES, type ApprovalSource, type BuiltInSource } from '../../types/ports/approval-source.js'

/** A route an ask was sent down: a deciding route's source may approve and deny it, a notify route's may only deny it. */
export interface RecordedRoute {
  id: string
  role: 'decide' | 'notify'
}

/**
 * Today's set, which every ask this build records reads as: the terminal, a stdio host's forms, and an enrolled device
 * decide, and the setup route's sealed envelope, the webhook's way back, only denies.
 */
export const TODAYS_ROUTES: readonly RecordedRoute[] = Object.freeze([
  { id: 'terminal', role: 'decide' },
  { id: 'forms', role: 'decide' },
  { id: 'devices', role: 'decide' },
  { id: 'sealed', role: 'notify' },
])

/** The route an ask recorded for a source; a built-in source's route admits that kind alone, whatever another source calls itself. */
export function routeOf(source: ApprovalSource, routes: readonly RecordedRoute[]): RecordedRoute | undefined {
  return routes.find(route => route.id === source.id && (!isBuiltIn(route.id) || route.id === source.kind))
}

function isBuiltIn(id: string): id is BuiltInSource {
  return (BUILT_IN_SOURCES as readonly string[]).includes(id)
}

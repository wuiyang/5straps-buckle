import { HTTPError, type H3Event } from 'h3'
import type { BuckleServices } from '../../../../common/runtime/services.js'

/** The service accessors main bound; a request the context plugin could not attach is refused, never served without them. */
export function useServices(event: H3Event): BuckleServices {
  const services = event.context.services
  if (!services) throw HTTPError.status(503, 'Service Unavailable', { message: 'Buckle is not ready' })
  return services
}

import { HTTPError, type H3Event } from 'h3'
import type { BuckleHttpServices } from '../../../../common/types/ports/mcp-http.js'

/** The service accessors main bound; a request the context plugin could not attach is refused, never served without them. */
export function useServices(event: H3Event): BuckleHttpServices {
  const services = event.context.services
  if (!services) throw HTTPError.status(503, 'Service Unavailable', { message: 'Buckle is not ready' })
  return services
}

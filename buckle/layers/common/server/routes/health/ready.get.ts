import { defineHandler, HTTPError } from 'h3'
import { requireReady } from '@5straps/runtime/nitro'
import { useServices } from '../../utils/services.js'

// Readiness: 503 while the common runtime starts, after a failed start and once it closes, and while
// any workspace's audit log will not take writes, when Buckle refuses that workspace's tool calls
// (B19). A failing log is probed again here, throttled, so a repair shows without other traffic
// (review M2 of B18-B19). Liveness is /health.
export default defineHandler(async (event) => {
  requireReady(event)
  const { auditHealth } = await useServices(event).getWorkspaceRuntime()
  await auditHealth.recheck()
  if (!auditHealth.available) {
    throw HTTPError.status(503, 'Service Unavailable', { message: 'The audit log is unavailable; tool calls are refused until the owner repairs it' })
  }
  return { status: 'ready' }
})

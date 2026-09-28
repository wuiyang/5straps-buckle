import { defineHandler, HTTPError } from 'h3'
import { requireReady } from '@5straps/runtime/nitro'
import { useServices } from '../../utils/services.js'

// Readiness: 503 while the common runtime starts, after a failed start and once it closes, and while
// the audit log will not take writes, when Buckle refuses every tool call (B19). Liveness is /health.
export default defineHandler(async (event) => {
  requireReady(event)
  if (!(await useServices(event).getWorkspaceRuntime()).auditHealth.available) {
    throw HTTPError.status(503, 'Service Unavailable', { message: 'The audit log is unavailable; tool calls are refused until the owner repairs it' })
  }
  return { status: 'ready' }
})

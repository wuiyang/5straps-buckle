import type { AuditHealth } from '../../types/ports/action-log.js'

export function createAuditHealth(): AuditHealth {
  let available = true
  return {
    get available() { return available },
    succeeded: () => { available = true },
    failed: () => { available = false },
  }
}

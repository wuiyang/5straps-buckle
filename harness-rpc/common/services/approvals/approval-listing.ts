import type { ApprovalRequest, JsonValue } from '@5straps/protocol'
import { shownCall, type PendingAsk } from './approval-registry.js'

/** A waiting request as a listing carries it: `callRef` on every ask of a group, the group's whole call on its first. */
export type ListedApproval = ApprovalRequest & {
  callRef?: string
  call?: { arguments: JsonValue; cwd: string; description: string | null; effects: string[] }
}

/**
 * The waiting asks with each request group's whole call once (review M1 of the slice 5 re-review): every ask of a
 * group names it by `callRef`, and the group's first ask listed carries it, as each ask did before this build,
 * so a reader of `call` alone still finds it there. A complete call kept inline (asks recorded by 077ca3e to
 * f931286) is carried whole with its ask (review L5 of the continuation review). An ask recorded before those
 * builds has neither.
 */
export function listedApprovals(waiting: readonly PendingAsk[]): ListedApproval[] {
  const carried = new Set<string>()
  return waiting.map(({ request, call, callRef }) => {
    const shown = shownCall(call)
    if (!shown) return { ...request }
    if (callRef === undefined) return { ...request, call: shown }
    const first = !carried.has(callRef)
    carried.add(callRef)
    return { ...request, callRef, ...(first ? { call: shown } : {}) }
  })
}

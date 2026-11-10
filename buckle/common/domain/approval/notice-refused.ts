/**
 * The receiver of lifecycle notices answered that it refuses what it was sent (HTTP 400, 413, or 422), as one on an older
 * protocol does for a notice it cannot read. The link works, so the notices are the trouble, and the queue sends them apart.
 */
export class NoticeRefusedError extends Error {
  constructor(readonly status: number) { super(`Approval lifecycle webhook returned HTTP ${status}`) }
}

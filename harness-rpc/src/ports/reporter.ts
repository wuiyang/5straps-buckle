import type { DeniedRunReport } from '@5straps/protocol'

/** Where a refused call is announced as it happens, so the owner sees what an agent tried. */
export interface Reporter {
  readonly configured: boolean
  report(report: DeniedRunReport): Promise<void>
}

export const nullReporter: Reporter = {
  configured: false,
  report: () => Promise.resolve(),
}

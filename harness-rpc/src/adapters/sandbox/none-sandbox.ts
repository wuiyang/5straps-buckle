import type { Sandbox } from '../../ports/sandbox.js'

/** No isolation. Only selected when the operator explicitly accepts it. */
export function createNoneSandbox(): Sandbox {
  return {
    mode: 'none',
    wrap: ({ command, args }) => ({ command, args }),
  }
}

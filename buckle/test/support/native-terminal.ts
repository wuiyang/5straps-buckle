/** Whether the optional `node-pty` addon loads here: an installation without it serves terminals a 503. */
export const nativeTerminal = await import('node-pty').then(() => true, () => false)

/**
 * Whether the real-terminal tests run: wherever the addon loads on Linux, and always on Linux CI,
 * where the addon must have built, so a failed build fails them instead of skipping them (review M8
 * of B20-B22).
 */
export const runsNativeTerminal = process.platform === 'linux' && (nativeTerminal || process.env.CI === 'true')

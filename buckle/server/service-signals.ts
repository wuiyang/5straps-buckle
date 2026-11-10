/**
 * The signals that ask the service to stop. Windows delivers no SIGTERM: Ctrl-C there is SIGINT, Ctrl-Break is
 * SIGBREAK, and closing the console window is SIGHUP, after which Windows ends the process within seconds.
 */
export function stopSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  return platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGTERM', 'SIGINT']
}

import type { NodeLocation } from '../../runtime/environment.js'
import type { ProcessRunner } from '../../types/ports/process-runner.js'
import type { ServiceManager } from '../../types/ports/service-manager.js'
import { createSystemdManager } from './systemd.js'

/** What a service manager adapter is built from: the platform, the process environment, a runner, and the node's location. */
export interface ServiceManagerContext {
  platform: NodeJS.Platform
  /** The process environment, read before buckle.env is; each adapter passes its programs a fixed list of it alone. */
  environment: NodeJS.ProcessEnv
  run: ProcessRunner
  location: NodeLocation
}

/** The service manager Buckle drives on this platform; null where it drives none. */
export function serviceManagerFor(context: ServiceManagerContext): ServiceManager | null {
  if (context.platform === 'linux') return createSystemdManager({ environment: context.environment, run: context.run })
  return null
}

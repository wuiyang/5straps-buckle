import type { ProcessRunner } from '../../types/ports/process-runner.js'
import type { NodeLocation, ServiceManager } from '../../types/ports/service-manager.js'
import { createLaunchdManager } from './launchd.js'
import { createSystemdManager } from './systemd.js'
import { createTaskSchedulerManager } from './task-scheduler.js'

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
  const { environment, run, location } = context
  if (context.platform === 'linux') return createSystemdManager({ environment, run, location })
  if (context.platform === 'darwin') return createLaunchdManager({ environment, run, location })
  if (context.platform === 'win32') return createTaskSchedulerManager({ environment, run, location })
  return null
}

/** Whether Buckle drives a service manager on this platform: the systemd user manager, launchd, or Task Scheduler. */
export function drivesServiceManager(platform: NodeJS.Platform): boolean {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32'
}

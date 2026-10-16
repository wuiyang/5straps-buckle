/**
 * Where a node lives, as paths alone: its state directory, and the environment file BUCKLE_ENV_FILE names, if any. Read
 * by the CLI before buckle.env is loaded (nodeLocation); a service manager adapter takes it, never the file's values.
 */
export interface NodeLocation {
  stateDirectory: string
  environmentFile: string | null
}

/**
 * What a service definition runs (Phase 3 of the workspace-model slice): the absolute Node binary and the absolute
 * dist/main.js with `serve`, and where the node lives, as paths alone. No definition ever holds a setting's value.
 */
export interface ServiceDefinition {
  node: string
  main: string
  stateDirectory: string
  environmentFile: string | null
  /** The installing shell's PATH, so the service finds the programs the owner's terminal finds (systemd, launchd). */
  path?: string
  /**
   * Whether the install command passed --skip-owner-only-check, which the service's node then passes to itself: a
   * state directory whose modes cannot be set (WSL on a Windows drive) would otherwise refuse it at every start.
   */
  skipOwnerOnlyCheck?: boolean
}

/** What an installed definition runs, read back from it; a field is null where the definition does not say. */
export interface InstalledService {
  node: string | null
  main: string | null
  /** Whether it serves this node's state directory; null where it names none Buckle can read. */
  thisNode: boolean | null
  /** Whether it starts at login. */
  enabled: boolean
  /** Whether its node runs with --skip-owner-only-check. */
  skipsOwnerOnlyCheck?: boolean
}

/**
 * One platform's service manager: the systemd user manager on Linux, launchd on macOS, Task Scheduler on Windows. A
 * refusal is thrown as a ServiceManagerError naming no owner path.
 */
export interface ServiceManager {
  readonly kind: 'systemd' | 'launchd' | 'task-scheduler'
  /** The definition as a person reads it, with no path: "the systemd user unit buckle.service", "the launchd agent com.5straps.buckle". */
  readonly label: string
  /** Why this machine has no such manager to install into, or null where it answers. */
  unavailable(): Promise<string | null>
  installed(): Promise<InstalledService | null>
  /** Writes the definition, replacing this node's own, and enables it at login; starts it too with `now`. */
  install(definition: ServiceDefinition, options: { now: boolean }): Promise<void>
  /** Stops, disables, and removes the definition; nothing in the state directory but the definition's own copy. */
  uninstall(): Promise<void>
  start(): Promise<void>
  /**
   * Stops the service and waits for it, where the manager can signal the node (systemd's and launchd's SIGTERM). Task
   * Scheduler cannot, so it leaves this out, and the node is asked through its stop request instead.
   */
  stop?(): Promise<void>
  /** Restarts it in one step, where the manager can; otherwise a stop, then start. */
  restart?(): Promise<void>
  /** Whether it starts before anyone logs in, and the system's command that would make it, where the platform has one. */
  beforeLogin?(): Promise<{ starts: boolean; command: string }>
}

/**
 * The exit code of a serve a definition started that found another node already serving its state directory: a
 * definition does not restart it on that code (systemd's RestartPreventExitStatus), as starting again changes nothing.
 * launchd has no such setting, so a serve it started exits 0 there instead (refusedServeExit).
 */
export const SERVE_REFUSED_EXIT = 2

export class ServiceManagerError extends Error {
  override readonly name = 'ServiceManagerError'
}

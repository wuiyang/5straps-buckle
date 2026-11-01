export interface ProcessRequest {
  command: string
  /** The name the program is started by, when it is not `command`: a resolved program's path as PATH gave it (Program). */
  argv0?: string
  args: string[]
  cwd: string
  timeoutMs: number
  environment: NodeJS.ProcessEnv
  stdin?: number
  signal?: AbortSignal
  /** On Windows, start it with no console window of its own, as a node with no console (a service) would open one. */
  windowsHide?: boolean
}

export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>

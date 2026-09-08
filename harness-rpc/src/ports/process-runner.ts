export interface ProcessRequest {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  environment: NodeJS.ProcessEnv
  stdin?: number
  signal?: AbortSignal
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

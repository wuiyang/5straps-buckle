export interface PtySpawnRequest {
  command: string
  args: string[]
  cwd: string
  environment: Record<string, string>
  cols: number
  rows: number
}
export interface PtyProcess {
  write(data: string): void
  resize(cols: number, rows: number): void
  stop(): Promise<void>
  onData(listener: (data: string) => void): () => void
  onExit(listener: (exitCode: number) => void): () => void
}
export type PtySpawner = (request: PtySpawnRequest) => Promise<PtyProcess>

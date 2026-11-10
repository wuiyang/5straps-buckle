import { PtyUnavailableError, type PtySpawner } from '../types/ports/pty-process.js'

interface NodePtyModule {
  spawn(file: string, args: string[], options: { name: string, cwd: string, env: Record<string, string>, cols: number, rows: number }): {
    write(data: string): void
    resize(columns: number, rows: number): void
    onData(listener: (data: string) => void): { dispose(): void }
    onExit(listener: (event: { exitCode: number, signal?: number }) => void): { dispose(): void }
    kill(signal?: string): void
  }
}

export const spawnPtyProcess: PtySpawner = async request => {
  let module: NodePtyModule
  try { module = await import('node-pty') as unknown as NodePtyModule } catch { throw new PtyUnavailableError('Interactive terminal support is unavailable on this Buckle installation') }
  const process = module.spawn(request.command, request.args, { name: 'xterm-256color', cwd: request.cwd, env: request.environment, cols: request.cols, rows: request.rows })
  let exited = false
  let finish: (() => void) | undefined
  const stopped = new Promise<void>(resolve => { finish = resolve })
  process.onExit(() => { exited = true; finish?.() })
  return {
    write: data => process.write(data),
    resize: (cols, rows) => process.resize(cols, rows),
    onData: listener => { const subscription = process.onData(listener); return () => subscription.dispose() },
    onExit: listener => { const subscription = process.onExit(event => listener(event.exitCode)); return () => subscription.dispose() },
    async stop() {
      if (exited) return
      process.kill('SIGTERM')
      const timeout = setTimeout(() => { if (!exited) process.kill('SIGKILL') }, 1_000)
      timeout.unref()
      try { await stopped } finally { clearTimeout(timeout) }
    },
  }
}

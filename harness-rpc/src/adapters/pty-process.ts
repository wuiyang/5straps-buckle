import type { PtySpawner } from '../ports/pty-process.js'
import { WorkbenchError } from '../services/workbench/storage.js'

export const spawnPtyProcess: PtySpawner = async request => {
  let module: typeof import('node-pty')
  try { module = await import('node-pty') } catch { throw new WorkbenchError('Interactive terminal support is unavailable on this Buckle installation', 503) }
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

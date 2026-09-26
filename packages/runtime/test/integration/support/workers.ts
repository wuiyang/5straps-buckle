import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const worker = join(packageRoot, 'test/integration/support/sqlite-worker.ts')

export interface WorkerHandle {
  child: ChildProcess
  next(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>
  exited: Promise<number | null>
}

export function startWorker(args: string[]): WorkerHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', worker, ...args], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  const messages: Record<string, unknown>[] = []
  const waiters: { predicate: (message: Record<string, unknown>) => boolean; resolve: (message: Record<string, unknown>) => void }[] = []
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const message = JSON.parse(line) as Record<string, unknown>
    messages.push(message)
    for (const waiter of waiters.filter(item => item.predicate(message))) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(message)
    }
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('exit', (code, signal) => (code === 0 || signal === 'SIGKILL' ? resolve(code) : reject(new Error(`worker exited ${code ?? signal}: ${stderr}`))))
  })
  return {
    child,
    exited,
    next(predicate) {
      const seen = messages.find(predicate)
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        waiters.push({ predicate, resolve })
        exited.then(() => reject(new Error(`worker exited before the expected message: ${stderr}`)), reject)
      })
    },
  }
}

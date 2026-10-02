import { spawn, type ChildProcess } from 'node:child_process'

/** A separate process that takes a runtime file lock and holds it until it is killed or its stdin closes. */
export async function holdLockInProcess(path: string): Promise<ChildProcess> {
  const script = [
    `import { acquireFileLock } from ${JSON.stringify(import.meta.resolve('@5straps/runtime/sqlite'))}`,
    `const lock = await acquireFileLock({ path: process.argv[1], wait: 'none' })`,
    `process.stdout.write('held\\n')`,
    `process.stdin.on('end', async () => { await lock.release(); process.exit(0) })`,
    `process.stdin.resume()`,
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('held')) resolve() })
    child.once('exit', code => reject(new Error(`lock holder exited early with ${code}`)))
  })
  return child
}

export async function killHolder(child: ChildProcess): Promise<void> {
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
}

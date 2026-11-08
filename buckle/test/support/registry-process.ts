import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Where a second process is killed, as a process that stops: once its grant write is on disk, or as it starts to remove a grant. */
export type StopAt = 'grant_written' | 'removing'

/** What the second process does through the real registry: settle the ledger as an opening workspace does, or skip a save as `cli`. */
export type SecondRun = { recover: true } | { skip: string }

export interface SecondProcess { approvals: string; grants: string; workspace: string }

/**
 * Runs `run` in a second process on the same ledger and grants files. With `stopAt` the process is killed there and
 * nothing more of it runs; otherwise it exits on its own, giving back what the registry answered.
 */
export async function inSecondProcess(files: SecondProcess, run: SecondRun, stopAt?: StopAt): Promise<{ stopped: true } | { result: unknown }> {
  const script = join(dirname(files.approvals), `second-process-${process.pid}-${Date.now()}.mts`)
  writeFileSync(script, `
    import { createFileGrantStore } from ${JSON.stringify(new URL('../../common/adapters/grant-store/file-grant-store.ts', import.meta.url).href)};
    import { createApprovalRegistry } from ${JSON.stringify(new URL('../../common/services/approvals/approval-registry.ts', import.meta.url).href)};
    import { SOURCES } from ${JSON.stringify(new URL('../../common/types/ports/approval-source.ts', import.meta.url).href)};
    const [approvals, grantsFile, workspace, run, stopAt] = process.argv.slice(2);
    const store = createFileGrantStore({ filePath: grantsFile, workspace });
    const stop = () => { process.stdout.write('stopped\\n'); return new Promise(() => {}) };
    const grants = {
      ...store,
      grant: async (input) => { const record = await store.grant(input); if (stopAt === 'grant_written') await stop(); return record },
      revoke: async (id) => { if (stopAt === 'removing') await stop(); return store.revoke(id) },
    };
    const registry = createApprovalRegistry(grants, approvals);
    const asked = JSON.parse(run);
    const result = 'skip' in asked ? await registry.skipSave({ token: asked.skip, source: SOURCES.cli }) : await registry.recover();
    process.stdout.write(JSON.stringify({ result: result ?? null }) + '\\n');
  `)
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, files.approvals, files.grants, files.workspace, JSON.stringify(run), stopAt ?? ''], { stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (!output.includes('stopped\n')) return
      child.kill('SIGKILL')
      void exited.then(() => resolve({ stopped: true }))
    })
    child.once('exit', (code) => {
      if (output.includes('stopped\n')) return
      const line = output.trim().split('\n').at(-1)
      if (code !== 0 || line === undefined) reject(new Error(`the second process exited with ${code}: ${output}`))
      else resolve(JSON.parse(line) as { result: unknown })
    })
  })
}

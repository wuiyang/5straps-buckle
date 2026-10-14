import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'pathe'
import { CodemodeSandbox, loadQuickJSWasm, renderDeclarations, toCodemodeIdentifier, type CodemodeOutputItem, type CodemodeResult } from '@earendil-works/pi-codemode'
import type { JsonValue } from '@5straps/protocol'
import { keepEndsOfLines } from '../../domain/script-output.js'
import type { ScriptVm, ScriptVmCallRecord, ScriptVmOutputItem, ScriptVmResult, ScriptVmRun, ScriptVmRunInput } from '../../types/ports/script-vm.js'

// The only module that imports @earendil-works/pi-codemode (owner decision D82: "for now, note in the future we will
// implement our own"); code mode reaches it through the ScriptVm port alone.

const PACKAGE = '@earendil-works/pi-codemode'
/** VMs alive in this process at once, each a worker thread with its own QuickJS heap (D82 brief, point 2). */
export const MAX_LIVE_VMS = 4
/**
 * VMs one workspace holds at once, within MAX_LIVE_VMS, so one workspace's agent cannot take every slot and lock code
 * mode out of the node's other workspaces (review of the code-mode slice, finding sandbox-boundary pi-codemode.ts:46).
 */
export const MAX_LIVE_VMS_PER_WORKSPACE = 2

/** Where the installed package's worker file and the QuickJS binary are, found once per process. */
interface Installed { workerUrl: URL; wasmPath: string }
let installed: Installed | undefined
let live = 0
/** Live VMs by the workspace they run for, beside the process's count; kept across a workspace's reloads. */
const liveBy = new Map<string | symbol, number>()

/**
 * The package's own files, resolved against where it is installed rather than beside the module that starts a VM,
 * so a bundled server still finds them. Its exports are ESM only, which `require.resolve` cannot name, so the
 * package folder is found on the lookup path `createRequire` gives, and quickjs-wasi, a dependency of the package
 * and not of Buckle, is resolved from that folder.
 */
function locate(): Installed {
  if (installed) return installed
  const lookup = createRequire(import.meta.url).resolve.paths(PACKAGE) ?? []
  const folder = lookup.map(directory => join(directory, PACKAGE)).find(candidate => existsSync(join(candidate, 'package.json')))
  if (folder === undefined) throw new Error(`${PACKAGE} is not installed beside Buckle`)
  const real = realpathSync(folder)
  installed = {
    workerUrl: pathToFileURL(join(real, 'dist', 'runtime', 'worker.js')),
    wasmPath: createRequire(join(real, 'package.json')).resolve('quickjs-wasi/quickjs.wasm'),
  }
  return installed
}

/** One workspace's VM: its runs count against the workspace's share as well as the process's; its own share when unnamed. */
export function createPiCodemodeVm(options: { workspace?: string } = {}): ScriptVm {
  const share = options.workspace ?? Symbol('script vm')
  return {
    declare: tools => renderDeclarations({ tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, execute: unused })) }),
    identifier: toCodemodeIdentifier,
    start(input) {
      if (live >= MAX_LIVE_VMS) return { busy: `${MAX_LIVE_VMS} scripts already run in this Buckle process; retry once one has finished` }
      const mine = liveBy.get(share) ?? 0
      if (mine >= MAX_LIVE_VMS_PER_WORKSPACE) return { busy: `${MAX_LIVE_VMS_PER_WORKSPACE} scripts already run in this workspace; retry once one has finished` }
      live++
      liveBy.set(share, mine + 1)
      let release = () => {
        live--
        const left = (liveBy.get(share) ?? 1) - 1
        if (left > 0) liveBy.set(share, left)
        else liveBy.delete(share)
        release = () => {}
      }
      try {
        const files = locate()
        const sandbox = new CodemodeSandbox({ wasm: loadQuickJSWasm(files.wasmPath), workerUrl: files.workerUrl, memoryLimitBytes: input.limits.memoryBytes })
        const toolIds: number[] = []
        const run = sandbox.start(input.script, {
          startedAt: input.startedAt,
          seed: input.seed,
          tools: input.tools.map(tool => ({ name: tool.name, jsName: tool.jsName, description: tool.description })),
          globals: input.globals.map(name => ({ name })),
          timeoutMs: input.limits.deadlineMs,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onStarted ? { onStarted: input.onStarted } : {}),
          onCall(call) {
            if (call.target === 'tool') toolIds.push(call.id)
            input.onCall({ id: call.id, target: call.target, name: call.name, args: call.args as JsonValue | undefined })
          },
        })
        // The result settles once the worker has been terminated, so the slot is held until the VM is gone. A failure of
        // the VM itself forgets where the package was found, so a node whose install changed finds it again (review of
        // the code-mode slice, finding sandbox-boundary 91).
        const result = run.result.then((settled) => {
          if (!settled.ok && settled.error.kind === 'sandbox') installed = undefined
          return toResult(settled, toolIds, input.limits.outputChars)
        }).finally(() => release())
        return {
          deliver: (seq, now, id, outcome) => run.deliver(seq, now, id, outcome.ok ? { ok: true, value: outcome.value } : outcome),
          get finished() { return run.finished },
          result,
        } satisfies ScriptVmRun
      } catch (error) {
        release()
        throw error
      }
    },
  }
}

/** The declarations renderer takes tools as the sandbox runs them; a declaration never runs one. */
function unused(): never {
  throw new Error('A declared tool is not run through its declaration')
}

function toResult(result: CodemodeResult, toolIds: number[], outputChars: number): ScriptVmResult {
  const { items: output, truncated } = keepEndsOfLines(result.output.flatMap(toItem), outputChars, text => ({ kind: 'text' as const, text }))
  const calls: ScriptVmCallRecord[] = result.calls.map((call, index) => ({ id: toolIds[index] ?? 0, name: call.name, status: call.status, durationMs: Math.round(call.durationMs) }))
  if (result.ok) return { ok: true, ...(result.value === undefined ? {} : { value: result.value as JsonValue }), output, outputTruncated: truncated, calls }
  const { kind, name, message, stack } = result.error
  return { ok: false, output, outputTruncated: truncated, calls, error: { kind, message, ...(name === undefined ? {} : { name }), ...(stack === undefined ? {} : { stack }) } }
}

/** Code mode has no `image()`: an image item, which no script can make here, is dropped. */
function toItem(item: CodemodeOutputItem): ScriptVmOutputItem[] {
  return item.type === 'text' ? [{ kind: item.console ? 'console' : 'text', text: item.text }] : []
}

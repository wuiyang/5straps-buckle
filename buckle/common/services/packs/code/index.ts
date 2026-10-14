import { randomInt } from 'node:crypto'
import { z } from 'zod'
import type { ApprovalRequest, InvokeResponse, JsonObject, JsonValue, ToolCapability } from '@5straps/protocol'
import type { Pack } from '../../../domain/pack.js'
import { keepEndsOfText } from '../../../domain/script-output.js'
import { defineTool, NestedApprovalRequired, ScriptEndedError, ToolExecutionError, type ToolContext } from '../../../domain/tool.js'
import type { ScriptVm, ScriptVmCall, ScriptVmError, ScriptVmOutcome, ScriptVmResult, ScriptVmRun, ScriptVmTool } from '../../../types/ports/script-vm.js'
import { logger } from '../../../runtime/log.js'
import { requestFingerprint } from '../../invocation/executions.js'
import { loadPackSkill } from '../pack-skill.js'
import { codeRunDescription, declare } from './declarations.js'
import { CODE_REPLAY_TOO_LARGE, createJournalStore, JOURNAL_BYTES, type JournalEntry, type JournalStore } from './journal.js'

// Code mode (owner decision D82, proposed as BUCKLE-D22): an agent's script runs in a VM that can do nothing but call
// this workspace's other tools, each call judged, approved, and audited as a direct call, and only what the script
// prints and returns goes back to the agent.

const PACK_ID = 'code'
/** The code tools, which no script calls (D82, point 3) and no declaration lists. */
export const CODE_TOOLS: readonly string[] = ['code_run', 'code_api']
export const MAX_SCRIPT_CHARS = 262_144
/**
 * Tool calls one script may make, across its resumes, refused ones counted; past it the call fails inside the
 * script, and a script refused as many calls again is ended. Also the most call records code_run hands back.
 */
export const MAX_NESTED_CALLS = 256
/**
 * Calls one script has running at once; a call past it waits for a free slot, so `Promise.all` over many items works
 * (review of the code-mode slice, coordinator decision 2).
 */
export const MAX_IN_FLIGHT = 8
/** Each VM's heap (D82 brief, point 2). */
export const VM_MEMORY_BYTES = 256 * 1_024 * 1_024
/** The most output text, and the most return value as JSON text, a script hands back. */
export const OUTPUT_CHARS = 1_048_576
/** The most of a script error's name, message, and stack, each, that reaches the agent (review of the code-mode slice, finding sandbox-boundary 257). */
export const ERROR_CHARS = 16_384
/** A script's call's arguments, as JSON, are held to the node's request budget; 1 MiB, its default, when none is given. */
export const DEFAULT_ARGUMENT_BYTES = 1_048_576
export const CODE_REPLAY_DIVERGED = 'CODE_REPLAY_DIVERGED'
export const CODE_CALL_LIMIT = 'CODE_CALL_LIMIT'
export const CODE_VM_BUSY = 'CODE_VM_BUSY'
export const REQUEST_TOO_LARGE = 'REQUEST_TOO_LARGE'
/** What the agent reads when the VM itself fails: its own text may name paths on the host, so it goes to the owner's log. */
export const SANDBOX_FAILED = 'The script sandbox stopped unexpectedly; retry, or ask the owner to check the Buckle install and its log'
const DESCRIBE_TOOL = 'describeTool'

export interface CodePackOptions {
  vm: ScriptVm
  /** The tools this workspace's manifest lists now, after node and workspace tool policy: what a script reaches. */
  reachableTools: () => ToolCapability[]
  /** Where this workspace's replay journals are kept: `<state>/code-journal/<workspace key>`. */
  journalDirectory: string
  /** Set by BUCKLE_ALLOW_CODE=false. Never for want of an operating-system sandbox: the VM reaches nothing but tools. */
  unavailableReason: string | null
  /** BUCKLE_MAX_REQUEST_BYTES: a call's arguments past it are refused inside the script, as a direct call's are; DEFAULT_ARGUMENT_BYTES when absent. */
  maxRequestBytes?: number
}

const runInput = z.object({
  script: z.string().min(1).max(MAX_SCRIPT_CHARS).describe('JavaScript, the body of an async function: top-level await and return work.'),
  timeoutMs: z.number().int().positive().optional().describe('Milliseconds the whole script may run, its calls included; the call\'s own timeout when absent, and never past the node\'s maximum.'),
})

const apiInput = z.object({
  tools: z.array(z.string().min(1).max(200)).max(200).optional().describe('The tools to declare; every tool a script reaches when absent.'),
})

export function createCodePack(options: CodePackOptions): Pack {
  const reachable = () => options.reachableTools().filter(tool => !CODE_TOOLS.includes(tool.name))
  const journals = createJournalStore({ directory: options.journalDirectory })
  // Recomputed whenever the reachable tools change, which is when the MCP server registers them again.
  let shown: { key: string; text: string } | undefined
  const description = () => {
    const tools = reachable()
    const key = JSON.stringify(tools.map(tool => [tool.name, tool.description]))
    if (shown?.key !== key) shown = { key, text: codeRunDescription(options.vm, tools) }
    return shown.text
  }
  return {
    id: PACK_ID,
    version: '1.0.0',
    skills: [loadPackSkill(PACK_ID)],
    unavailableReason: options.unavailableReason,
    tools: [
      defineTool(PACK_ID, {
        name: 'code_run',
        description,
        risk: 'execute',
        tags: ['code', 'script'],
        reachesTools: true,
        outsideScripts: true,
        input: runInput,
        timeoutMs: input => input.timeoutMs,
        // The script alone names its calls and its journal: a re-send with another timeoutMs resumes it.
        replayKey: input => ({ script: input.script }),
        // None of its own: each call it makes carries its own, and is judged when it is made.
        effects: () => [],
        run: (input, context) => runScript({ script: input.script, context, vm: options.vm, journals, reachable, argumentBytes: options.maxRequestBytes ?? DEFAULT_ARGUMENT_BYTES }),
      }),
      defineTool(PACK_ID, {
        name: 'code_api',
        description: 'The TypeScript declarations of the tools a code_run script can call, or of the named ones, for a host that cannot read MCP resources.',
        risk: 'read',
        tags: ['code'],
        outsideScripts: true,
        input: apiInput,
        effects: () => [],
        run: async (input) => {
          const tools = reachable()
          const named = input.tools ?? tools.map(tool => tool.name)
          const found = tools.filter(tool => named.includes(tool.name))
          const unreachable = named.filter(name => !tools.some(tool => tool.name === name))
          return { declarations: declare(options.vm, found), ...(unreachable.length > 0 ? { unreachable } : {}) }
        },
      }),
    ],
  }
}

/** A failed or refused call as the script's `Error`: `<code>: <message>`, carrying `code` and `retryable`. */
function failure(code: string, message: string, retryable = false): ScriptVmOutcome {
  return { ok: false, message: `${code}: ${message}`, properties: { code, retryable } }
}

function outcomeOf(response: Exclude<InvokeResponse, { outcome: 'approval_required' }>): ScriptVmOutcome {
  return response.outcome === 'ok' ? { ok: true, value: response.output } : failure(response.error.code, response.error.message, response.error.retryable)
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** How a call is matched against the journal: its tool, or `global:<name>`, and its arguments, hashed. */
function fingerprintOf(target: string, args: JsonValue | undefined): string {
  return requestFingerprint({ tool: target, args: isObject(args) ? args : { value: args ?? null } })
}

/**
 * A call's arguments past the node's request budget, as JSON bytes, or null within it. A direct call that large is
 * refused at the transport; a script's is refused inside the script, before it is fingerprinted, audited, or prepared
 * on the thread every workspace shares (review of the code-mode slice, finding sandbox-boundary 213).
 */
function oversized(args: JsonValue | undefined, limit: number): number | null {
  const bytes = Buffer.byteLength(JSON.stringify(args ?? null))
  return bytes > limit ? bytes : null
}

/**
 * One script, start to end (D82, points 4 to 8). A script that has a journal from a run that stopped before its end
 * is answered from it first, call for call, with the same clock start, seed, and tools, so it makes the same calls
 * again; past the journal its calls run live and are appended. When a call needs a person, no new call starts, the
 * calls already running settle into the journal, the VM stops, and every ask goes back to the invoker together.
 */
async function runScript(input: { script: string; context: ToolContext; vm: ScriptVm; journals: JournalStore; reachable: () => ToolCapability[]; argumentBytes: number }): Promise<JsonValue> {
  const { context, vm, journals } = input
  const { invokeNested, nestedKey: key } = context
  if (!invokeNested || !key) throw new ToolExecutionError('code_run runs only through the invoker, which makes its calls', { code: 'TOOL_EXECUTION_FAILED' })
  const began = performance.now()
  const journal = journals.read(key)
  const tools: ScriptVmTool[] = journal?.tools ?? input.reachable().map(tool => ({ name: tool.name, jsName: vm.identifier(tool.name), description: tool.description }))
  const startedAt = journal?.startedAt ?? Date.now()
  const seed = journal?.seed ?? randomInt(0, 2 ** 32)
  const replay = journal?.entries ?? []
  const replayById = new Map(replay.map(entry => [entry.id, entry]))
  let replayed = 0
  const fresh: JournalEntry[] = []
  // Results are kept for a journal only up to its bound, so a script's memory here stays bounded too; past it, an
  // ask cannot be resumed.
  let journalBytes = Buffer.byteLength(JSON.stringify(replay))
  let overflowed = false
  let nextSeq = replay.length + 1
  const issued = new Set<number>()
  const made = new Set<number>()
  const running = new Map<number, Promise<void>>()
  // Calls past MAX_IN_FLIGHT, started in the order the script made them as slots free.
  const queued: Array<() => void> = []
  const asks: ApprovalRequest[] = []
  // Every tool call the script makes, in its order, replayed, refused, or run: one cap per script across its resumes,
  // since a resumed run makes again every call its journal answers (review of the code-mode slice, findings
  // approvals-replay 210, invoker-audit 210, and tests 210).
  let toolCalls = 0
  // Refused as many calls again past its cap, the script only spins, and is ended (finding sandbox-boundary 254).
  let spun = false
  let broken: { error: unknown } | undefined
  let diverged = false
  let vmName: string | undefined
  const stop = new AbortController()
  const cancel = new AbortController()
  let run: ScriptVmRun | undefined

  const stopping = () => asks.length > 0 || broken !== undefined || diverged || spun
  // The VM stops once nothing it started still runs, so every call that ran is in the journal.
  const settleIfStopping = () => { if (stopping() && running.size === 0) stop.abort(new Error('A call the script made needs approval')) }
  // No queued call starts once the script stops at an ask or has ended: the re-sent script makes it again.
  const startQueued = () => { while (running.size < MAX_IN_FLIGHT && queued.length > 0 && !stopping() && !cancel.signal.aborted) queued.shift()!() }
  const answer = (call: ScriptVmCall, target: string, outcome: ScriptVmOutcome, args = fingerprintOf(target, call.args)) => {
    const entry: JournalEntry = { seq: nextSeq++, now: Date.now(), id: call.id, tool: target, args, outcome }
    if (!overflowed) {
      journalBytes += Buffer.byteLength(JSON.stringify(entry))
      overflowed = journalBytes > JOURNAL_BYTES
      if (overflowed) fresh.length = 0
      else fresh.push(entry)
    }
    if (!stopping()) run?.deliver(entry.seq, entry.now, entry.id, entry.outcome)
  }
  // Journal entries go back in their order, each once the VM has made its call again.
  const flush = () => {
    for (let entry = replay[replayed]; entry !== undefined && issued.has(entry.id); entry = replay[replayed]) {
      replayed++
      if (!stopping()) run?.deliver(entry.seq, entry.now, entry.id, entry.outcome)
    }
  }
  const diverge = () => {
    diverged = true
    settleIfStopping()
  }
  const describe = (args: JsonValue | undefined): ScriptVmOutcome => {
    const tool = input.reachable().find(candidate => candidate.name === args || vm.identifier(candidate.name) === args)
    return { ok: true, value: tool ? declare(vm, [tool]) : undefined }
  }

  const started = vm.start({
    script: input.script,
    tools,
    globals: [DESCRIBE_TOOL],
    limits: { deadlineMs: context.timeoutMs, memoryBytes: VM_MEMORY_BYTES, outputChars: OUTPUT_CHARS },
    startedAt,
    seed,
    signal: AbortSignal.any([context.signal, stop.signal]),
    onStarted(name) {
      vmName = name
      if (journal?.vm !== undefined && journal.vm !== name) diverge()
    },
    onCall(call) {
      issued.add(call.id)
      if (call.target === 'tool') toolCalls++
      const target = call.target === 'global' ? `global:${call.name}` : call.name
      // An oversized call is named by its size alone, so its arguments are never hashed either.
      const bytes = oversized(call.args, input.argumentBytes)
      const fingerprint = bytes === null ? fingerprintOf(target, call.args) : fingerprintOf(target, { oversized: bytes })
      const recorded = replayById.get(call.id)
      if (recorded) {
        if (recorded.tool !== target || recorded.args !== fingerprint) diverge()
        else flush()
        return
      }
      const tooLarge = () => failure(REQUEST_TOO_LARGE, `This call's arguments are ${bytes} bytes as JSON, past the ${input.argumentBytes} a request to this node may carry; pass less, or split the call`)
      if (call.target === 'global') return answer(call, target, bytes !== null ? tooLarge() : call.name === DESCRIBE_TOOL ? describe(call.args) : failure('TOOL_NOT_FOUND', `No global ${call.name}`), fingerprint)
      if (stopping()) return
      if (toolCalls > 2 * MAX_NESTED_CALLS) {
        spun = true
        return settleIfStopping()
      }
      if (toolCalls > MAX_NESTED_CALLS) return answer(call, target, failure(CODE_CALL_LIMIT, `A script makes at most ${MAX_NESTED_CALLS} calls, refused ones and those before an ask counted`), fingerprint)
      if (bytes !== null) return answer(call, target, tooLarge(), fingerprint)
      const args = call.args ?? {}
      if (!isObject(args)) return answer(call, target, failure('INVALID_TOOL_INPUT', 'A tool takes one object of arguments'), fingerprint)
      made.add(call.id)
      const start = () => running.set(call.id, invokeNested({ id: call.id, tool: call.name, args, signal: cancel.signal }).then((response) => {
        if (response.outcome === 'approval_required') asks.push(...response.approvals)
        // A call cut by the script's end, a cancel, or a shutdown is never journaled: the re-sent script makes it
        // again, and Buckle's re-send records answer it if it ran (review of the code-mode slice, finding
        // approvals-replay 228).
        else if (!cancel.signal.aborted && !context.signal.aborted) answer(call, target, outcomeOf(response), fingerprint)
      }).catch((error: unknown) => { broken ??= { error } }).finally(() => {
        running.delete(call.id)
        startQueued()
        settleIfStopping()
      }))
      if (running.size < MAX_IN_FLIGHT) start()
      else queued.push(start)
    },
  })
  if ('busy' in started) throw new ToolExecutionError(started.busy, { code: CODE_VM_BUSY, retryable: true })
  run = started

  const ran = await run.result
  // Ended for spinning past its cap, the script ended by its own doing, as one that throws does.
  const result: ScriptVmResult = spun ? { ...ran, ok: false, error: { kind: 'script', name: 'RangeError', message: `${CODE_CALL_LIMIT}: this script made ${MAX_NESTED_CALLS} calls and went on calling, so Buckle ended it` } } : ran
  // A call the script left running when it ended is cancelled, as the VM's own record says, and waited for. Its own
  // reason, so the call is audited as SCRIPT_ENDED and an ask it waits on stays pending (review of the code-mode
  // slice, finding approvals-replay 685).
  cancel.abort(new ScriptEndedError())
  await Promise.allSettled([...running.values()])

  if (diverged) {
    throw new ToolExecutionError('This script stopped earlier, and run again it made other calls than that run did, so Buckle cannot replay it; the calls of that run already ran. Change the script, even by a comment, to run it from its start', { code: CODE_REPLAY_DIVERGED })
  }
  // The record of what ran, for the re-sent script; false when it passes its bound, and then none is left behind.
  const keep = async (): Promise<boolean> => {
    if (!overflowed && await journals.write({ key, startedAt, seed, ...(vmName === undefined ? {} : { vm: vmName }), tools, entries: [...replay, ...fresh] })) return true
    journals.remove(key)
    return false
  }
  if (broken) {
    await keep()
    throw broken.error
  }
  if (asks.length > 0) {
    if (!await keep()) throw new ToolExecutionError('A call this script made needs approval, but the results its calls returned pass the 32 MiB Buckle keeps to resume a script, so it cannot be resumed; the calls before the ask ran. Make the call that asked on its own, or send a script that keeps less', { code: CODE_REPLAY_TOO_LARGE })
    throw new NestedApprovalRequired(asks)
  }
  // A script that returned, threw, or exited is done: its record goes, and sending it again is a new run whose calls
  // run again. One stopped by its deadline, a cancel, a shutdown, or its sandbox keeps the record of what ran, so the
  // same script sent again within ten minutes, after a restart too, goes on where it stopped and no call runs twice
  // (review of the code-mode slice, finding approvals-replay 240).
  if (result.ok || result.error?.kind === 'script') {
    journals.remove(key)
    context.forgetNested?.([...replay.map(entry => entry.id), ...made])
  } else if (replay.length + fresh.length > 0) {
    await keep().catch((error: unknown) => { logger.warn('Could not keep the replay record of a stopped script; sent again, it runs from its start', { error: error instanceof Error ? error.message : 'Unknown error' }) })
  }
  return shapeResult(result, began)
}

/** What code_run returns (D82, point 8). */
function shapeResult(result: ScriptVmResult, began: number): JsonValue {
  const value = result.value === undefined ? undefined : capValue(result.value)
  // The first MAX_NESTED_CALLS records, the calls the cap counts: past them every call was refused (review of the
  // code-mode slice, finding sandbox-boundary 254).
  const calls = result.calls.slice(0, MAX_NESTED_CALLS)
  const callsOmitted = result.calls.length - calls.length
  const error = result.error ? shapeError(result.error) : undefined
  return {
    ok: result.ok,
    ...(value === undefined ? {} : { value: value.value }),
    output: result.output.map(item => item.text).join('\n'),
    calls: calls.map(call => ({ id: call.id, tool: call.name, status: call.status, durationMs: call.durationMs })),
    ...(callsOmitted > 0 ? { callsOmitted } : {}),
    truncated: result.outputTruncated || value?.truncated === true || callsOmitted > 0 || error?.truncated === true,
    durationMs: Math.round(performance.now() - began),
    ...(error ? { error: error.error } : {}),
  }
}

/**
 * How a script's error reaches the agent. The script writes its name, message, and stack, so each is cut to
 * ERROR_CHARS like the output (review of the code-mode slice, finding sandbox-boundary 257). A failure of the VM
 * itself reaches it as a fixed sentence: its own text may name the host's install paths, so that goes to the owner's
 * log (finding sandbox-boundary 91).
 */
function shapeError(error: ScriptVmError): { error: JsonObject; truncated: boolean } {
  if (error.kind === 'sandbox') {
    logger.warn('A code mode script sandbox failed', { name: error.name ?? 'Error', message: keepEndsOfText(error.message, ERROR_CHARS).text })
    return { error: { kind: error.kind, message: SANDBOX_FAILED }, truncated: false }
  }
  const name = error.name === undefined ? undefined : keepEndsOfText(error.name, ERROR_CHARS)
  const message = keepEndsOfText(error.message, ERROR_CHARS)
  const stack = error.stack === undefined ? undefined : keepEndsOfText(error.stack, ERROR_CHARS)
  return {
    error: { kind: error.kind, ...(name ? { name: name.text } : {}), message: message.text, ...(stack ? { stack: stack.text } : {}) },
    truncated: [name, message, stack].some(field => field?.truncated === true),
  }
}

/** A return value past OUTPUT_CHARS as JSON text becomes that text, cut in the middle. */
function capValue(value: JsonValue): { value: JsonValue; truncated: boolean } {
  const text = JSON.stringify(value)
  if (text.length <= OUTPUT_CHARS) return { value, truncated: false }
  return { value: keepEndsOfText(text, OUTPUT_CHARS).text, truncated: true }
}

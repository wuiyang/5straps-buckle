import { randomInt } from 'node:crypto'
import { z } from 'zod'
import type { ApprovalRequest, InvokeResponse, JsonObject, JsonValue, ToolCapability } from '@5straps/protocol'
import type { Pack } from '../../../domain/pack.js'
import { keepEndsOfText } from '../../../domain/script-output.js'
import { CODE_REPLAY_DIVERGED, defineTool, NestedApprovalRequired, ScriptEndedError, ToolExecutionError, type ToolContext } from '../../../domain/tool.js'
import type { ScriptVm, ScriptVmCall, ScriptVmError, ScriptVmOutcome, ScriptVmResult, ScriptVmRun, ScriptVmTool } from '../../../types/ports/script-vm.js'
import { logger } from '../../../runtime/log.js'
import { REQUEST_ALREADY_EXECUTED, requestFingerprint } from '../../invocation/executions.js'
import { loadPackSkill } from '../pack-skill.js'
import { codeRunDescription, declare } from './declarations.js'
import { CODE_REPLAY_TOO_LARGE, createJournalStore, JOURNAL_BYTES, type GlobalEntry, type JournalEntry, type JournalStore, type RunTool } from './journal.js'

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
/**
 * Calls of `describeTool` and `searchTools` one script may make; past it the script is ended. They are answered from
 * the run's own tool list and recorded by number and arguments alone, so only this bounds the host's work, and the
 * record's, for a script that spins on them (rechecks of the final review of 0.1.4, findings code index.ts:174 and
 * :363).
 */
export const MAX_GLOBAL_CALLS = 10_000
/** Each VM's heap (D82 brief, point 2). */
export const VM_MEMORY_BYTES = 256 * 1_024 * 1_024
/** The most output text, and the most return value as JSON text, a script hands back. */
export const OUTPUT_CHARS = 1_048_576
/** The most of a script error's name, message, and stack, each, that reaches the agent (review of the code-mode slice, finding sandbox-boundary 257). */
export const ERROR_CHARS = 16_384
/** A script's call's arguments, as JSON, are held to the node's request budget; 1 MiB, its default, when none is given. */
export const DEFAULT_ARGUMENT_BYTES = 1_048_576
export { CODE_REPLAY_DIVERGED }
export const CODE_CALL_LIMIT = 'CODE_CALL_LIMIT'
export const CODE_GLOBAL_LIMIT = 'CODE_GLOBAL_LIMIT'
export const CODE_VM_BUSY = 'CODE_VM_BUSY'
export const REQUEST_TOO_LARGE = 'REQUEST_TOO_LARGE'
/** What the agent reads when the VM itself fails: its own text may name paths on the host, so it goes to the owner's log. */
export const SANDBOX_FAILED = 'The script sandbox stopped unexpectedly; retry, or ask the owner to check the Buckle install and its log'
const DESCRIBE_TOOL = 'describeTool'
/**
 * `searchTools(query, { limit? })`: the tools whose name or description holds every word of the query, ignoring case,
 * as `{ name, description }` like ALL_TOOLS. pi-codemode's own error for an unknown tool tells a script to call it
 * (review of the code-mode slice, coordinator decision 3, finding docs-rules SKILL.md:44).
 */
const SEARCH_TOOLS = 'searchTools'
export const SEARCH_LIMIT = 8
const MAX_SEARCH_LIMIT = 100

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
  /** The most results one script keeps for its journal, in memory as on disk; JOURNAL_BYTES when absent. */
  journalBytes?: number
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
        run: (input, context) => runScript({ script: input.script, context, vm: options.vm, journals, reachable, argumentBytes: options.maxRequestBytes ?? DEFAULT_ARGUMENT_BYTES, journalBytes: options.journalBytes ?? JOURNAL_BYTES }),
      }),
      defineTool(PACK_ID, {
        name: 'code_api',
        // Review of the code-mode slice, finding docs-rules code-mode.md:19: no MCP resource carries the declarations.
        description: 'The TypeScript declarations of the tools a code_run script can call, or of the named ones, including those the code_run description only names.',
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

/**
 * What the record answers for a call whose tool had begun to run when a stop cut it: it ran, its effects unknown, and
 * Buckle never runs it again, after a restart too (re-review of the code-mode slice, finding new-surface index.ts:302).
 */
const RAN_WHEN_CUT = failure(REQUEST_ALREADY_EXECUTED, 'This call of the script had begun to run when the script stopped, so its effects are unknown, and Buckle did not run it again. Change the script, even by a comment, to run it from its start')

/**
 * What a record past its bound answers for a call whose result it dropped: the call ran, and Buckle never runs it again,
 * after a restart too (final review of 0.1.4, finding docs code-mode-02.md:19).
 */
const RESULT_DROPPED = failure(REQUEST_ALREADY_EXECUTED, 'This call of the script ran, but the results of the script\'s calls passed the 32 MiB Buckle keeps to resume a script, so its result was not kept, and Buckle did not run it again. Change the script, even by a comment, to run it from its start')

/** Whether a recorded outcome says the call ran before and was not run again: RESULT_DROPPED, RAN_WHEN_CUT, or the like. */
function ranBefore(outcome: ScriptVmOutcome): boolean {
  return !outcome.ok && outcome.properties?.code === REQUEST_ALREADY_EXECUTED
}

/** A call as a stub: a result is dropped for RESULT_DROPPED; a failure holds no result, and stays as it was. */
function stubOf(entry: JournalEntry): JournalEntry {
  return entry.outcome.ok ? { ...entry, outcome: RESULT_DROPPED } : entry
}

/**
 * What a run keeps of its calls for its record, bounded in memory as on disk: each entry whole while they fit `bound`,
 * and from the call that passes it, every entry, the earlier runs' too, as a stub (stubOf). A script past the bound
 * then cannot resume, but its record still says which calls ran, so a re-send, after a restart too, never runs one
 * again (final review of 0.1.4, finding docs code-mode-02.md:19). Stubs that pass the bound too, which only a script
 * of some hundred thousand calls reaches, keep nothing.
 */
function createRunRecord(replay: readonly JournalEntry[], bound: number) {
  const whole: JournalEntry[] = [...replay]
  let stubs: JournalEntry[] | null = null
  let lost = false
  let count = 0
  let bytes = Buffer.byteLength(JSON.stringify(replay))
  const sizeOf = (entry: JournalEntry) => Buffer.byteLength(JSON.stringify(entry)) + 1
  const stub = (kept: JournalEntry[], entry: JournalEntry): void => {
    if (lost) return
    const stubbed = stubOf(entry)
    bytes += sizeOf(stubbed)
    if (bytes <= bound) kept.push(stubbed)
    else {
      lost = true
      kept.length = 0
    }
  }
  return {
    add(entry: JournalEntry): void {
      count++
      if (stubs === null) {
        bytes += sizeOf(entry)
        if (bytes <= bound) return void whole.push(entry)
        stubs = []
        bytes = 2
        for (const earlier of whole.splice(0)) stub(stubs, earlier)
      }
      stub(stubs, entry)
    },
    /** Calls answered in this run, kept or not. */
    get count() { return count },
    /** Whether the results passed the bound: the record then keeps stubs alone. */
    get overflowed() { return stubs !== null },
    /** Every entry whole, while the results fit the bound. */
    whole: (): JournalEntry[] => whole,
    /** Every entry as a stub, or null where even those pass the bound. */
    stubs: (): JournalEntry[] | null => lost ? null : stubs ?? whole.map(stubOf),
  }
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
async function runScript(input: { script: string; context: ToolContext; vm: ScriptVm; journals: JournalStore; reachable: () => ToolCapability[]; argumentBytes: number; journalBytes: number }): Promise<JsonValue> {
  const { context, vm, journals } = input
  const { invokeNested, nestedKey: key } = context
  if (!invokeNested || !key) throw new ToolExecutionError('code_run runs only through the invoker, which makes its calls', { code: 'TOOL_EXECUTION_FAILED' })
  const began = performance.now()
  const journal = journals.read(key)
  // The run's own tools, each with its input schema, so describeTool answers a replay as it answered the first run,
  // whatever the tool policy says since (recheck 2 of the final review of 0.1.4, finding code index.ts:363).
  const tools: RunTool[] = journal?.tools ?? input.reachable().map(tool => ({ name: tool.name, jsName: vm.identifier(tool.name), description: tool.description, inputSchema: tool.inputSchema }))
  // One parent for the script's calls, before and after an ask: its first run's code_run call. Their stage is each
  // send's own, so they share the browser and other state the agent's direct calls of that send reach (final review
  // of 0.1.4, finding invoker 701).
  const parent = journal?.parentRequestId ?? context.nestedParent
  const startedAt = journal?.startedAt ?? Date.now()
  const seed = journal?.seed ?? randomInt(0, 2 ** 32)
  const replay = journal?.entries ?? []
  const replayById = new Map(replay.map(entry => [entry.id, entry]))
  let replayed = 0
  // Results are kept for a journal only up to its bound, so a script's memory here stays bounded too; past it, the
  // script cannot resume, and its calls are kept as stubs that say they ran.
  const record = createRunRecord(replay, input.journalBytes)
  // Results reach the VM numbered without a gap, tools' and globals' alike. A global, describeTool or searchTools, is
  // answered live on every run and its answer never recorded or counted toward the bound (recheck of the final review
  // of 0.1.4, finding code index.ts:174), but each is recorded as a compact entry, its number and fingerprint alone:
  // a replay answers a global only on the number and with the arguments its first run had, and a call that lands on
  // another's number is refused before anything runs (recheck 2, finding code index.ts:363). A global's answer keeps
  // the script's clock where the result before it left it, so the replay reads the same time.
  const replayGlobals = journal?.globals ?? []
  const globalById = new Map(replayGlobals.map(entry => [entry.id, entry]))
  const globals: GlobalEntry[] = [...replayGlobals]
  const prefix = [...replay, ...replayGlobals].reduce((last, entry) => Math.max(last, entry.seq), 0)
  const nowBySeq = new Map(replay.map(entry => [entry.seq, entry.now]))
  // The numbers whose call this send made, recorded or new: a recorded number below the prefix that the send never
  // asked for when the VM goes idle means it took another path (recheck 3 of the final review of 0.1.4, finding code
  // index.ts:368).
  const requested = new Set<number>()
  let nextSeq = prefix + 1
  const issued = new Set<number>()
  const made = new Set<number>()
  // Calls whose tool began to run: cut by a stop, each is journaled as run, effects unknown.
  const executing = new Set<number>()
  const running = new Map<number, Promise<void>>()
  // Calls past MAX_IN_FLIGHT, started in the order the script made them as slots free.
  const queued: Array<{ id: number; start: () => void }> = []
  // Tool calls that never started because the run ended or broke first: reported `skipped`, not `cancelled`.
  const skipped = new Set<number>()
  const asks: ApprovalRequest[] = []
  // Every tool call the script makes, in its order, replayed, refused, or run: one cap per script across its resumes,
  // since a resumed run makes again every call its journal answers (review of the code-mode slice, findings
  // approvals-replay 210, invoker-audit 210, and tests 210).
  let toolCalls = 0
  // Every global call the script makes, describeTool and searchTools, held to MAX_GLOBAL_CALLS.
  let globalCalls = 0
  // Refused as many calls again past its cap, the script only spins, and is ended (finding sandbox-boundary 254), as
  // is one past its global calls: the error it is ended with.
  let spun: string | undefined
  let broken: { error: unknown } | undefined
  let diverged = false
  // Whether the replay handed the script a call that ran before as REQUEST_ALREADY_EXECUTED, its result dropped or its
  // effects unknown: the script is then not done with its calls, however it ends.
  let handedStub = false
  let vmName: string | undefined
  const stop = new AbortController()
  const cancel = new AbortController()
  let run: ScriptVmRun | undefined

  // The results handed to the VM, in order without a gap, and the last one it applied.
  const handed = new Set<number>()
  let handedThrough = 0
  let applied: number | undefined
  const hand = (seq: number, now: number, id: number, outcome: ScriptVmOutcome) => {
    run?.deliver(seq, now, id, outcome)
    handed.add(seq)
    while (handed.has(handedThrough + 1)) handedThrough++
  }

  // Stopping: no result goes to the VM any more. Halted: no call of the script starts any more either. An ask stops
  // the script without halting it, so the calls of the turn it came in, which reach onCall until the VM goes idle,
  // still run or ask (re-review of the code-mode slice, findings new-surface and tests index.ts:287).
  const stopping = () => asks.length > 0 || broken !== undefined || diverged || spun !== undefined
  const halted = () => broken !== undefined || diverged || spun !== undefined
  // Ended: the VM is done, so a queued call never starts (re-review, finding new-surface index.ts:224).
  const ended = () => halted() || cancel.signal.aborted || run?.finished === true
  const dropQueue = () => {
    for (const item of queued) skipped.add(item.id)
    queued.length = 0
  }
  // At an ask, the VM stops once its turn is over and every call of that turn has run or asked: nothing runs or waits
  // in the queue, and the VM has applied every result it was handed, so every call it made has reached onCall. Calls
  // made at once come back together however the threads are scheduled (review of the code-mode slice, finding tests
  // 242).
  const settleIfStopping = () => {
    if (!stopping() || running.size > 0) return
    if (halted()) dropQueue()
    if (halted() || queued.length === 0 && applied !== undefined && applied >= handedThrough) stop.abort(new Error('A call the script made needs approval'))
  }
  const startQueued = () => {
    if (ended()) return dropQueue()
    while (running.size < MAX_IN_FLIGHT && queued.length > 0) queued.shift()!.start()
  }
  const answer = (call: ScriptVmCall, target: string, outcome: ScriptVmOutcome, args = fingerprintOf(target, call.args)) => {
    const entry: JournalEntry = { seq: nextSeq++, now: Date.now(), id: call.id, tool: target, args, outcome }
    nowBySeq.set(entry.seq, entry.now)
    requested.add(entry.seq)
    record.add(entry)
    if (!stopping()) hand(entry.seq, entry.now, entry.id, entry.outcome)
  }
  const answerGlobal = (call: ScriptVmCall, recorded: GlobalEntry | undefined, args: string, outcome: ScriptVmOutcome) => {
    const seq = recorded?.seq ?? nextSeq++
    if (!recorded) globals.push({ seq, id: call.id, name: call.name, args })
    const now = nowBySeq.get(seq - 1) ?? startedAt
    nowBySeq.set(seq, now)
    requested.add(seq)
    if (!stopping()) hand(seq, now, call.id, outcome)
  }
  // Journal entries go back in their order, each once the VM has made its call again.
  const flush = () => {
    for (let entry = replay[replayed]; entry !== undefined && issued.has(entry.id); entry = replay[replayed]) {
      replayed++
      if (stopping()) continue
      hand(entry.seq, entry.now, entry.id, entry.outcome)
      if (ranBefore(entry.outcome)) handedStub = true
    }
  }
  const diverge = () => {
    diverged = true
    settleIfStopping()
  }
  // From the run's own list alone: a tool it does not hold was out of the script's reach when the run began, and is
  // answered so on every replay whatever the tool policy says since, as searchTools and the tools are (recheck 3 of the
  // final review of 0.1.4, finding code index.ts:368).
  const describe = (args: JsonValue | undefined): ScriptVmOutcome => {
    const own = tools.find(candidate => candidate.name === args || candidate.jsName === args)
    return { ok: true, value: own ? declare(vm, [own]) : undefined }
  }
  const global = (name: string, args: JsonValue | undefined): ScriptVmOutcome => {
    if (name === DESCRIBE_TOOL) return describe(args)
    if (name === SEARCH_TOOLS) return search(tools, args)
    return failure('TOOL_NOT_FOUND', `No global ${name}`)
  }

  const started = vm.start({
    script: input.script,
    tools: tools.map(tool => ({ name: tool.name, jsName: tool.jsName, description: tool.description })),
    globals: [{ name: DESCRIBE_TOOL }, { name: SEARCH_TOOLS, spread: true }],
    limits: { deadlineMs: context.timeoutMs, memoryBytes: VM_MEMORY_BYTES, outputChars: OUTPUT_CHARS },
    startedAt,
    seed,
    signal: AbortSignal.any([context.signal, stop.signal]),
    onStarted(name) {
      vmName = name
      if (journal?.vm !== undefined && journal.vm !== name) diverge()
    },
    onIdle(seq) {
      applied = seq
      // Idle below the record's last entry with the next number one this send never asked for: it did not make a call
      // its first run made there, and the VM would wait for ever. Refused, never left to its deadline (recheck 3 of the
      // final review of 0.1.4, finding code index.ts:368). A send stopping at an ask hands nothing more, and stops.
      if (!stopping() && seq < prefix && !requested.has(seq + 1)) diverge()
      settleIfStopping()
    },
    onCall(call) {
      issued.add(call.id)
      if (call.target === 'tool') toolCalls++
      else globalCalls++
      const target = call.target === 'global' ? `global:${call.name}` : call.name
      // An oversized call is named by its size alone, so its arguments are never hashed either.
      const bytes = oversized(call.args, input.argumentBytes)
      const fingerprint = bytes === null ? fingerprintOf(target, call.args) : fingerprintOf(target, { oversized: bytes })
      const recorded = replayById.get(call.id)
      if (recorded) {
        if (recorded.tool !== target || recorded.args !== fingerprint) return diverge()
        requested.add(recorded.seq)
        flush()
        return
      }
      // A tool call on a number the first run gave a global, or a global with other arguments than it had there.
      const recordedGlobal = globalById.get(call.id)
      if (recordedGlobal && (recordedGlobal.name !== call.name || recordedGlobal.args !== fingerprint || call.target !== 'global')) return diverge()
      const tooLarge = () => failure(REQUEST_TOO_LARGE, `This call's arguments are ${bytes} bytes as JSON, past the ${input.argumentBytes} a request to this node may carry; pass less, or split the call`)
      if (call.target === 'global') {
        if (globalCalls > MAX_GLOBAL_CALLS) {
          spun ??= `${CODE_GLOBAL_LIMIT}: this script called describeTool and searchTools more than ${MAX_GLOBAL_CALLS} times, so Buckle ended it`
          return settleIfStopping()
        }
        return answerGlobal(call, recordedGlobal, fingerprint, bytes !== null ? tooLarge() : global(call.name, call.args))
      }
      if (halted()) {
        skipped.add(call.id)
        return
      }
      if (toolCalls > 2 * MAX_NESTED_CALLS) {
        spun ??= `${CODE_CALL_LIMIT}: this script made ${MAX_NESTED_CALLS} calls and went on calling, so Buckle ended it`
        return settleIfStopping()
      }
      if (toolCalls > MAX_NESTED_CALLS) return answer(call, target, failure(CODE_CALL_LIMIT, `A script makes at most ${MAX_NESTED_CALLS} calls, refused ones and those before an ask counted`), fingerprint)
      if (bytes !== null) return answer(call, target, tooLarge(), fingerprint)
      const args = call.args ?? {}
      if (!isObject(args)) return answer(call, target, failure('INVALID_TOOL_INPUT', 'A tool takes one object of arguments'), fingerprint)
      made.add(call.id)
      const start = () => running.set(call.id, invokeNested({ id: call.id, tool: call.name, args, signal: cancel.signal, onExecute: () => executing.add(call.id), ...(parent === undefined ? {} : { parentRequestId: parent }) }).then((response) => {
        const cut = cancel.signal.aborted || context.signal.aborted
        if (response.outcome === 'approval_required') asks.push(...response.approvals)
        // A call cut by the script's end, a cancel, or a shutdown after its tool began to run is journaled as run,
        // effects unknown, whatever it answered, a retryable error too, so the record on disk refuses it after a
        // restart (re-review of the code-mode slice, findings new-surface and fixes-hold index.ts:302; re-check of
        // round 3, finding journal-turn index.ts:330).
        else if (cut && executing.has(call.id)) answer(call, target, RAN_WHEN_CUT, fingerprint)
        // A retryable refusal that came once the script stopped at an ask, such as APPROVAL_LIMIT when the turn asked
        // more than a session may, never reached the script: it is not journaled, so the retry, after the person has
        // answered, makes the call again rather than replaying the refusal (re-check of round 2, finding journal-turn
        // index.ts:326).
        else if (asks.length > 0 && response.outcome === 'error' && response.error.retryable) return
        // A call cut before its tool ran, such as one waiting for a person, is not journaled: the re-sent script makes
        // it again (review of the code-mode slice, finding approvals-replay 228).
        else if (!cut) answer(call, target, outcomeOf(response), fingerprint)
      }).catch((error: unknown) => { broken ??= { error } }).finally(() => {
        running.delete(call.id)
        startQueued()
        settleIfStopping()
      }))
      if (ended()) skipped.add(call.id)
      else if (running.size < MAX_IN_FLIGHT) start()
      else queued.push({ id: call.id, start })
    },
  })
  if ('busy' in started) throw new ToolExecutionError(started.busy, { code: CODE_VM_BUSY, retryable: true })
  run = started

  const ran = await run.result
  // Ended for spinning past its cap, the script ended by its own doing, as one that throws does.
  const result: ScriptVmResult = spun !== undefined ? { ...ran, ok: false, error: { kind: 'script', name: 'RangeError', message: spun } } : ran
  // A call the script left running when it ended is cancelled, as the VM's own record says, and waited for. Its own
  // reason, so the call is audited as SCRIPT_ENDED and an ask it waits on stays pending (review of the code-mode
  // slice, finding approvals-replay 685).
  cancel.abort(new ScriptEndedError())
  await Promise.allSettled([...running.values()])

  // A withdrawal that fails, behind an approvals lock busy past its wait or a disk that refuses it, is logged, and its
  // asks stay pending until they expire: the agent still gets the script's own answer, never a STATE_BUSY that says a
  // call ran unrecorded (final review of 0.1.4, finding code index.ts:365).
  const withdraw = async (tokens: readonly string[], whose: string): Promise<void> => {
    await context.withdrawNested?.(tokens).catch((error: unknown) => {
      logger.warn(`Could not withdraw the asks of a script ${whose}; they stay pending until they expire`, { error: error instanceof Error ? error.message : 'Unknown error' })
    })
  }

  if (diverged) {
    // A record that diverged diverges on every re-send, so the asks of its run go, which no call would ever spend
    // (re-review of the code-mode slice, finding docs-rules code-mode.md:76). The record itself is kept until it
    // expires, however the replay diverged: it exists so that no call runs twice, and dropping it let the next send
    // after a restart run them all again (rechecks 2 and 3 of the final review of 0.1.4, findings code index.ts:477
    // and :487). Changing the script gives it a new record.
    await withdraw([...new Set([...journal?.asks ?? [], ...asks.map(ask => ask.token)])], 'that diverged')
    throw new ToolExecutionError('This script stopped earlier, and run again it made other calls than that run did, so Buckle cannot replay it; the calls of that run already ran. Change the script, even by a comment, to run it from its start', { code: CODE_REPLAY_DIVERGED })
  }
  // The caller's own cancel withdraws the asks the script already collected, as it withdraws a waiting call's: the
  // caller has gone, and nobody is told of them (re-review of the code-mode slice, finding new-surface index.ts:338).
  // They come out of `asks` first, so the record names none, and are withdrawn only once the record is written, as
  // CODE_REPLAY_TOO_LARGE does; a withdrawal that fails is logged, and the record stays (re-check of round 2,
  // finding journal-turn index.ts:365).
  const leftBehind = asks.length > 0 && context.callerCancelled?.() === true ? asks.splice(0) : []
  // The asks the record names: those of the runs before this one with this run's, so a resumed run that stops before
  // it reaches its ask again still names that ask, which stays pending, for `buckle approvals show` and for the
  // withdrawal a later divergence makes; never one the caller's cancel withdraws (final review of 0.1.4, finding code
  // index.ts:371).
  const pendingAsks = (): string[] => {
    const withdrawn = new Set(leftBehind.map(ask => ask.token))
    return [...new Set([...journal?.asks ?? [], ...asks.map(ask => ask.token)])].filter(token => !withdrawn.has(token))
  }
  const write = (named: readonly string[], entries: JournalEntry[]) => journals.write({
    key, startedAt, seed, ...(vmName === undefined ? {} : { vm: vmName }), script: input.script, ...(named.length > 0 ? { asks: [...named] } : {}),
    ...(parent === undefined ? {} : { parentRequestId: parent }), tools, entries, globals,
  })
  // The record of what ran, for the re-sent script, naming the asks `named`: whole, so the script resumes where it
  // stopped, or else, past its bound as this run counts it or as the store does, its
  // calls as stubs, so the script cannot resume but none of its calls runs again (final review of 0.1.4, finding docs
  // code-mode-02.md:19). False where even the stubs pass it, and then none is left behind.
  const keepWhole = async (named: readonly string[]): Promise<boolean> => !record.overflowed && await write(named, record.whole())
  const keepStubs = async (named: readonly string[]): Promise<boolean> => {
    const stubs = record.stubs()
    if (stubs !== null && await write(named, stubs)) return true
    journals.remove(key)
    return false
  }
  const keep = async (named: readonly string[]): Promise<boolean> => await keepWhole(named) || await keepStubs(named)
  try {
    if (broken) {
      await keep(pendingAsks())
      throw broken.error
    }
    if (asks.length > 0) {
      if (await keepWhole(pendingAsks())) throw new NestedApprovalRequired(asks)
      // No call will spend these asks, nor those of the runs before it: the script cannot resume, so they leave the
      // queue as a denied sibling's do, and the record keeps its calls as stubs alone, naming none (final review of
      // 0.1.4, findings code index.ts:371 and docs code-mode-02.md:19).
      const stubbed = await keepStubs([])
      await withdraw(pendingAsks(), 'that cannot resume')
      throw new ToolExecutionError(`A call this script made needs approval, but the results its calls returned pass the 32 MiB Buckle keeps to resume a script, so it cannot be resumed; the calls before the ask ran${stubbed ? ', and sent again unchanged they are not run again' : ''}. Make the call that asked on its own, or send a script that keeps less`, { code: CODE_REPLAY_TOO_LARGE })
    }
    // A script that returned, threw, or exited is done: its record goes, and sending it again is a new run whose calls
    // run again. One stopped by its deadline, a cancel, a shutdown, or its sandbox keeps the record of what ran, so the
    // same script sent again within ten minutes, after a restart too, goes on where it stopped and no call runs twice
    // (review of the code-mode slice, finding approvals-replay 240); past its bound it cannot go on, and its calls are
    // answered by their stubs (final review of 0.1.4, finding docs code-mode-02.md:19).
    // A script handed a stub, which nearly always throws on it, keeps its record until it expires, and Buckle keeps
    // its own memory of the calls, so every unchanged send in those ten minutes, not only the next, runs none of the
    // calls again; one that went on to make new calls has them recorded too (recheck of the final review of 0.1.4,
    // finding code index.ts:480). Changing the script runs it from its start.
    if ((result.ok || result.error?.kind === 'script') && handedStub) {
      if (record.count > 0) await keep(pendingAsks()).catch((error: unknown) => { logger.warn('Could not keep the replay record of a script handed a call that ran; sent again, it may run its new calls again', { error: error instanceof Error ? error.message : 'Unknown error' }) })
    } else if (result.ok || result.error?.kind === 'script') {
      journals.remove(key)
      context.forgetNested?.([...replay.map(entry => entry.id), ...made])
    } else if (replay.length + record.count > 0) {
      const kept = await keep(pendingAsks()).catch((error: unknown) => {
        logger.warn('Could not keep the replay record of a stopped script; sent again, it runs from its start', { error: error instanceof Error ? error.message : 'Unknown error' })
        return true
      })
      if (!kept) logger.warn('The replay record of a stopped script passes its bound even with its results dropped; sent again, it runs from its start', { calls: replay.length + record.count })
    }
    return shapeResult(result, began, skipped)
  } finally {
    if (leftBehind.length > 0) await withdraw(leftBehind.map(ask => ask.token), 'whose caller cancelled')
  }
}

/** searchTools(query, { limit? }) over the run's tools: every word of the query in a name or description, names first. */
function search(tools: readonly ScriptVmTool[], args: JsonValue | undefined): ScriptVmOutcome {
  const [query, options] = Array.isArray(args) ? args : []
  const limit = options === undefined || options === null ? SEARCH_LIMIT : isObject(options) ? options.limit ?? SEARCH_LIMIT : undefined
  if (typeof query !== 'string' || query.trim() === '' || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    return failure('INVALID_TOOL_INPUT', `searchTools(query, { limit }) takes words to look for and, optionally, a whole limit from 1 to ${MAX_SEARCH_LIMIT}`)
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const found = tools.filter(tool => words.every(word => `${tool.name} ${tool.jsName} ${tool.description}`.toLowerCase().includes(word)))
  const named = (tool: ScriptVmTool) => words.some(word => tool.name.toLowerCase().includes(word))
  const ranked = [...found.filter(named), ...found.filter(tool => !named(tool))]
  return { ok: true, value: ranked.slice(0, limit).map(tool => ({ name: tool.jsName, description: tool.description })) }
}

/** What code_run returns (D82, point 8). */
function shapeResult(result: ScriptVmResult, began: number, skipped: ReadonlySet<number>): JsonValue {
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
    calls: calls.map(call => ({ id: call.id, tool: call.name, status: skipped.has(call.id) ? 'skipped' : call.status, durationMs: call.durationMs })),
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

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntimeOwner, defineScoped, defineSingleton, defineTransient, RuntimeError, RuntimeErrorCode, useScope, type CloseStage, type Closer, type Logger, type RuntimeOwner } from '@5straps/runtime'
import { acquireOwnershipLock, createConnectionOwner, openDatabase } from '@5straps/runtime/sqlite'
import { createAccessService } from './access.js'
import { createApprovalQueue, type ApprovalQueue } from './approvals.js'
import type { FixtureConfig } from './config.js'
import { createNoteRepository, type NoteRepository } from './notes.js'
import type { FixtureServices, NoteService, OperationService, RuntimeRole, TransientProbe } from './types.js'

export interface FixtureRuntime {
  owner: RuntimeOwner
  services: FixtureServices
  logger: Logger
  start(): Promise<void>
  // The owner logs each close step as it runs, so close order is observable.
  onClose(stage: CloseStage, name: string, closer: Closer): void
}

interface Ports { notes?: NoteRepository; approvals?: ApprovalQueue }

// One common runtime per process owner; main calls this once and hands the result to each entry point.
export function initializeCommon(input: { config: FixtureConfig; logger: Logger; role: RuntimeRole }): FixtureRuntime {
  const { config, logger, role } = input
  const ports: Ports = {}
  const definitions = defineFixtureServices({ config, logger, ports })
  const owner = createRuntimeOwner({ name: `fixture-${role}`, services: Object.values(definitions), closeStepTimeoutMs: config.closeStepTimeoutMs, logger })
  const onClose = (stage: CloseStage, name: string, closer: Closer) => owner.onClose(stage, name, closer)
  const services: FixtureServices = {
    getAccess: () => owner.registry.useSingleton(definitions.access),
    getNotes: () => owner.registry.useSingleton(definitions.notes),
    getApprovals: () => owner.registry.useSingleton(definitions.approvals),
    getOperation: (scope = useScope()) => owner.registry.useScoped(definitions.operation, scope),
    createProbe: (scope = useScope()) => owner.registry.createTransient(definitions.probe, scope),
  }
  logger.info('common initialized', { role })
  return {
    owner,
    services,
    logger,
    onClose,
    start: () => owner.start(() => startCommon({ config, role, owner, ports, onClose, logger })),
  }
}

async function startCommon(input: { config: FixtureConfig; role: RuntimeRole; owner: RuntimeOwner; ports: Ports; onClose: FixtureRuntime['onClose']; logger: Logger }): Promise<void> {
  const { config, owner } = input
  if (config.startupGate) await waitForFile(config.startupGate, owner.signal)
  if (config.startupFails) throw new Error('Startup failure requested by FIXTURE_STARTUP_FAILS')
  const db = await openDatabase({ path: join(config.dataDir, 'notes.sqlite') })
  const connection = createConnectionOwner(db, { owned: true, label: 'notes' })
  input.onClose('databases', 'notes database', () => connection.close())
  input.ports.notes = await createNoteRepository(connection)
  input.ports.approvals = await createApprovalQueue(connection)
  if (input.role === 'server') {
    // One server per data directory; the CLI and MCP share the database without this lock.
    const lock = await acquireOwnershipLock({ path: join(config.dataDir, 'server.lock'), owner })
    input.logger.info('ownership lock held', { path: lock.path })
  }
  input.logger.info('common ready', { role: input.role })
}

const GATE_POLL_MS = 20

async function waitForFile(path: string, signal: AbortSignal): Promise<void> {
  while (!existsSync(path)) await delay(GATE_POLL_MS, undefined, { signal })
}

function defineFixtureServices(input: { config: FixtureConfig; logger: Logger; ports: Ports }) {
  const { logger, ports } = input
  let executed = 0
  const access = defineSingleton({
    name: 'AccessService',
    create: () => createAccessService({ agent: input.config.agentToken, admin: input.config.adminToken }),
  })
  const notes = defineSingleton<NoteService>({
    name: 'NoteService',
    create: () => {
      if (!ports.notes) throw new RuntimeError(RuntimeErrorCode.notReady, 'Notes storage is not open yet')
      logger.info('service created', { service: 'NoteService' })
      return ports.notes
    },
  })
  const approvals = defineSingleton<ApprovalQueue>({
    name: 'ApprovalQueue',
    create: () => {
      if (!ports.approvals) throw new RuntimeError(RuntimeErrorCode.notReady, 'Approval queue is not open yet')
      return ports.approvals
    },
  })
  const operation = defineScoped<OperationService>({
    name: 'OperationService',
    create: ({ scope }) => ({
      correlationId: scope!.context.correlationId,
      actor: scope!.context.actor,
      record(name) {
        executed += 1
        logger.info('operation executed', { operation: name, serial: executed })
        return executed
      },
    }),
  })
  const probe = defineTransient<TransientProbe>({ name: 'TransientProbe', create: () => ({ id: randomUUID() }) })
  return { access, notes, approvals, operation, probe }
}

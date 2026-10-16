import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { createRuntimeOwner } from '@5straps/runtime'
import { describe, expect, it, vi } from 'vitest'
import { AlreadyServingError, holdServe, readRecord, requestStop, runningNode, serviceDirectory, waitForStop, watchStopRequest } from '../common/services/node-service/serve-record.js'

// Phase 3 of the workspace-model slice: a node serving with no terminal holds its state directory's serve lock for its
// life, records its pid and address, and stops when a stop request names it, as Windows delivers it no SIGTERM.

function stateDirectory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-serve-record-')))
  const state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  return state
}

function owner() {
  return createRuntimeOwner({ name: 'serve-record-test', services: [] })
}

const LISTENING = { manager: 'background', version: '0.1.4', host: '127.0.0.1', port: 4320 } as const

describe('the serve lock and record', () => {
  it('names no running node before one holds the lock, the record once it listens, and none after it closes', async () => {
    const state = stateDirectory()
    expect(await runningNode(state)).toBeNull()

    const holder = owner()
    const hold = await holdServe({ stateDirectory: state, owner: holder })
    expect(await runningNode(state)).toEqual({ record: null })
    await hold.publish(LISTENING)
    expect(await runningNode(state)).toEqual({ record: expect.objectContaining({ ...LISTENING, pid: process.pid }) })
    if (process.platform !== 'win32') {
      expect(statSync(serviceDirectory(state)).mode & 0o777).toBe(0o700)
      expect(statSync(join(serviceDirectory(state), 'serve.json')).mode & 0o777).toBe(0o600)
    }

    await holder.close()
    expect(await runningNode(state)).toBeNull()
    expect(readRecord(state)).toBeNull()
  })

  it('refuses a second holder of the same state directory, as already running in service mode', async () => {
    const state = stateDirectory()
    const first = owner()
    await holdServe({ stateDirectory: state, owner: first })
    const second = owner()
    await expect(holdServe({ stateDirectory: state, owner: second })).rejects.toThrow(new AlreadyServingError('Buckle is already running in service mode'))
    await first.close()
    await holdServe({ stateDirectory: state, owner: second })
    await second.close()
  })

  it('clears a stop request an earlier process left, so it never ends this one', async () => {
    const state = stateDirectory()
    await requestStop(state, process.pid)
    const holder = owner()
    await holdServe({ stateDirectory: state, owner: holder })
    expect(existsSync(join(serviceDirectory(state), 'stop-request'))).toBe(false)
    await holder.close()
  })

  // Fix brief 6, item 7 (finding 31 of recheck 4): a node killed before its close stage left its record, which the next
  // holder was reported by until it listened: the dead pid, the old address, and the old version.
  it('clears a record an earlier process left, so the new holder has none until it listens', async () => {
    const state = stateDirectory()
    mkdirSync(serviceDirectory(state), { recursive: true, mode: 0o700 })
    writeFileSync(join(serviceDirectory(state), 'serve.json'), JSON.stringify({ pid: 999_999, manager: 'systemd', version: '0.1.3', host: '127.0.0.1', port: 1111, startedAt: '2026-10-01T00:00:00.000Z' }))
    const holder = owner()
    const hold = await holdServe({ stateDirectory: state, owner: holder })
    expect(await runningNode(state)).toEqual({ record: null })
    await hold.publish(LISTENING)
    expect(await runningNode(state)).toEqual({ record: expect.objectContaining({ pid: process.pid, port: 4320 }) })
    await holder.close()
  })

  it('waits for a node to stop, and says when it has not', async () => {
    const state = stateDirectory()
    const holder = owner()
    await holdServe({ stateDirectory: state, owner: holder })
    expect(await waitForStop(state, 200)).toBe(false)
    setTimeout(() => void holder.close(), 100)
    expect(await waitForStop(state, 5_000)).toBe(true)
  })
})

describe('a stop request', () => {
  it('stops the process it names, once, and is removed', async () => {
    const state = stateDirectory()
    const onStop = vi.fn()
    const stop = watchStopRequest({ stateDirectory: state, onStop, intervalMs: 20 })
    try {
      await requestStop(state, process.pid)
      await vi.waitFor(() => expect(onStop).toHaveBeenCalledTimes(1))
      expect(existsSync(join(serviceDirectory(state), 'stop-request'))).toBe(false)
      if (process.platform !== 'win32') expect(statSync(serviceDirectory(state)).mode & 0o777).toBe(0o700)
    } finally { stop() }
  })

  it('is ignored when it names another process, or cannot be read', async () => {
    const state = stateDirectory()
    const onStop = vi.fn()
    const stop = watchStopRequest({ stateDirectory: state, onStop, intervalMs: 20 })
    try {
      await requestStop(state, process.pid + 1)
      await new Promise(resolve => setTimeout(resolve, 100))
      writeFileSync(join(serviceDirectory(state), 'stop-request'), 'not json')
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(onStop).not.toHaveBeenCalled()
      expect(readFileSync(join(serviceDirectory(state), 'stop-request'), 'utf8')).toBe('not json')
    } finally { stop() }
  })
})

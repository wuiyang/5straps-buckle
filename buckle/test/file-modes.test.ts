import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSigningKey } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCommand, CLIENT_KEY_FILE, loadClientKey } from '../cli/client.js'
import { configureOwnerOnlyCheck, isOpenToOthers, OwnerOnlyError, requireOwnerOnly, setDescriptorMode, setMode, SKIP_OWNER_ONLY_FLAG } from '../common/adapters/file-modes.js'
import { loadNodeKey } from '../common/adapters/keys/file-node-key.js'

// Windows keeps no POSIX modes: Node reports 0o666 there and chmod sets only the read-only flag. These tests
// imitate it on Linux through the platform each check takes, process.platform by default.

afterEach(() => {
  vi.restoreAllMocks()
  configureOwnerOnlyCheck({ skip: false })
})

const modeOf = (path: string) => statSync(path).mode & 0o777

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'buckle-file-modes-'))
}

function directoryWithMode(mode: number): string {
  const directory = join(scratch(), 'state')
  mkdirSync(directory)
  chmodSync(directory, mode)
  return directory
}

function fileWithMode(mode: number, content = ''): string {
  const file = join(scratch(), 'file')
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

function keyWithMode(mode: number): string {
  return fileWithMode(mode, generateSigningKey().privateKeyPem)
}

const warnings = () => ({ warn: vi.fn() })

describe('modes on Windows, imitated', () => {
  it('changes no mode on win32, by path or by descriptor, and narrows elsewhere', () => {
    const file = fileWithMode(0o644)
    setMode(file, 0o600, 'win32')
    const descriptor = openSync(file, 'r')
    try { setDescriptorMode(descriptor, 0o600, 'win32') } finally { closeSync(descriptor) }
    expect(modeOf(file)).toBe(0o644)
    expect(isOpenToOthers(file, 'win32')).toBe(false)
    expect(isOpenToOthers(file, 'linux')).toBe(true)
    setMode(file, 0o600, 'linux')
    expect(modeOf(file)).toBe(0o600)
    chmodSync(file, 0o644)
    const reopened = openSync(file, 'r')
    try { setDescriptorMode(reopened, 0o600, 'darwin') } finally { closeSync(reopened) }
    expect(modeOf(file)).toBe(0o600)
  })

  it('passes the state directory on win32 whatever its mode, without a warning', () => {
    const logger = warnings()
    for (const mode of [0o777, 0o755, 0o700]) requireOwnerOnly(directoryWithMode(mode), 'directory', { platform: 'win32', logger })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('passes the node key and the client key on win32 whatever their mode', () => {
    const nodeKey = keyWithMode(0o666)
    expect(loadNodeKey(nodeKey, { platform: 'win32' }).publicKey).toEqual(expect.any(String))
    const device = directoryWithMode(0o777)
    writeFileSync(join(device, CLIENT_KEY_FILE), generateSigningKey().privateKeyPem)
    chmodSync(join(device, CLIENT_KEY_FILE), 0o666)
    expect(loadClientKey({ BUCKLE_CLIENT_DIR: device }, { platform: 'win32' }).keyId).toEqual(expect.any(String))
  })
})

describe('owner-only checks on Linux and macOS', () => {
  it('refuses an open state directory, naming the chmod line and the flag', () => {
    const directory = directoryWithMode(0o755)
    for (const platform of ['linux', 'darwin'] as const) {
      expect(() => requireOwnerOnly(directory, 'directory', { platform })).toThrow(OwnerOnlyError)
      expect(() => requireOwnerOnly(directory, 'directory', { platform })).toThrow(`chmod 700 ${directory}, or pass ${SKIP_OWNER_ONLY_FLAG}`)
    }
    expect(() => requireOwnerOnly(directoryWithMode(0o700), 'directory', { platform: 'linux' })).not.toThrow()
    expect(() => requireOwnerOnly(join(directory, 'not-yet-made'), 'directory', { platform: 'linux' })).not.toThrow()
  })

  it('refuses an open node key or client key, naming chmod 600 and the flag', async () => {
    const nodeKey = keyWithMode(0o644)
    expect(() => loadNodeKey(nodeKey, { platform: 'linux' })).toThrow(`chmod 600 ${nodeKey}, or pass ${SKIP_OWNER_ONLY_FLAG}`)
    const device = directoryWithMode(0o700)
    writeFileSync(join(device, CLIENT_KEY_FILE), generateSigningKey().privateKeyPem)
    chmodSync(join(device, CLIENT_KEY_FILE), 0o644)
    expect(() => loadClientKey({ BUCKLE_CLIENT_DIR: device }, { platform: 'linux' })).toThrow(OwnerOnlyError)
    let stderr = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // A refusal is the command's answer at the terminal, not a crash.
    expect((await clientCommand(['key'], { BUCKLE_CLIENT_DIR: device })).exitCode).toBe(1)
    expect(stderr).toContain(SKIP_OWNER_ONLY_FLAG)
  })

  it('with the flag, uses an open directory or key and logs one warning naming it', () => {
    const directory = directoryWithMode(0o755)
    const logger = warnings()
    requireOwnerOnly(directory, 'directory', { platform: 'linux', skip: true, logger })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Directory ${directory} is accessible to other users (mode 755)`), { path: directory })
    expect(modeOf(directory)).toBe(0o755)
    const nodeKey = keyWithMode(0o644)
    const keyLogger = warnings()
    expect(loadNodeKey(nodeKey, { platform: 'linux', skip: true, logger: keyLogger }).publicKey).toEqual(expect.any(String))
    expect(keyLogger.warn).toHaveBeenCalledTimes(1)
    expect(keyLogger.warn).toHaveBeenCalledWith(expect.stringContaining(nodeKey), { path: nodeKey })
  })

  it('takes the flag from the command line when a check names none', () => {
    const directory = directoryWithMode(0o750)
    const logger = warnings()
    configureOwnerOnlyCheck({ skip: true })
    requireOwnerOnly(directory, 'directory', { platform: 'linux', logger })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    configureOwnerOnlyCheck({ skip: false })
    expect(() => requireOwnerOnly(directory, 'directory', { platform: 'linux', logger })).toThrow(OwnerOnlyError)
  })
})

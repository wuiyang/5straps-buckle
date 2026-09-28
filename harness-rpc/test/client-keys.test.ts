import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSigningKey } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCommand, clientDirectory, CLIENT_KEY_FILE, loadClientKey } from '../cli/client.js'
import { keysCommand } from '../cli/keys.js'
import { runCli } from '../cli/main.js'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createFileClientKeys } from '../common/adapters/keys/file-client-keys.js'
import { actionsPath, clientKeysPath, loadConfig, type BuckleConfig } from '../common/runtime/config.js'

// B23, owner ruling H4 of 2026-09-28: the SSH model. A person's device keeps its Ed25519 private key
// owner-only (`buckle client`); the owner enrolls the public half on the node (`buckle keys`), locally.

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-client-keys-'))
  roots.push(root)
  return root
}

function node(): BuckleConfig {
  const root = scratch()
  mkdirSync(join(root, 'workspace'))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  return loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
}

function capture() {
  const output = { stdout: '', stderr: '' }
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.stdout += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output.stderr += String(chunk); return true })
  return output
}

describe('buckle client: the device side', () => {
  it('makes an owner-only key in an owner-only directory, prints only its public half and fingerprint, and keeps it unless told to replace it', async () => {
    const environment = { BUCKLE_CLIENT_DIR: join(scratch(), 'device') }
    const output = capture()
    expect((await clientCommand(['keygen'], environment)).exitCode).toBe(0)
    const file = join(environment.BUCKLE_CLIENT_DIR, CLIENT_KEY_FILE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(environment.BUCKLE_CLIENT_DIR).mode & 0o777).toBe(0o700)
    const key = loadClientKey(environment)
    expect(output.stdout).toContain(key.publicKey)
    expect(output.stdout).toContain(key.keyId)
    expect(output.stdout).not.toContain('PRIVATE KEY')
    const pem = readFileSync(file, 'utf8')
    expect(output.stdout).not.toContain(pem.split('\n')[1]!)

    expect((await clientCommand(['keygen'], environment)).exitCode).toBe(1)
    expect(output.stderr).toContain('pass --force')
    expect(readFileSync(file, 'utf8')).toBe(pem)
    expect((await clientCommand(['keygen', '--force'], environment)).exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).not.toBe(pem)

    output.stdout = ''
    expect((await clientCommand(['key'], environment)).exitCode).toBe(0)
    expect(output.stdout).toContain(loadClientKey(environment).keyId)
  })

  it('refuses a key other users can read, a missing key, and a relative directory', async () => {
    const directory = join(scratch(), 'device')
    const output = capture()
    expect((await clientCommand(['key'], { BUCKLE_CLIENT_DIR: directory })).exitCode).toBe(1)
    expect(output.stderr).toContain('run buckle client keygen first')
    mkdirSync(directory, { mode: 0o700 })
    writeFileSync(join(directory, CLIENT_KEY_FILE), generateSigningKey().privateKeyPem, { mode: 0o644 })
    chmodSync(join(directory, CLIENT_KEY_FILE), 0o644)
    expect((await clientCommand(['key'], { BUCKLE_CLIENT_DIR: directory })).exitCode).toBe(1)
    expect(output.stderr).toContain('chmod 600')
    expect(() => clientDirectory({ BUCKLE_CLIENT_DIR: 'relative/device' })).toThrow('must be an absolute path')
    expect(clientDirectory({})).toMatch(/\.5straps\/client$/)
  })
})

describe('buckle keys: the node side, local only', () => {
  it('enrolls, lists and revokes keys in an owner-only file, audited by fingerprint and never by key', async () => {
    const config = node()
    const device = generateSigningKey()
    const output = capture()
    expect((await runCli({ argv: ['keys', 'enroll', device.publicKey, '--label', 'laptop'], config })).exitCode).toBe(0)
    expect(output.stdout).toContain(`Enrolled ${device.keyId} (laptop)`)
    expect(statSync(clientKeysPath(config)).mode & 0o777).toBe(0o600)
    expect(createFileClientKeys({ filePath: clientKeysPath(config) }).publicKeyFor(device.keyId)).not.toBeNull()
    // Enrolling it again changes nothing.
    expect((await keysCommand({ config, argv: ['enroll', device.publicKey] })).exitCode).toBe(0)
    expect(createFileClientKeys({ filePath: clientKeysPath(config) }).list()).toHaveLength(1)

    output.stdout = ''
    expect((await runCli({ argv: ['keys', 'list', '--json'], config })).exitCode).toBe(0)
    expect(JSON.parse(output.stdout)).toEqual([expect.objectContaining({ keyId: device.keyId, publicKey: device.publicKey, label: 'laptop', revokedAt: null })])

    expect((await runCli({ argv: ['keys', 'revoke', device.keyId], config })).exitCode).toBe(0)
    expect(createFileClientKeys({ filePath: clientKeysPath(config) }).publicKeyFor(device.keyId)).toBeNull()
    expect((await runCli({ argv: ['keys', 'revoke', 'SHA256:nobody'], config })).exitCode).toBe(1)

    const audited = createFileActionLog(actionsPath(config)).read(20).filter(entry => entry.tool === 'cli_keys' && entry.event === 'result')
    expect(audited.map(entry => entry.detail)).toEqual([`enroll ${device.keyId}`, undefined, `revoke ${device.keyId}`, undefined])
    expect(JSON.stringify(createFileActionLog(actionsPath(config)).read(50))).not.toContain(device.publicKey.slice('ed25519:'.length))
  })

  it('refuses what is not an Ed25519 public key, and a key revoked before', async () => {
    const config = node()
    const output = capture()
    expect((await keysCommand({ config, argv: ['enroll', 'ssh-rsa AAAAB3Nza'] })).exitCode).toBe(1)
    expect(output.stderr).toContain('Not an Ed25519 public key')
    const device = generateSigningKey()
    await keysCommand({ config, argv: ['enroll', device.publicKey] })
    await keysCommand({ config, argv: ['revoke', device.keyId] })
    expect((await keysCommand({ config, argv: ['enroll', device.publicKey] })).exitCode).toBe(1)
    expect(output.stderr).toContain('generate a new key')
    expect(existsSync(clientKeysPath(config))).toBe(true)
  })
})

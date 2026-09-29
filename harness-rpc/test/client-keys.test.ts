import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { generateSigningKey } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCommand, clientDirectory, CLIENT_KEY_FILE, loadClientKey } from '../cli/client.js'
import { keysCommand } from '../cli/keys.js'
import { runCli } from '../cli/main.js'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createFileClientKeys } from '../common/adapters/keys/file-client-keys.js'
import { actionsPath, clientKeysPath, loadConfig, nodeKeyPath, requestNoncesPath, type BuckleConfig } from '../common/runtime/config.js'
import { initializeCommon } from '../common/runtime/initialize.js'
import { loadNodeKey } from '../common/adapters/keys/file-node-key.js'

// B23, owner ruling H4 of 2026-09-28: the SSH model. A person's device keeps its Ed25519 private key
// owner-only (`buckle client`); the owner enrolls the public half on the node (`buckle keys`), locally.

const SETUP_ON_DEFAULT = { purpose: 'buckle-setup', workspace: 'default', registry: false } as const

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
    expect((await runCli({ argv: ['keys', 'enroll', device.publicKey, '--label', 'laptop', '--purpose', 'both', '--workspace', 'node'], config })).exitCode).toBe(0)
    expect(output.stdout).toContain(`Enrolled ${device.keyId} (laptop) for setup and approval on the whole node`)
    expect(statSync(clientKeysPath(config)).mode & 0o777).toBe(0o600)
    expect(createFileClientKeys({ filePath: clientKeysPath(config) }).publicKeyFor(device.keyId, SETUP_ON_DEFAULT)).toHaveProperty('key')
    // Enrolling it again with the same scope changes nothing; with another scope it is refused.
    expect((await keysCommand({ config, argv: ['enroll', device.publicKey, '--purpose', 'both', '--workspace', 'node'] })).exitCode).toBe(0)
    expect((await keysCommand({ config, argv: ['enroll', device.publicKey, '--purpose', 'approval', '--workspace', 'node'] })).exitCode).toBe(1)
    expect(output.stderr).toContain('a scope is fixed at enrollment')
    expect(createFileClientKeys({ filePath: clientKeysPath(config) }).list()).toHaveLength(1)

    output.stdout = ''
    expect((await runCli({ argv: ['keys', 'list', '--json'], config })).exitCode).toBe(0)
    expect(JSON.parse(output.stdout)).toEqual([expect.objectContaining({ keyId: device.keyId, publicKey: device.publicKey, label: 'laptop', purpose: 'both', workspace: 'node', revokedAt: null })])
    output.stdout = ''
    expect((await runCli({ argv: ['keys', 'list'], config })).exitCode).toBe(0)
    expect(output.stdout).toContain(`${device.keyId}  setup and approval on the whole node  enrolled`)

    expect((await runCli({ argv: ['keys', 'revoke', device.keyId], config })).exitCode).toBe(0)
    expect(createFileClientKeys({ filePath: clientKeysPath(config) }).publicKeyFor(device.keyId, SETUP_ON_DEFAULT)).toEqual({ refused: 'unknown_key' })
    expect((await runCli({ argv: ['keys', 'revoke', 'SHA256:nobody'], config })).exitCode).toBe(1)

    const audited = createFileActionLog(actionsPath(config)).read(20).filter(entry => entry.tool === 'cli_keys' && entry.event === 'result')
    expect(audited.map(entry => entry.detail)).toEqual([`enroll ${device.keyId} both node`, undefined, undefined, `revoke ${device.keyId}`, undefined])
    expect(JSON.stringify(createFileActionLog(actionsPath(config)).read(50))).not.toContain(device.publicKey.slice('ed25519:'.length))
  })

  it('refuses what is not an Ed25519 public key, and a key revoked before', async () => {
    const config = node()
    const output = capture()
    expect((await keysCommand({ config, argv: ['enroll', 'ssh-rsa AAAAB3Nza', '--purpose', 'setup', '--workspace', 'node'] })).exitCode).toBe(1)
    expect(output.stderr).toContain('Not an Ed25519 public key')
    const device = generateSigningKey()
    // Both parts of the scope are named at enrollment (owner decision D10).
    expect((await keysCommand({ config, argv: ['enroll', device.publicKey] })).exitCode).toBe(1)
    expect(output.stderr).toContain('--purpose takes setup, approval or both')
    expect((await keysCommand({ config, argv: ['enroll', device.publicKey, '--purpose', 'setup'] })).exitCode).toBe(1)
    expect(output.stderr).toContain('--workspace takes a workspace id, or node')
    expect((await keysCommand({ config, argv: ['enroll', device.publicKey, '--purpose', 'setup', '--workspace', 'Not A Workspace'] })).exitCode).toBe(1)
    await keysCommand({ config, argv: ['enroll', device.publicKey, '--purpose', 'setup', '--workspace', 'node'] })
    await keysCommand({ config, argv: ['revoke', device.keyId] })
    expect((await keysCommand({ config, argv: ['enroll', device.publicKey, '--purpose', 'setup', '--workspace', 'node'] })).exitCode).toBe(1)
    expect(output.stderr).toContain('generate a new key')
    expect(existsSync(clientKeysPath(config))).toBe(true)
  })
})

describe('a key\'s scope (owner decision D10)', () => {
  it('covers its purpose and its workspace only, and the registry only from the whole node', async () => {
    const config = node()
    capture()
    const keys = createFileClientKeys({ filePath: clientKeysPath(config) })
    const enrolled = {
      setupOnA: generateSigningKey(), approvalOnB: generateSigningKey(), bothOnC: generateSigningKey(), setupOnNode: generateSigningKey(), approvalOnNode: generateSigningKey(),
    }
    await keys.enroll({ publicKey: enrolled.setupOnA.publicKey, label: '', purpose: 'setup', workspace: 'child-a' })
    await keys.enroll({ publicKey: enrolled.approvalOnB.publicKey, label: '', purpose: 'approval', workspace: 'child-b' })
    await keys.enroll({ publicKey: enrolled.bothOnC.publicKey, label: '', purpose: 'both', workspace: 'child-c' })
    await keys.enroll({ publicKey: enrolled.setupOnNode.publicKey, label: '', purpose: 'setup', workspace: 'node' })
    await keys.enroll({ publicKey: enrolled.approvalOnNode.publicKey, label: '', purpose: 'approval', workspace: 'node' })
    const verdict = (key: { keyId: string }, purpose: 'buckle-setup' | 'buckle-approval', workspace: string, registry = false) => ('key' in keys.publicKeyFor(key.keyId, { purpose, workspace, registry }) ? 'ok' : 'out_of_scope')
    const rows: Array<[{ keyId: string }, 'buckle-setup' | 'buckle-approval', string, boolean, string]> = [
      [enrolled.setupOnA, 'buckle-setup', 'child-a', false, 'ok'],
      [enrolled.setupOnA, 'buckle-setup', 'child-b', false, 'out_of_scope'],
      [enrolled.setupOnA, 'buckle-approval', 'child-a', false, 'out_of_scope'],
      [enrolled.approvalOnB, 'buckle-approval', 'child-b', false, 'ok'],
      [enrolled.approvalOnB, 'buckle-approval', 'child-c', false, 'out_of_scope'],
      [enrolled.approvalOnB, 'buckle-setup', 'child-b', false, 'out_of_scope'],
      [enrolled.bothOnC, 'buckle-setup', 'child-c', false, 'ok'],
      [enrolled.bothOnC, 'buckle-approval', 'child-c', false, 'ok'],
      [enrolled.bothOnC, 'buckle-setup', 'child-a', false, 'out_of_scope'],
      [enrolled.setupOnNode, 'buckle-setup', 'child-b', false, 'ok'],
      [enrolled.setupOnNode, 'buckle-setup', 'default', true, 'ok'],
      [enrolled.setupOnNode, 'buckle-approval', 'default', false, 'out_of_scope'],
      [enrolled.approvalOnNode, 'buckle-approval', 'child-a', false, 'ok'],
      [enrolled.approvalOnNode, 'buckle-setup', 'default', true, 'out_of_scope'],
    ]
    for (const [key, purpose, workspace, registry, expected] of rows) expect({ key: key.keyId, purpose, workspace, registry, verdict: verdict(key, purpose, workspace, registry) }).toEqual({ key: key.keyId, purpose, workspace, registry, verdict: expected })
    // A key on the default workspace alone never changes the registry.
    const onDefault = generateSigningKey()
    await keys.enroll({ publicKey: onDefault.publicKey, label: '', purpose: 'setup', workspace: 'default' })
    expect(verdict(onDefault, 'buckle-setup', 'default')).toBe('ok')
    expect(verdict(onDefault, 'buckle-setup', 'default', true)).toBe('out_of_scope')
  })
})

describe('a small-order key (review L3 of B23-B25)', () => {
  const identity = `ed25519:${Buffer.from('01'.padEnd(64, '0'), 'hex').toString('base64url')}`
  const orderEight = `ed25519:${Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex').toString('base64url')}`

  it('is never enrolled, and never pinned as a node key', async () => {
    const config = node()
    const output = capture()
    for (const key of [identity, orderEight]) {
      expect((await keysCommand({ config, argv: ['enroll', key, '--purpose', 'both', '--workspace', 'node'] })).exitCode).toBe(1)
      expect(output.stderr).toContain('A small-order Ed25519 public key proves nothing')
      expect((await clientCommand(['trust', 'http://127.0.0.1:4320', 'node-1', key], { BUCKLE_CLIENT_DIR: join(scratch(), 'device') })).exitCode).toBe(1)
      expect(output.stderr).toContain('Not pinned: A small-order Ed25519 public key proves nothing')
    }
    expect(createFileClientKeys({ filePath: clientKeysPath(config) }).list()).toEqual([])
  })
})

describe('the node\'s own key and the admin-only state (review L11 of B23-B25)', () => {
  it('is made only where the admin HTTP layer runs: never by a CLI command, MCP, or a serve with the flag off', async () => {
    for (const [role, flag, made] of [['cli', 'true', false], ['mcp', 'true', false], ['server', 'false', false], ['server', 'true', true]] as const) {
      const root = scratch()
      mkdirSync(join(root, 'workspace'))
      mkdirSync(join(root, 'state'), { mode: 0o700 })
      const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_EXPERIMENTAL_ADMIN_HTTP: flag })
      const common = initializeCommon({ config, role })
      await common.start()
      try {
        for (const file of [nodeKeyPath(config), requestNoncesPath(config)]) expect({ role, flag, file: basename(file), exists: existsSync(file) }).toEqual({ role, flag, file: basename(file), exists: made })
      } finally { await common.owner.close() }
    }
  })

  it('writes the key whole or not at all, keeps a key another process made first, and names the file when it holds no key', () => {
    const root = scratch()
    const file = join(root, 'node-signing-key.pem')
    const first = loadNodeKey(file)
    expect(loadNodeKey(file).keyId).toBe(first.keyId)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(root)).toEqual(['node-signing-key.pem'])
    writeFileSync(file, '', { mode: 0o600 })
    expect(() => loadNodeKey(file)).toThrow(`${file} does not hold this node's Ed25519 signing key`)
  })
})

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

/**
 * Drives a real `buckle mcp` process over stdio on protocol revision 2026-07-28 and checks which
 * branch a gated call takes: a client declaring elicitation must be asked, and a client declaring
 * none must get the relay text. The gate is a read of /etc/hostname, which sits outside the
 * workspace, so read_scope always asks for it.
 */
const server = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main.js')
const GATED_PATH = '/etc/hostname'

const runs = [
  { name: 'client declaring elicitation', capabilities: { elicitation: {} }, check: expectElicited },
  { name: 'client declaring no elicitation', capabilities: {}, check: expectRelayText },
]

let failed = false
for (const run of runs) {
  try {
    await probe(run)
    console.log(`PASS ${run.name}`)
  } catch (error) {
    failed = true
    console.log(`FAIL ${run.name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
process.exit(failed ? 1 : 0)

async function probe(run) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-mcp-probe-'))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const state = join(root, 'state'); mkdirSync(state, { mode: 0o700 })

  const elicitations = []
  const client = new Client({ name: 'buckle-mcp-probe', version: '0.0.0' }, {
    capabilities: run.capabilities,
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  })
  if (run.capabilities.elicitation) {
    client.setRequestHandler('elicitation/create', request => {
      elicitations.push(request)
      return { action: 'accept', content: { approve: true, scope: 'once' } }
    })
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server, 'mcp'],
    cwd: workspace,
    stderr: 'ignore',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? root,
      BUCKLE_WORKSPACE_ROOT: workspace,
      BUCKLE_STATE_DIR: state,
      BUCKLE_PACKS: 'fs',
      // One millisecond answers a gated call at once instead of holding it for a person (0 would wait until answered).
      BUCKLE_APPROVAL_TIMEOUT_MS: '1',
    },
  })

  try {
    await client.connect(transport)
    const result = await client.callTool({ name: 'fs_read', arguments: { path: GATED_PATH } })
    run.check({ result, elicitations })
  } finally {
    await client.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
}

function expectElicited({ result, elicitations }) {
  if (elicitations.length === 0) throw new Error(`no elicitation was requested; the call answered ${describe(result)}`)
  if (result.isError) throw new Error(`the elicited approval still refused the call: ${describe(result)}`)
  if (!text(result).includes('/etc/hostname')) throw new Error(`the approved read returned no file content: ${describe(result)}`)
}

function expectRelayText({ result, elicitations }) {
  if (elicitations.length > 0) throw new Error('an elicitation was requested from a client that declared none')
  if (!result.isError) throw new Error(`expected the relay text, got ${describe(result)}`)
  if (!text(result).includes('buckle approve')) throw new Error(`the refusal is not the relay text: ${describe(result)}`)
}

function text(result) {
  return (result.content ?? []).map(block => block.text ?? '').join('\n')
}

function describe(result) {
  return JSON.stringify(result).slice(0, 400)
}

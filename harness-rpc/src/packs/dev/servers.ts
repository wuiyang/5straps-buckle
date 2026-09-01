export interface KnownServer {
  id: string
  /** Process names matched against `ps` output. */
  binaries: string[]
  languages: string[]
  /** Args used when spawning a twin of a server already running on this machine. */
  spawnArgs: string[]
}

export const KNOWN_SERVERS: KnownServer[] = [
  { id: 'typescript', binaries: ['typescript-language-server', 'tsserver'], languages: ['typescript', 'javascript'], spawnArgs: ['--stdio'] },
  { id: 'rust', binaries: ['rust-analyzer'], languages: ['rust'], spawnArgs: [] },
  { id: 'go', binaries: ['gopls'], languages: ['go'], spawnArgs: ['serve'] },
  { id: 'python', binaries: ['pyright-langserver', 'pylsp'], languages: ['python'], spawnArgs: ['--stdio'] },
  { id: 'c-family', binaries: ['clangd'], languages: ['c', 'cpp'], spawnArgs: [] },
  { id: 'lua', binaries: ['lua-language-server'], languages: ['lua'], spawnArgs: [] },
]

export function serverForLanguage(language: string): KnownServer | null {
  return KNOWN_SERVERS.find(server => server.languages.includes(language)) ?? null
}

export function knownServerForCommand(commandLine: string): KnownServer | null {
  return KNOWN_SERVERS.find(server => server.binaries.some(binary => matchesBinary(commandLine, binary))) ?? null
}

function matchesBinary(commandLine: string, binary: string): boolean {
  return new RegExp(`(^|[\\s/\\\\])${escapeRegExp(binary)}(\\s|$)`).test(commandLine)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

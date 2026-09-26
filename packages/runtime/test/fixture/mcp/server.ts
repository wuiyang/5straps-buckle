import { McpServer } from '@modelcontextprotocol/server'
import type { FixtureServices } from '../common/types.js'

export interface McpDependencies {
  services: FixtureServices
  version: string
}

// Framework-free: the HTTP route and the stdio entry both build servers from this factory.
export function createFixtureMcpServer(deps: McpDependencies): McpServer {
  const server = new McpServer({ name: 'runtime-fixture', version: deps.version })
  server.registerTool('list_notes', { description: 'List every note' }, async () => {
    const notes = await (await deps.services.getNotes()).list()
    return { content: [{ type: 'text', text: JSON.stringify(notes) }] }
  })
  return server
}

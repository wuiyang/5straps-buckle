import { readFileSync } from 'node:fs'
import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server'

export interface RecordedRequest {
  method: 'POST'
  headers: Record<string, string>
  body: { method: string; params: { _meta?: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>
}

interface ClaudeCodeRecord {
  modern: { discover: RecordedRequest; listen: RecordedRequest; toolsList: RecordedRequest }
}

/** What Claude Code's HTTP MCP client sent a probe server, for each revision it speaks (fixtures/claude-code-http-mcp.json). */
export const CLAUDE_CODE_HTTP_MCP = JSON.parse(readFileSync(new URL('../fixtures/claude-code-http-mcp.json', import.meta.url), 'utf8')) as ClaudeCodeRecord

export const CLAUDE_CODE_CAPABILITIES = CLAUDE_CODE_HTTP_MCP.modern.discover.body.params._meta?.[CLIENT_CAPABILITIES_META_KEY]

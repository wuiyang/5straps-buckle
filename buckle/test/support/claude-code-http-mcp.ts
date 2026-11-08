import { readFileSync } from 'node:fs'
import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server'
import { z } from 'zod'

const RecordedRequestSchema = z.object({
  method: z.literal('POST'),
  headers: z.record(z.string(), z.string()),
  body: z.looseObject({ method: z.string(), params: z.looseObject({ _meta: z.record(z.string(), z.unknown()).optional() }) }),
})

const ClaudeCodeRecordSchema = z.object({
  modern: z.object({ discover: RecordedRequestSchema, listen: RecordedRequestSchema, toolsList: RecordedRequestSchema }),
})

export type RecordedRequest = z.infer<typeof RecordedRequestSchema>

/** What Claude Code's HTTP MCP client sent a probe server, for each revision it speaks (fixtures/claude-code-http-mcp.json). */
export const CLAUDE_CODE_HTTP_MCP = ClaudeCodeRecordSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/claude-code-http-mcp.json', import.meta.url), 'utf8')))

export const CLAUDE_CODE_CAPABILITIES = CLAUDE_CODE_HTTP_MCP.modern.discover.body.params._meta?.[CLIENT_CAPABILITIES_META_KEY]

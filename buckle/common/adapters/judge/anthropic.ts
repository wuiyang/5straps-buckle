import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Judge } from '../../types/ports/judge.js'
import { JUDGE_MAX_RETRIES, JUDGE_MAX_TOKENS, JUDGE_SYSTEM_PROMPT, JUDGE_TIMEOUT_MS, judgePrompt, unavailable, verdictOf, VerdictSchema } from './verdict.js'

/** Where the Anthropic judge is asked: Anthropic's API, never a URL the environment or a setting names (D91). */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com'

/**
 * The decision AI over Anthropic's API, with the node's own key and nothing the environment holds: no
 * ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS, ANTHROPIC_LOG, or telemetry
 * setting reaches the request. One request per rating, retried once, with no tools and no fallback model. Every way it
 * can fail is an unavailable rating whose reason names no path and no key, so the call asks as before. `fetch` is for tests.
 */
export function createAnthropicJudge(options: { apiKey: string; fetch?: typeof fetch }): Judge {
  const client = createAnthropicClient(options)
  return {
    async judge(input, { model, signal }) {
      const { user, digest } = judgePrompt(input, model)
      const startedAt = performance.now()
      let response
      try {
        response = await client.messages.parse({
          model,
          max_tokens: JUDGE_MAX_TOKENS,
          system: [{ type: 'text', text: JUDGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: user }],
          output_config: { effort: 'medium', format: zodOutputFormat(VerdictSchema) },
        }, signal ? { signal } : undefined)
      } catch (error) {
        return unavailable(failureOf(error))
      }
      if (response.stop_reason === 'refusal') return unavailable('the model declined to rate the command')
      if (response.stop_reason === 'max_tokens') return unavailable('the answer ran past its length limit')
      return verdictOf({ parsed: response.parsed_output, asked: input, model, startedAt, digest })
    },
  }
}

/** The client an Anthropic judge asks through, built from the options it is given alone. Exported so a test reads its settings. */
export function createAnthropicClient(options: { apiKey: string; fetch?: typeof fetch }): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    authToken: null,
    webhookKey: null,
    baseURL: ANTHROPIC_API_URL,
    timeout: JUDGE_TIMEOUT_MS,
    maxRetries: JUDGE_MAX_RETRIES,
    logLevel: 'off',
    openTelemetry: false,
    defaultHeaders: withoutEnvironmentHeaders({ custom: process.env.ANTHROPIC_CUSTOM_HEADERS, apiKey: options.apiKey }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
}

/**
 * The SDK sets the headers ANTHROPIC_CUSTOM_HEADERS names over its own, its key header among them: each is named here
 * with no value, which takes it out again, and the key header with the node's key, so the node's key and nothing the
 * environment sets reaches the request.
 */
function withoutEnvironmentHeaders(input: { custom: string | undefined; apiKey: string }): Record<string, string | null> {
  const names = (input.custom ?? '').split('\n').flatMap(line => (line.includes(':') ? [line.slice(0, line.indexOf(':')).trim()] : [])).filter(Boolean)
  return Object.fromEntries(names.map(name => [name, name.toLowerCase() === 'x-api-key' ? input.apiKey : null]))
}

/** Why a request failed, in Buckle's words: the SDK's own message can quote the server's answer, so it is never passed on. */
function failureOf(error: unknown): string {
  if (error instanceof Anthropic.APIUserAbortError) return 'the call was cancelled while the judge rated it'
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'the request timed out'
  if (error instanceof Anthropic.APIConnectionError) return 'the network failed'
  if (error instanceof Anthropic.APIError) return error.status === undefined ? 'the API answered with an error' : `the API answered HTTP ${error.status}`
  if (error instanceof Anthropic.AnthropicError) return 'the answer held no verdict'
  return 'the request failed'
}

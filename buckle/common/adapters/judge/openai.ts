import OpenAI from 'openai'
import { ContentFilterFinishReasonError, LengthFinishReasonError } from 'openai/core/error'
import { ZodError } from 'zod'
import { zodResponseFormat } from 'openai/helpers/zod'
import type { Judge } from '../../types/ports/judge.js'
import { JUDGE_MAX_RETRIES, JUDGE_MAX_TOKENS, JUDGE_SYSTEM_PROMPT, JUDGE_TIMEOUT_MS, judgePrompt, unavailable, verdictOf, VerdictSchema } from './verdict.js'

/** Where the OpenAI judge is asked when the node names no base URL of its own. */
export const OPENAI_API_URL = 'https://api.openai.com/v1'

/**
 * The decision AI over OpenAI's API, or any endpoint that speaks it (a gateway, a local model), with the node's own key
 * and base URL and nothing the environment holds: no OPENAI_API_KEY, OPENAI_ADMIN_KEY, OPENAI_BASE_URL, OPENAI_ORG_ID,
 * OPENAI_PROJECT_ID, OPENAI_CUSTOM_HEADERS, or OPENAI_LOG reaches the request. Chat completions with a strict JSON schema answer, one request per rating, retried
 * once, with no tools. Every way it can fail is an unavailable rating whose reason names no path and no key, so the call
 * asks as before. `fetch` is for tests.
 */
export function createOpenAiJudge(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }): Judge {
  const client = createOpenAiClient(options)
  return {
    async judge(input, { model, signal }) {
      const { user, digest } = judgePrompt(input, model)
      const startedAt = performance.now()
      let completion
      try {
        completion = await client.chat.completions.parse({
          model,
          max_completion_tokens: JUDGE_MAX_TOKENS,
          messages: [{ role: 'system', content: JUDGE_SYSTEM_PROMPT }, { role: 'user', content: user }],
          response_format: zodResponseFormat(VerdictSchema, 'verdict'),
        }, signal ? { signal } : undefined)
      } catch (error) {
        return unavailable(failureOf(error))
      }
      const choice = completion.choices[0]
      if (!choice) return unavailable('the answer held no verdict')
      if (choice.message.refusal) return unavailable('the model declined to rate the command')
      return verdictOf({ parsed: choice.message.parsed, asked: input, model, startedAt, digest })
    },
  }
}

/** The client an OpenAI judge asks through, built from the options it is given alone. Exported so a test reads its settings. */
export function createOpenAiClient(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: options.baseUrl ?? OPENAI_API_URL,
    timeout: JUDGE_TIMEOUT_MS,
    maxRetries: JUDGE_MAX_RETRIES,
    logLevel: 'off',
    defaultHeaders: withoutEnvironmentHeaders({ custom: process.env.OPENAI_CUSTOM_HEADERS, apiKey: options.apiKey }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
}

/**
 * The SDK sets the headers OPENAI_CUSTOM_HEADERS names over its own, its Authorization among them: each is named here
 * with no value, which takes it out again, and Authorization with the node's key, so nothing the environment sets
 * reaches the request.
 */
function withoutEnvironmentHeaders(input: { custom: string | undefined; apiKey: string }): Record<string, string | null> {
  const names = (input.custom ?? '').split('\n').flatMap(line => (line.includes(':') ? [line.slice(0, line.indexOf(':')).trim()] : [])).filter(Boolean)
  return Object.fromEntries(names.map(name => [name, name.toLowerCase() === 'authorization' ? `Bearer ${input.apiKey}` : null]))
}

/** Why a request failed, in Buckle's words: the SDK's own message can quote the server's answer, so it is never passed on. */
function failureOf(error: unknown): string {
  if (error instanceof OpenAI.APIUserAbortError) return 'the call was cancelled while the judge rated it'
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'the request timed out'
  if (error instanceof OpenAI.APIConnectionError) return 'the network failed'
  if (error instanceof OpenAI.APIError) return error.status === undefined ? 'the API answered with an error' : `the API answered HTTP ${error.status}`
  if (error instanceof LengthFinishReasonError) return 'the answer ran past its length limit'
  if (error instanceof ContentFilterFinishReasonError) return 'the model declined to rate the command'
  // The SDK parses the answer itself, so an answer that is no JSON, or no verdict, throws here.
  if (error instanceof OpenAI.OpenAIError || error instanceof SyntaxError || error instanceof ZodError) return 'the answer held no verdict'
  return 'the request failed'
}

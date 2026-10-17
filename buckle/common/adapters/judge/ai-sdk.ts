import { APICallError, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, RetryError, type LanguageModel } from 'ai'
import type { Judge, JudgeInput, JudgeOptions, JudgeResult } from '../../types/ports/judge.js'
import { JUDGE_MAX_RETRIES, JUDGE_SYSTEM_PROMPT, JUDGE_TIMEOUT_MS, judgePrompt, unavailable, verdictOf, VerdictSchema } from './verdict.js'

/**
 * A model object a provider builds for a model id (providers/). Never a bare name: the AI SDK sends a name to Vercel's
 * gateway with a key from the process environment, so only an object built from the node's own settings is taken.
 */
export type ProviderModel = Exclude<LanguageModel, string>

/**
 * The decision AI through the Vercel AI SDK (D91, addendum 2 A), the one module that imports `ai`: the provider's model
 * object, the fixed instructions, the input as one JSON user turn, and a structured answer in VerdictSchema's shape, one
 * request per rating, retried once, with no tools. The whole rating, its retry included, has JUDGE_TIMEOUT_MS. Every way
 * it can fail is an unavailable rating whose reason names no path and no key, so the call asks as before. Swapping the
 * SDK or a provider touches this file and providers/ alone, never the port.
 */
export function createAiSdkJudge(input: { model: (modelId: string) => ProviderModel; timeoutMs?: number }): Judge {
  async function rate(asked: JudgeInput, { model, signal }: JudgeOptions): Promise<JudgeResult> {
    const { user, digest } = judgePrompt(asked, model)
    const startedAt = performance.now()
    const timeout = AbortSignal.timeout(input.timeoutMs ?? JUDGE_TIMEOUT_MS)
    try {
      const result = await generateText({
        model: input.model(model),
        instructions: JUDGE_SYSTEM_PROMPT,
        prompt: user,
        output: Output.object({ schema: VerdictSchema, name: 'verdict' }),
        abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        maxRetries: JUDGE_MAX_RETRIES,
      })
      if (result.finishReason === 'content-filter') return unavailable('the model declined to rate the command')
      return verdictOf({ parsed: result.output, asked, model, startedAt, digest })
    } catch (error) {
      if (signal?.aborted) return unavailable('the call was cancelled while the judge rated it')
      if (timeout.aborted) return unavailable('the request timed out')
      return unavailable(failureOf(error))
    }
  }
  return {
    async judge(asked, options) {
      // The last resort: whatever throws, even reading an answer, the rating is unavailable and the call asks as before.
      try { return await rate(asked, options) } catch { return unavailable('the request failed') }
    },
  }
}

/** Why a request failed, in Buckle's words: the SDK's own message can quote the server's answer, so it is never passed on. */
function failureOf(error: unknown): string {
  const cause = RetryError.isInstance(error) ? error.lastError : error
  if (APICallError.isInstance(cause)) return cause.statusCode === undefined ? 'the network failed' : `the API answered HTTP ${cause.statusCode}`
  if (NoObjectGeneratedError.isInstance(cause)) {
    if (cause.finishReason === 'length') return 'the answer ran past its length limit'
    if (cause.finishReason === 'content-filter') return 'the model declined to rate the command'
    return 'the answer held no verdict'
  }
  if (NoOutputGeneratedError.isInstance(cause)) return 'the answer held no verdict'
  return 'the request failed'
}

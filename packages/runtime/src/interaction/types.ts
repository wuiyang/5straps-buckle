export type CliWait = { mode: 'finite'; timeoutMs: number } | { mode: 'indefinite' }

// Framework-independent request envelope; carries everything a queued prompt needs explicitly.
export interface CliRequest {
  id: string
  kind: string
  correlationId: string
  actor?: string
  sessionId?: string
  target?: string
  action: { summary: string; details?: Readonly<Record<string, string | number | boolean>> }
  wait: CliWait
}

export interface CliAnswer {
  choice: string
  note?: string
}

export type UnavailableReason = 'no_consumer' | 'consumer_detached' | 'closed' | 'no_listener'
export interface PendingInteraction {
  id: string
  instructions: string
}

export type CliOutcome =
  | { status: 'answered'; requestId: string; answer: CliAnswer }
  | { status: 'denied'; requestId: string; reason?: string }
  | { status: 'timed_out'; requestId: string; waitedMs: number }
  | { status: 'cancelled'; requestId: string; reason: string }
  | { status: 'unavailable'; requestId: string; reason: UnavailableReason; pending?: PendingInteraction }

export type CliConsumerResult = { status: 'answered'; answer: CliAnswer } | { status: 'denied'; reason?: string }

// The single interactive terminal. It must stop prompting when the signal aborts.
export interface CliConsumer {
  prompt(request: CliRequest, options: { signal: AbortSignal }): Promise<CliConsumerResult>
}

export type RequestCli = (request: CliRequest, options?: { signal?: AbortSignal }) => Promise<CliOutcome>

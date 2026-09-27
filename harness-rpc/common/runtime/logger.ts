export interface LogContext {
  [key: string]: boolean | number | string | null | undefined
}

function write(level: 'error' | 'info' | 'warn', message: string, context?: LogContext): void {
  const entry = JSON.stringify({
    level,
    message,
    ...(context ? { context } : {}),
    timestamp: new Date().toISOString(),
  })
  process.stderr.write(`${entry}\n`)
}

export const logger = {
  error: (message: string, context?: LogContext) => write('error', message, context),
  info: (message: string, context?: LogContext) => write('info', message, context),
  warn: (message: string, context?: LogContext) => write('warn', message, context),
}

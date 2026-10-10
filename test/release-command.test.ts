import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scratchDirectory } from './support/release-repository'

const command = pathToFileURL(join(import.meta.dirname, '../scripts/release/command.mjs')).href
function execute(body: string) {
  const script = join(scratchDirectory('release-command-'), 'main.mjs')
  writeFileSync(script, `import { Refusal, runAsScript } from ${JSON.stringify(command)}; await runAsScript(import.meta.url, ${body})`)
  return spawnSync(process.execPath, [script], { encoding: 'utf8' })
}

describe('release script entry point', () => {
  it.each(['() => "sync result"', 'async () => "async result"'])('prints the result of %s', main => {
    const result = execute(main)
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^(?:sync|async) result\n$/)
    expect(result.stderr).toBe('')
  })

  it.each(['() => { throw new Refusal("stop release") }', 'async () => { throw new Refusal("stop release") }'])('catches a refusal from %s', main => {
    const result = execute(main)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('stop release\n')
  })

  it('fails with the original stack for an unexpected async error', () => {
    const result = execute('async () => { throw new Error("unexpected failure") }')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Error: unexpected failure')
    expect(result.stderr).toContain('main.mjs:')
  })
})

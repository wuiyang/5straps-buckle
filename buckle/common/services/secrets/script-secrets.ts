import type { JsonValue } from '@5straps/protocol'
import { ToolInputError, type FilledSecret } from '../../domain/tool.js'
import { createMasker, type Masker } from '../../domain/secret-mask.js'
import { holdMasker } from '../../runtime/held-secrets.js'
import { digestOf } from './call-secrets.js'
import { readSecretValues } from './secret-file.js'

/** One value a script's call resolved from a reference: its file as the rules judged it and as written, and its NAME. */
export interface ResolvedSecret {
  real: string
  written: string
  name: string
  value: string
}

/**
 * The values a code_run script's calls resolved from references, which mask every later call the script makes, before
 * the script, its replay record, the audit log, or the call's own log line sees it, and the script's own result
 * (docs/user/how-to/secrets-02.md). A call with no reference of its own, such as an fs_read of a file a page saved a filled value
 * to, is masked by them too. The script's text is never read for them: only a call that resolves a value adds it.
 */
export interface ScriptSecrets {
  /** The values one of the script's calls resolved, added just before its tool runs. */
  add(values: readonly ResolvedSecret[]): void
  /** Every string of a value masked by every value added so far; the value itself where none was. */
  json<T extends JsonValue | object>(value: T): T
  /**
   * What the script's replay record keeps, so a resumed run masks as this one did: each value's file, NAME, and sha256,
   * never the value.
   */
  records(): FilledSecret[]
  /**
   * Reads again the values a run before this one resolved, from its record, before the resumed script starts. One that
   * can no longer be read, or reads as another value, refuses: a file a call saved it to could not be masked.
   */
  restore(records: readonly FilledSecret[]): void
  /** Forgets the values once the script's call has answered. */
  drop(): void
}

export function createScriptSecrets(input: { protectedRoots: readonly string[]; roots: readonly string[] }): ScriptSecrets {
  // By file, NAME, and digest: a file that changed while the script ran leaves both its values masked.
  const held = new Map<string, { record: FilledSecret; value: string }>()
  let masker: Masker | null = null
  let release: (() => void) | null = null
  const current = (): Masker => masker ??= createMasker([...held.values()].map(({ record, value }) => ({ name: record.name, value })))
  // Held from the first value to the script's answer, so a log line or an audit entry any part of Buckle writes
  // meanwhile is masked as the script's calls are.
  const shared: Masker = {
    text: text => held.size === 0 ? text : current().text(text),
    json: value => held.size === 0 ? value : current().json(value),
    drop: () => {},
  }
  const keep = (record: FilledSecret, value: string): void => {
    const key = `${record.real}\u0000${record.name}\u0000${record.digest}`
    if (held.has(key)) return
    held.set(key, { record, value })
    masker?.drop()
    masker = null
    release ??= holdMasker(shared)
  }
  return {
    add(values) {
      for (const { real, written, name, value } of values) keep({ real, written, name, digest: digestOf(value) }, value)
    },
    json: value => shared.json(value),
    records: () => [...held.values()].map(({ record }) => record),
    restore(records) {
      const byFile = new Map<string, { written: string; names: Set<string> }>()
      for (const record of records) {
        const file = byFile.get(record.real) ?? { written: record.written, names: new Set<string>() }
        file.names.add(record.name)
        byFile.set(record.real, file)
      }
      const read = new Map<string, Map<string, string>>()
      try {
        for (const [real, file] of byFile) {
          try { read.set(real, readSecretValues({ real, written: file.written, names: [...file.names], protectedRoots: input.protectedRoots, roots: input.roots })) } catch (error) {
            throw stale(`${[...file.names].join(', ')} in ${file.written}`, (error as Error).message)
          }
        }
        for (const record of records) {
          const value = read.get(record.real)?.get(record.name)
          if (value === undefined || digestOf(value) !== record.digest) throw stale(`${record.name} in ${record.written}`, 'it changed since')
          keep(record, value)
        }
      } finally {
        for (const values of read.values()) values.clear()
      }
    },
    drop() {
      release?.()
      release = null
      masker?.drop()
      masker = null
      held.clear()
    },
  }
}

/** The refusal of a resumed script whose earlier value no longer reads as it did, naming the file and NAME, never a value. */
function stale(named: string, why: string): ToolInputError {
  return new ToolInputError(`This script stopped earlier after its calls used the secret ${named}, which can no longer be read as it was (${why}), so its later calls could not be masked and nothing ran. Put the file back, or change the script, even by a comment, to run it from its start`, { code: 'PERMISSION_DENIED' })
}

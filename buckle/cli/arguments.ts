import type { JsonObject, JsonValue, ToolCapability } from '@5straps/protocol'

interface SchemaProperty {
  type?: string
  items?: { type?: string }
  enum?: JsonValue[]
}

/** `fs_read_batch` is driven as `buckle fs read-batch`. */
export function toolNameToCommand(toolName: string): { group: string; verb: string } {
  const separator = toolName.indexOf('_')
  if (separator === -1) return { group: toolName, verb: '' }
  return { group: toolName.slice(0, separator), verb: toolName.slice(separator + 1).replaceAll('_', '-') }
}

export function commandToToolName(group: string, verb: string): string {
  return verb ? `${group}_${verb.replaceAll('-', '_')}` : group
}

/**
 * parseArgs needs to know which flags take a value; without this every `--limit 3` is read
 * as a boolean flag followed by a stray positional.
 */
export function parseArgsOptions(capability: ToolCapability): Record<string, { type: 'boolean' | 'string'; multiple?: boolean }> {
  const options: Record<string, { type: 'boolean' | 'string'; multiple?: boolean }> = {}
  for (const [field, property] of Object.entries(readProperties(capability))) {
    options[toFlagName(field)] = property.type === 'boolean'
      ? { type: 'boolean' }
      : { type: 'string', multiple: property.type === 'array' }
  }
  return options
}

function toFlagName(field: string): string {
  return field.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

/**
 * Builds tool arguments from a command line. Positionals fill required fields in schema order,
 * an array-typed field absorbs every positional left at that point, and flags fill named fields.
 * Values are coerced to the type the schema declares.
 *
 * The absorbing step is what makes `buckle shell exec -- pnpm build` pass `build` through as an
 * argument. Leftovers throw rather than being dropped, so a mistyped command never runs a
 * shorter one than the caller wrote.
 */
export function buildToolArgs(input: {
  capability: ToolCapability
  positionals: string[]
  flags: Record<string, string | boolean | string[]>
}): JsonObject {
  const properties = readProperties(input.capability)
  const args: JsonObject = {}
  const remaining = [...input.positionals]

  for (const field of positionalFields(input.capability)) {
    if (remaining.length === 0) break
    const property = properties[field]
    if (property?.type === 'array') {
      args[field] = remaining.splice(0).map(item => coerce(item, { type: property.items?.type }))
      break
    }
    args[field] = coerce(remaining.shift() as string, property)
  }

  if (remaining.length > 0) {
    throw new Error(`Unexpected extra arguments: ${remaining.join(' ')}`)
  }

  for (const [name, value] of Object.entries(input.flags)) {
    const field = name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
    args[field] = Array.isArray(value)
      ? value.map(item => coerce(item, { type: properties[field]?.items?.type }))
      : coerce(value, properties[field])
  }

  return args
}

function coerce(value: string | boolean, property: SchemaProperty | undefined): JsonValue {
  if (typeof value === 'boolean') return value
  const type = property?.type
  if (type === 'number' || type === 'integer') {
    const parsed = Number(value)
    if (Number.isNaN(parsed)) throw new Error(`Expected a number, got ${value}`)
    return parsed
  }
  if (type === 'boolean') return value === 'true' || value === ''
  if (type === 'array') return [value]
  if (type === 'object') return JSON.parse(value) as JsonValue
  return value
}

function readProperties(capability: ToolCapability): Record<string, SchemaProperty> {
  const properties = capability.inputSchema.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return {}
  return properties as Record<string, SchemaProperty>
}

function positionalFields(capability: ToolCapability): string[] {
  const required = readRequired(capability)
  const trailing = Object.entries(readProperties(capability))
    .filter(([field, property]) => property.type === 'array' && !required.includes(field))
    .map(([field]) => field)
  return [...required, ...trailing]
}

function readRequired(capability: ToolCapability): string[] {
  const required = capability.inputSchema.required
  if (!Array.isArray(required)) return []
  return required.filter((field): field is string => typeof field === 'string')
}

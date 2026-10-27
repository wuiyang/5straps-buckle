import { z } from 'zod'

const MAX_BATCH_FILES = 100

export const pathInput = z.string().min(1).max(4_096)
export const encodingInput = z.enum(['utf8', 'base64']).default('utf8')

export const readInput = z.object({
  path: pathInput,
  encoding: encodingInput,
  /** 1-based first line to return. Ignored for base64. */
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100_000).optional(),
})

export const readBatchInput = z.object({
  paths: z.array(pathInput).min(1).max(MAX_BATCH_FILES),
  encoding: encodingInput,
})

export const writeInput = z.object({
  path: pathInput,
  content: z.string(),
  encoding: encodingInput,
  createParents: z.boolean().default(false),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})

export const writeBatchInput = z.object({ files: z.array(writeInput).min(1).max(MAX_BATCH_FILES) })

/** fs_receive's arguments, which the files route builds from its query and headers: where, how many bytes, and their digest. */
export const receiveInput = z.object({
  path: pathInput,
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

/** fs_send's arguments: the file the files route streams back. */
export const sendInput = z.object({ path: pathInput }).strict()

/** fs_delete's arguments: the entries to remove, and whether a folder goes with everything in it. */
export const deleteInput = z.object({
  paths: z.array(pathInput).min(1).max(MAX_BATCH_FILES),
  recursive: z.boolean().default(false),
}).strict()

export const patchInput = z.object({
  path: pathInput,
  edits: z.array(z.object({
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().default(false),
  })).min(1).max(100),
})

export const listInput = z.object({
  path: z.string().default('.'),
  depth: z.number().int().min(0).max(10).default(1),
  includeIgnored: z.boolean().default(false),
})

export const findInput = z.object({
  path: z.string().default('.'),
  pattern: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(5_000).default(500),
  includeIgnored: z.boolean().default(false),
})

export const searchInput = z.object({
  path: z.string().default('.'),
  pattern: z.string().min(1).max(1_000),
  glob: z.string().max(500).optional(),
  caseSensitive: z.boolean().default(true),
  limit: z.number().int().min(1).max(2_000).default(200),
})

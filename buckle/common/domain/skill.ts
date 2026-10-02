import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { SkillDescriptor } from '@5straps/protocol'

export interface LoadedSkill extends SkillDescriptor {
  content: string
  path: string | null
}

export function toDescriptor({ content: _content, path: _path, ...descriptor }: LoadedSkill): SkillDescriptor {
  return descriptor
}

export function buildSkill(input: { content: string; path: string | null; pack: string | null; id: string }): LoadedSkill {
  const { name, description } = parseFrontmatter(input.content, input.path)
  return {
    id: input.id,
    name,
    description,
    contentHash: createHash('sha256').update(input.content).digest('hex'),
    pack: input.pack,
    content: input.content,
    path: input.path,
  }
}

export function parseFrontmatter(content: string, path: string | null): { name: string; description: string } {
  const body = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  const name = stripQuotes(body.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '')
  const description = stripQuotes(body.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '')
  return {
    name: name || (path ? basename(path, '.md') : 'skill'),
    description,
  }
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '')
}

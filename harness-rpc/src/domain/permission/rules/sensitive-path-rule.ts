import { basename } from 'node:path'
import { isInsideAny, segments } from '../../paths.js'
import type { PermissionRule } from '../decision.js'
import { allowedVia, ask, deny } from '../decision.js'

/** Directory names whose entire subtree holds credentials. */
const SENSITIVE_DIRECTORIES = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.password-store',
  '.mozilla',
  '.thunderbird',
  'keychains',
])

const SENSITIVE_FILENAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'shadow',
  'master.key',
  'secring.gpg',
])

const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env($|\.)/,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/,
  /^service-account.*\.json$/,
  /^secrets?\.(json|ya?ml|toml|ini)$/,
  /_rsa$/,
]

export interface SensitivePathOptions {
  /**
   * Buckle's own state: grants, pending approvals, the policy, the action log. No grant can
   * open these, because a tool that read or rewrote them would be judging itself.
   */
  protectedRoots: string[]
}

export function createSensitivePathRule(options: SensitivePathOptions = { protectedRoots: [] }): PermissionRule {
  return {
    id: 'sensitive_path',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'read_path' && effect.kind !== 'write_path') return null
      if (isInsideAny(options.protectedRoots, effect.path)) {
        return deny('sensitive_path', effect.path, "Buckle's own state and policy are not reachable from a tool")
      }
      const reason = sensitivePathReason(effect.path)
      if (!reason) return null

      // Matched on the exact path: a granted directory must never unlock a secret inside it.
      if (grants.subjectsFor('sensitive_path').includes(effect.path)) return allowedVia('sensitive_path', effect.path)
      return ask('sensitive_path', effect.path, reason)
    },
  }
}

export function sensitivePathReason(path: string): string | null {
  const parts = segments(path)
  const name = basename(path).toLowerCase()

  for (const part of parts.slice(0, -1)) {
    if (SENSITIVE_DIRECTORIES.has(part)) return `Path is inside the credential directory ${part}`
  }
  if (parts.includes('.config') && parts.includes('gcloud')) return 'Path is inside gcloud credentials'
  if (SENSITIVE_FILENAMES.has(name)) return `${name} commonly holds credentials`
  if (SENSITIVE_FILENAME_PATTERNS.some(pattern => pattern.test(name))) return `${name} matches a credential file pattern`
  return null
}

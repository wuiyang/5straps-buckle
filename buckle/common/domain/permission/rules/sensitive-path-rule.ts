import { basename } from 'pathe'
import { comparablePath, isInsideAny, segments } from '../../paths.js'
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
  /**
   * Whether the filesystem ignores case (macOS and Windows by default): a case variant of `~/.5straps` names the
   * same directory there, so the roots are compared folded (review item 13 of the proof-of-possession fixes).
   */
  caseInsensitive?: boolean
}

export function createSensitivePathRule(options: SensitivePathOptions = { protectedRoots: [] }): PermissionRule {
  const fold = (path: string) => comparablePath(path, options.caseInsensitive)
  const protectedRoots = options.protectedRoots.map(fold)
  return {
    id: 'sensitive_path',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'read_path' && effect.kind !== 'write_path') return null
      if (isInsideAny(protectedRoots, fold(effect.path))) {
        return deny('sensitive_path', effect.path, "Buckle's own state and policy are not reachable from a tool")
      }
      // A remembered deny meets every spelling the volume reads as the same file, a missing one included: it is
      // compared folded where the disk ignores case, as the protected roots are, and only ever denies more
      // (GPT review of c71dee5, case-insensitive denial). The allow below stays exact.
      const path = fold(effect.path)
      if (grants.deniedSubjectsFor?.('sensitive_path').some(denied => fold(denied) === path)) return deny('sensitive_path', effect.path, 'The owner denied this sensitive file')
      const reason = sensitivePathReason(effect.path)
      if (!reason) return null

      // Matched on the exact path: a granted directory must never unlock a secret inside it.
      if (grants.subjectsFor('sensitive_path').includes(effect.path)) return allowedVia('sensitive_path', effect.path)
      return ask('sensitive_path', effect.path, `WARNING: This file may contain credentials. Allowing access exposes its contents to the agent or command. ${reason}`, ['once'])
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
  if (name === '.env.schema') return null
  if (SENSITIVE_FILENAMES.has(name)) return `${name} commonly holds credentials`
  if (SENSITIVE_FILENAME_PATTERNS.some(pattern => pattern.test(name))) return `${name} matches a credential file pattern`
  return null
}

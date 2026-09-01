import { basename } from 'node:path'
import { segments } from '../../paths.js'
import type { PermissionRule } from '../decision.js'
import { ask } from '../decision.js'

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

export function createSensitivePathRule(): PermissionRule {
  return {
    id: 'sensitive_path',
    evaluate({ effect, grants }) {
      if (effect.kind !== 'read_path' && effect.kind !== 'write_path') return null
      const reason = classify(effect.path)
      if (!reason) return null

      // Matched on the exact path: a granted directory must never unlock a secret inside it.
      if (grants.subjectsFor('sensitive_path').includes(effect.path)) return { kind: 'allow' }
      return ask('sensitive_path', effect.path, reason)
    },
  }
}

function classify(path: string): string | null {
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

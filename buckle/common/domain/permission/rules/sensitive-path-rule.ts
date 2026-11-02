import { basename } from 'pathe'
import { comparablePath, isInside, isInsideAny, segments } from '../../paths.js'
import { wordList } from '../../word-list.js'
import type { GrantScope } from '@5straps/protocol'
import type { PermissionDecision, PermissionRule, RuleInput } from '../decision.js'
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

/**
 * The subject a secret file's use is asked and granted under (docs/user/how-to/secrets.md): never a path, so a grant to read the
 * file into a command's argument list never opens the file to the agent, nor a read of it the other way round.
 */
export const SECRET_FILE_PREFIX = 'secret-file:'

export function secretFileSubject(path: string): string {
  return `${SECRET_FILE_PREFIX}${path}`
}

/** Whether a sensitive_path subject is a secret file's use, which may be granted for a session or always. */
export function isSecretFileSubject(subject: string): boolean {
  return subject.startsWith(SECRET_FILE_PREFIX)
}

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
  /** Whether the workspace's secrets.files lists the real file a reference names, so its use needs no ask (docs/user/how-to/secrets.md). */
  secretListed?: (path: string) => boolean
  /** Strict mode: a secret file's use is granted for a session at most, so it asks again each session. */
  strict?: boolean
}

export function createSensitivePathRule(options: SensitivePathOptions = { protectedRoots: [] }): PermissionRule {
  const fold = (path: string) => comparablePath(path, options.caseInsensitive)
  const protectedRoots = options.protectedRoots.map(fold)
  return {
    id: 'sensitive_path',
    evaluate({ effect, grants }) {
      if (effect.kind === 'secret_file') return secretFileDecision({ effect, grants, protectedRoots, fold, options })
      if (effect.kind !== 'read_path' && effect.kind !== 'write_path' && effect.kind !== 'delete_path') return null
      if (isInsideAny(protectedRoots, fold(effect.path))) {
        return deny('sensitive_path', effect.path, "Buckle's own state and policy are not reachable from a tool")
      }
      // A folder removed or moved whole takes Buckle's state with it where it holds it.
      if (effect.kind === 'delete_path' && protectedRoots.some(root => isInside(fold(effect.path), root))) {
        return deny('sensitive_path', effect.path, "The folder holds Buckle's own state and policy, which no tool removes or moves")
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

/**
 * A secret file's first use in a workspace asks a person once (docs/user/how-to/secrets.md), naming the file as the reference wrote
 * it and the NAMEs the call reads, never a value; the answer is remembered as the scope chosen, a session at most in
 * strict mode, and a file secrets.files lists needs none. Buckle's own state is never read, and a remembered denial
 * stands, as for any credential file.
 */
function secretFileDecision(input: { effect: Extract<RuleInput['effect'], { kind: 'secret_file' }>; grants: RuleInput['grants']; protectedRoots: string[]; fold: (path: string) => string; options: SensitivePathOptions }): PermissionDecision {
  const { effect, grants } = input
  const subject = secretFileSubject(effect.path)
  if (isInsideAny(input.protectedRoots, input.fold(effect.path))) return deny('sensitive_path', subject, "Buckle's own state and policy are not reachable from a tool")
  if (grants.deniedSubjectsFor?.('sensitive_path').some(denied => isSecretFileSubject(denied) && input.fold(denied.slice(SECRET_FILE_PREFIX.length)) === input.fold(effect.path))) return deny('sensitive_path', subject, `The owner denied the secret file ${wordList(effect.written)}`)
  if (grants.subjectsFor('sensitive_path').includes(subject)) return allowedVia('sensitive_path', subject)
  if (input.options.secretListed?.(effect.path)) return { kind: 'allow' }
  const scopes: GrantScope[] = input.options.strict ? ['once', 'session'] : ['once', 'session', 'always']
  return ask('sensitive_path', subject, `WARNING: Buckle reads ${effect.names.join(', ')} from ${wordList(effect.written)} for this call and puts each value where its secret reference stands, in the command, the browser fill, or the request header; the agent sees [secret:NAME] in its place, never the value. Allowing this file lets the scope you choose read any NAME in it this way.`, scopes)
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

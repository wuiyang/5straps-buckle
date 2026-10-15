import { createFileClientKeys } from '../../common/adapters/keys/file-client-keys.js'
import { clientKeysPath, type NodeConfig } from '../../common/runtime/config.js'

/**
 * Trusts `publicKey` for setup and approval on the whole node, as a key enrolled before D15 is: `buckle keys enroll`
 * refuses both purposes now, and a key enrolled so before keeps them. For the signed-request tests that sign both.
 */
export async function enrollEarlierKey(config: Pick<NodeConfig, 'stateDirectory'>, publicKey: string, label = ''): Promise<void> {
  await createFileClientKeys({ filePath: clientKeysPath(config) }).enroll({ publicKey, label, purpose: 'both', workspace: 'node' })
}

import { requireCredential } from '../../../common/server/utils/guards.js'

export const requireAdmin = requireCredential('admin')

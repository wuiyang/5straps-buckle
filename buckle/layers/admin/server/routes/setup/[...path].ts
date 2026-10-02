import { notFound } from '../../../../common/server/utils/errors.js'
import { resourceOf } from '../../utils/audit.js'
import { accessFor } from '../../utils/guards.js'
import { defineSetupHandler } from '../../utils/setup.js'

// Every other /setup path and method: the admin guard and the admin audit first, so a probe is
// refused and recorded before it learns the path does not exist, then 404.
export default defineSetupHandler({
  access: accessFor,
  resource: resourceOf,
  handler: () => { throw notFound() },
})

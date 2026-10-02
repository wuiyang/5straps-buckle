import { defineSetupHandler } from '../../utils/setup.js'

// The workspace's files with the read and write access each has; ?path= is relative to its root.
export default defineSetupHandler({
  access: 'inspection',
  resource: 'files',
  handler: ({ workspace, views, query }) => views.files(workspace, query()),
})

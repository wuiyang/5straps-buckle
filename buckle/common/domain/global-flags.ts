/** The flag any command takes to use a credential file or directory that other users can reach. */
export const SKIP_OWNER_ONLY_FLAG = '--skip-owner-only-check'

/** The flag an owner's command takes to run where its record cannot be written to the audit log. */
export const IGNORE_WARNING_FLAG = '--ignore-warning'

/** The query parameter, `ignoreWarning=true`, a setup request makes the same choice with. */
export const IGNORE_WARNING_QUERY = 'ignoreWarning'

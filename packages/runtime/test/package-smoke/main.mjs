// Installed-package entry: main owns bootstrap, opens the database, holds the ownership lock, serves.
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createLogger, createRuntimeOwner, createStderrJsonSink } from '@5straps/runtime'
import { bindHost } from '@5straps/runtime/nitro'
import { acquireOwnershipLock, createConnectionOwner, openDatabase } from '@5straps/runtime/sqlite'
import { middleware, nitroApp } from './.output/server/index.mjs'

const dataDir = process.env.SMOKE_DATA_DIR
if (!dataDir) throw new TypeError('SMOKE_DATA_DIR is required')
const logging = createLogger({ component: 'runtime-smoke', sinks: [createStderrJsonSink()] })
const owner = createRuntimeOwner({ services: [] })
bindHost(nitroApp, { owner, services: {}, logger: logging.logger })
const server = createServer(middleware)
owner.onClose('accept', 'http server', () => new Promise((resolve) => {
  server.close(resolve)
  server.closeIdleConnections()
}))

await owner.start(async () => {
  const connection = createConnectionOwner(await openDatabase({ path: join(dataDir, 'smoke.sqlite') }), { owned: true })
  owner.onClose('databases', 'smoke database', () => connection.close())
  await connection.transaction(async (tx) => {
    await tx.exec('CREATE TABLE IF NOT EXISTS smoke (id INTEGER PRIMARY KEY, note TEXT NOT NULL)')
    await tx.sql`INSERT INTO smoke (note) VALUES (${'packaged'})`
  })
  const { rows } = await connection.run(db => db.sql`SELECT count(*) AS count FROM smoke`)
  logging.logger.info('database opened', { rows: Number(rows?.[0]?.count) })
  await acquireOwnershipLock({ path: join(dataDir, 'smoke.lock'), owner })
})
server.listen(0, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ event: 'listening', port: server.address().port })}\n`))

process.once('SIGTERM', async () => {
  await owner.close()
  await logging.close()
})

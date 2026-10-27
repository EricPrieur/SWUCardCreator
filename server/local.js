// The server with a Postgres of its own on this computer, kept in .localdb between runs,
// to try accounts from the app on localhost without touching Railway: npm run local
import EmbeddedPostgres from 'embedded-postgres'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const dir = fileURLToPath(new URL('./.localdb', import.meta.url))
const port = 54330
const postgres = new EmbeddedPostgres({ databaseDir: dir, user: 'local', password: 'local', port, persistent: true })
if (!existsSync(dir)) await postgres.initialise()
await postgres.start()

process.env.DATABASE_URL = `postgresql://local:local@localhost:${port}/postgres`
const stop = async () => {
  await postgres.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

await import('./index.js')

import 'dotenv/config'
import { createApp } from './app.js'
import { initDB } from './db.js'
import { enforcePermanentAdmins } from './auth.js'

const port = Number(process.env.PORT) || 3001

await initDB()
await enforcePermanentAdmins()
const server = createApp().listen(port, () => console.log(`SWU Card Creator server on port ${port}`))

// Railway stops the old server with SIGTERM once a new one is up: finish the requests
// under way and leave cleanly, so npm doesn't report the stop as a failure. (npm run
// local stops its own database on SIGTERM, and exits itself.)
if (!process.listenerCount('SIGTERM'))
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0))
    // Requests that never finish don't hold it up for long
    setTimeout(() => process.exit(0), 5000).unref()
  })

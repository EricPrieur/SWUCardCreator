import 'dotenv/config'
import { createApp } from './app.js'
import { initDB } from './db.js'
import { enforcePermanentAdmins } from './auth.js'

const port = Number(process.env.PORT) || 3001

await initDB()
await enforcePermanentAdmins()
createApp().listen(port, () => console.log(`SWU Card Creator server on port ${port}`))

import express from 'express'
import authRouter, { allowedOrigins } from './auth.js'
import adminRouter from './admin.js'
import cardsRouter from './cards.js'
import publicRouter from './public.js'
import decksRouter from './decks.js'

export function createApp() {
  const allowed = allowedOrigins()
  const app = express()
  // Railway sits in front of the server
  app.set('trust proxy', 1)

  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin && allowed.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin)
      res.header('Vary', 'Origin')
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE')
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })
  app.use(express.json({ limit: '1mb' }))

  app.get('/api/health', (req, res) => res.json({ ok: true }))
  app.use('/api/auth', authRouter)
  // Before the admin router, which wants an admin for everything under /api/admin
  app.use('/api', publicRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api', cardsRouter)
  app.use('/api', decksRouter)

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))
  // A body that isn't JSON, or is too big
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' })
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too large' })
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  })
  return app
}

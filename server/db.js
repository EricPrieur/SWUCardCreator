import pg from 'pg'

// The tables live in their own schema, so they can share a database with
// another project (The Chrome Grid has its own users and decks tables)
export const SCHEMA = 'dune'

// 50 MB of card data and images per account; NULL is no limit
export const DEFAULT_QUOTA = 50 * 1024 * 1024

// Times are kept in UTC (TIMESTAMP columns have no zone): each connection writes them in UTC,
// and they are read back as UTC, for the app to show in the time zone of whoever looks
const TIMESTAMP = 1114
pg.types.setTypeParser(TIMESTAMP, (text) => new Date(`${text.replace(' ', 'T')}Z`))

let pool = null

// The database to use: the one in DATABASE_URL, unless a test hands in its own
export function setPool(next) {
  pool = next
}

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    pool = new pg.Pool({
      connectionString: url,
      // Railway's proxy needs SSL; a database on this computer has none
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    })
    pool.on('connect', (client) => client.query(`SET TIME ZONE 'UTC'`))
  }
  return pool
}

export const query = (text, params) => getPool().query(text, params)

export async function initDB() {
  await query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
  await query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(32) NOT NULL,
      password_hash VARCHAR(255),
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      quota_bytes BIGINT DEFAULT ${DEFAULT_QUOTA},
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMP
    )
  `)
  // Names are unique whatever their capitals, so no one can pass for Prieur as prieur
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON ${SCHEMA}.users (LOWER(username))`)
  // Whether the account may make cards public; an admin can take it away
  await query(`ALTER TABLE ${SCHEMA}.users ADD COLUMN IF NOT EXISTS can_publish BOOLEAN NOT NULL DEFAULT TRUE`)
  // A tester may use the game simulator while it is being built; admins always may
  await query(`ALTER TABLE ${SCHEMA}.users ADD COLUMN IF NOT EXISTS is_tester BOOLEAN NOT NULL DEFAULT FALSE`)
  // The Discord account it signs in with, if any, and its name there
  await query(`ALTER TABLE ${SCHEMA}.users ADD COLUMN IF NOT EXISTS discord_id VARCHAR(32)`)
  await query(`ALTER TABLE ${SCHEMA}.users ADD COLUMN IF NOT EXISTS discord_username VARCHAR(64)`)
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id ON ${SCHEMA}.users (discord_id)`)
  // A card as the app keeps it, its art naming images below. Ids come from the app,
  // so two accounts may hold a card with the same id (one imported from the other).
  await query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.cards (
      user_id INTEGER NOT NULL REFERENCES ${SCHEMA}.users(id) ON DELETE CASCADE,
      id VARCHAR(64) NOT NULL,
      data JSONB NOT NULL,
      bytes INTEGER NOT NULL,
      is_public BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, id)
    )
  `)
  // A public card: its showcase entry (what the Community tab searches and filters by),
  // the JPG of each side, when it was first made public, and whether an admin hid it
  await query(`ALTER TABLE ${SCHEMA}.cards ADD COLUMN IF NOT EXISTS public_entry JSONB`)
  await query(`ALTER TABLE ${SCHEMA}.cards ADD COLUMN IF NOT EXISTS public_image CHAR(64)`)
  await query(`ALTER TABLE ${SCHEMA}.cards ADD COLUMN IF NOT EXISTS public_back_image CHAR(64)`)
  await query(`ALTER TABLE ${SCHEMA}.cards ADD COLUMN IF NOT EXISTS published_at TIMESTAMP`)
  await query(`ALTER TABLE ${SCHEMA}.cards ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE`)
  await query(`CREATE INDEX IF NOT EXISTS cards_public ON ${SCHEMA}.cards (published_at) WHERE is_public`)
  // Art uploaded by an account: the file is on disk, named by the SHA-256 of its bytes
  await query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.images (
      user_id INTEGER NOT NULL REFERENCES ${SCHEMA}.users(id) ON DELETE CASCADE,
      id CHAR(64) NOT NULL,
      content_type VARCHAR(32) NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, id)
    )
  `)
  // A deck, as the app keeps it, in one of the app's Deck Builders: the Showroom's, or a
  // set's ("showcase:<folder>")
  await query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.decks (
      user_id INTEGER NOT NULL REFERENCES ${SCHEMA}.users(id) ON DELETE CASCADE,
      scope VARCHAR(64) NOT NULL,
      id VARCHAR(64) NOT NULL,
      data JSONB NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, scope, id)
    )
  `)
  // A game played in the Simulator, by an account or by anyone: its record (seed, decks and
  // actions, which replay it exactly) and, to count it, how it went and each side's cards.
  // key: what lets the browser that started it go on saving it. is_dev: played on this
  // computer, kept out of the stats.
  await query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.games (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES ${SCHEMA}.users(id) ON DELETE SET NULL,
      key CHAR(32) NOT NULL,
      mode VARCHAR(16) NOT NULL DEFAULT 'ai',
      status VARCHAR(16) NOT NULL DEFAULT 'playing',
      winner SMALLINT,
      draw BOOLEAN NOT NULL DEFAULT FALSE,
      rounds INTEGER NOT NULL DEFAULT 0,
      ai_version VARCHAR(64),
      sides JSONB NOT NULL,
      names JSONB NOT NULL DEFAULT '{}',
      record JSONB NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      is_dev BOOLEAN NOT NULL DEFAULT FALSE,
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMP
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS games_started ON ${SCHEMA}.games (started_at)`)
}

// The bytes an account uses: its cards' data, its images and its decks
export async function usedBytes(userId) {
  const { rows } = await query(
    `SELECT
       COALESCE((SELECT SUM(bytes) FROM ${SCHEMA}.cards WHERE user_id = $1), 0)
     + COALESCE((SELECT SUM(bytes) FROM ${SCHEMA}.images WHERE user_id = $1), 0)
     + COALESCE((SELECT SUM(bytes) FROM ${SCHEMA}.decks WHERE user_id = $1), 0) AS used`,
    [userId],
  )
  return Number(rows[0].used)
}

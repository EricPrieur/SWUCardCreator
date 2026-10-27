import pg from 'pg'

// The tables live in their own schema, so they can share a database with
// another project (The Chrome Grid has its own users and decks tables)
export const SCHEMA = 'dune'

// 50 MB of card data and images per account; NULL is no limit
export const DEFAULT_QUOTA = 50 * 1024 * 1024

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
}

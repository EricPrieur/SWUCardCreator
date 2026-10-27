# SWU Card Creator server

Accounts (and, in the next steps, card storage) for SWU Card Creator. Express, Postgres,
bcrypt passwords and JWT logins. Its tables live in the `dune` schema, so it shares a
database with The Chrome Grid without touching its tables.

## API

| Route | |
|---|---|
| `POST /api/auth/register` | `{ username, password }` → `{ token, user }`. Names are 3-20 letters, digits, `-` or `_`, unique whatever the capitals; passwords 8+ characters. |
| `POST /api/auth/login` | `{ username, password }` → `{ token, user }` |
| `GET /api/auth/me` | The account signed in, and the storage it uses |
| `GET /api/admin/users` | Admins: every account |
| `PATCH /api/admin/users/:id` | Admins: `{ isAdmin?, quotaBytes? }` (`null`: no limit) |
| `GET /api/health` | `{ ok: true }` |

Signed-in calls send `Authorization: Bearer <token>`; a token lasts 30 days.
Each account gets 50 MB. `prieur` is a permanent admin with no limit: the server
restores both whenever that account signs in or the server starts.

## On this computer

```
npm install
npm test          # runs against a throwaway Postgres, nothing to set up
cp .env.example .env   # then fill it in to run the server itself
npm run dev       # http://localhost:3001
```

## On Railway

1. In the project that has The Chrome Grid's Postgres, add a service from this GitHub repo
   and set its **Root Directory** to `server`. Railway runs `npm start`.
2. Variables:
   - `DATABASE_URL`: a reference to the Postgres service's `DATABASE_URL`
   - `JWT_SECRET`: a new long random value (not The Chrome Grid's)
   - `ALLOWED_ORIGINS`: `https://ericprieur.github.io,http://localhost:5173`
   - `NODE_ENV`: `production`
3. Generate a public domain for the service, then register `prieur` right away, before
   sharing the address, so no one else takes the name.

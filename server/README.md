# SWU Card Creator server

Accounts and card storage for SWU Card Creator. Express, Postgres,
bcrypt passwords and JWT logins. Its tables live in the `dune` schema, so it shares a
database with The Chrome Grid without touching its tables.

## API

| Route | |
|---|---|
| `POST /api/auth/register` | `{ username, password }` → `{ token, user }`. Names are 3-20 letters, digits, `-` or `_`, unique whatever the capitals; passwords 8+ characters. |
| `POST /api/auth/login` | `{ username, password }` → `{ token, user }` |
| `GET /api/auth/me` | The account signed in, and the storage it uses |
| `GET /api/auth/discord/status` | `{ enabled }`: whether Discord sign-in is set up |
| `POST /api/auth/discord/url` | `{ link?, returnTo }` → `{ url }`, Discord's page to open in a window. With `link` and a token, links Discord to that account. |
| `GET /api/auth/discord/callback` | Where Discord sends the window back: signs in (making an account the first time) or links, then hands the token to the app's window |
| `DELETE /api/auth/discord` | Unlinks Discord, from an account that has a password |
| `GET /api/admin/users` | Admins: every account |
| `PATCH /api/admin/users/:id` | Admins: `{ isAdmin?, quotaBytes?, canPublish? }` (`null`: no limit) |
| `GET /api/cards` | The account's cards, and the storage it uses |
| `PUT /api/cards/:id` | `{ data }`: adds or replaces a card. Its art names uploaded images as `account:<id>`; art left inline is refused (64 KB per card). |
| `DELETE /api/cards/:id` | Removes a card |
| `POST /api/images` | The image file as the body (JPEG, PNG or WebP, 5 MB at most) → `{ id }`, the SHA-256 of its bytes. The same image is kept once. |
| `GET /api/images/:id` | One of the account's images |
| `PUT /api/cards/:id/public` | `{ entry, image, backImage? }`: makes a card public with its showcase entry and the JPG of each side (uploaded first as images), or updates them |
| `DELETE /api/cards/:id/public` | Makes a card private again |
| `GET /api/decks/:scope` | The account's decks of one Deck Builder: `showroom`, or `showcase:<folder>` for a set's |
| `PUT /api/decks/:scope/:id` | `{ data }`: adds or replaces a deck (32 KB at most) |
| `DELETE /api/decks/:scope/:id` | Removes a deck |
| `GET /api/public/cards` | Everyone's public cards, newest first; no sign-in needed. Admins also get the hidden ones. |
| `GET /api/public/images/:id` | The JPG of a public card's side, for anyone |
| `PATCH /api/admin/cards/:userId/:cardId` | Admins: `{ hidden }`, takes a card off the Community tab or puts it back |
| `POST /api/games` | `{ record, summary }`: a Simulator game as it starts, signed in or not → `{ id, key }`. 60 starts an hour per address; 900 KB at most. |
| `PUT /api/games/:id` | `{ record, summary, key }`: the game saved again (each round, and as it ends or is left), until it is over |
| `GET /api/admin/game-stats` | Admins: games in the last hour, day and week, how they ended, how long they last, people's win rate against the AI and by AI version, games a day |
| `GET /api/admin/games` | Admins: the latest games, without their records; `GET /api/admin/games/:id` one game with its record |
| `GET /api/admin/deck-stats` | Admins: each leader and deck's games and wins, played by people and by the AI |
| `GET /api/admin/card-stats` | Admins: each card's games in a deck, games played, and wins then; `?seat=human` or `ai` |
| `GET /api/health` | `{ ok: true }` |

The game lists and stats take `?days=` (none: all time) and `?dev=1` to count games played on localhost. A game still playing an hour after its last save counts as abandoned.

Signed-in calls send `Authorization: Bearer <token>`; a token lasts 30 days.
Each account gets 50 MB, counting its cards' data, its images and its decks. Images no card
names any more are removed an hour after they were uploaded. `prieur` is a permanent admin with no limit: the server
restores both whenever that account signs in or the server starts.

## On this computer

```
npm install
npm test          # runs against a throwaway Postgres, nothing to set up
cp .env.example .env   # then fill it in to run the server itself
npm run local     # the server with its own Postgres, kept in .localdb, art in .localdata
npm run dev       # the server with the database in .env, http://localhost:3001
```

## On Railway

1. In the project that has The Chrome Grid's Postgres, add a service from this GitHub repo
   and set its **Root Directory** to `server`. Railway runs `npm start`.
2. Variables:
   - `DATABASE_URL`: a reference to the Postgres service's `DATABASE_URL`
   - `JWT_SECRET`: a new long random value (not The Chrome Grid's)
   - `ALLOWED_ORIGINS`: `https://ericprieur.github.io,http://localhost:5173`
   - `NODE_ENV`: `production`
   - `IMAGE_DIR`: `/data/images`, with a **volume** added to the service and mounted at `/data`
   - Discord sign-in, optional (see below): `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
     `DISCORD_REDIRECT_URI`
3. Generate a public domain for the service, then register `prieur` right away, before
   sharing the address, so no one else takes the name.

## Discord sign-in

1. At https://discord.com/developers/applications, make an application for this site.
2. Under **OAuth2**, copy the Client ID, reset and copy the Client Secret, and add the redirects:
   - `https://swu-api-production.up.railway.app/api/auth/discord/callback`
   - `http://localhost:3001/api/auth/discord/callback`, to try it on this computer
3. On Railway, set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_REDIRECT_URI` to the
   first redirect. On this computer, the same in `.env` with the second redirect.

Without them the Discord buttons stay hidden. The sign-in asks Discord only for the
`identify` scope (the Discord name, no email).

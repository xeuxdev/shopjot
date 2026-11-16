# Shopjot backend

This folder is a complete standalone Fastify/TypeScript API. It needs no files from `frontend/` or the repository root to install, build, migrate, or run.

```sh
cp .env.example .env
npm ci
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Local API: `http://127.0.0.1:3001`. Local PostgreSQL: port 5437. `WEB_ORIGIN` must exactly match the frontend origin, including scheme and local port, with no trailing slash.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

The build creates compiled `dist/server.js` and `dist/db/migrate.js`; production runs Node directly. Source `.ts` files and frontend tools are not needed at runtime.

Standalone Docker build, from this folder:

```sh
docker build -t shopjot-backend .
```

The image listens on port **3001**, applies checked-in migrations before starting, and uses `/api/ready` as its health check. Dokploy can deploy it independently using this folder as the build context.

Production runtime variables:

```dotenv
DATABASE_URL=YOUR_NEON_POOLED_CONNECTION_STRING
DIRECT_DATABASE_URL=YOUR_NEON_DIRECT_CONNECTION_STRING
WEB_ORIGIN=https://shop.example.com
```

Use an HTTPS API hostname on the same parent domain as the frontend, e.g. `api.example.com`. Multiple independent stores share this API and database. Registration persists each supplied UUID/name with its owner account; duplicate names are allowed, IDs are unique. Server authentication determines the store scope, and ledger/backup endpoints require a valid session. A supplied store ID never grants access to another store.

Credentialed CORS is restricted to `WEB_ORIGIN`; CSRF origin checks, secure session cookies, store authorization, idempotency, and checksum verification remain enabled. Keep Neon URLs exclusively in this application's runtime environment.

Constraint tests require an isolated/local database:

```sh
TEST_DATABASE_URL=postgres://doris:doris_local_only@localhost:5437/doris_foods npm run test:db
```

The deeper client/server sync tests live outside this deployable folder in the optional repository `tests/` harness. No backend build imports frontend source or requires that harness. Money/sync rules are committed locally in `src/domain/` and checked against the frontend's copy during repository verification.

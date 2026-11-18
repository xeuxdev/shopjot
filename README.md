# Shopjot

An offline store ledger for independent shops. Each store starts with a name and a unique UUID, without needing an account or internet. Register or sign in when you want server backup. Multiple stores share the service while their accounts, sales, payments, stock, and backups remain separate.

Two independent applications:

```text
frontend/   React PWA — its own package.json, package-lock.json, Dockerfile and .env.example
backend/    Fastify API — its own package.json, package-lock.json, Dockerfile and .env.example
```

There is no root workspace, shared install, root Dockerfile, or production Compose project. Each application can be copied out of this repository and built on its own. Neon PostgreSQL is used only by the backend.

## Run locally

Backend:

```sh
cd backend
cp .env.example .env
npm ci
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Frontend, in another terminal:

```sh
cd frontend
cp .env.example .env
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. It calls the API at `http://127.0.0.1:3001`. The frontend remains usable offline after the app shell is installed. On first use, create a store or sign in to restore an existing store. Guest stores can record sales, stock and payments immediately. Connect an owner account in Settings for server backup; registration keeps the existing store ID and queued records.

## Deploy

Create **two Dokploy Applications**. Use the backend's folder as its Docker build context and the frontend's folder as the other context. Deploy the backend at `api.example.com` and the frontend at `shop.example.com`, with HTTPS on both.

| Application | Configuration                                                                    |
| ----------- | -------------------------------------------------------------------------------- |
| Backend     | Runtime `DATABASE_URL`, `DIRECT_DATABASE_URL`, `WEB_ORIGIN`; container port 3001 |
| Frontend    | Build argument `VITE_API_URL`; container port 8080                               |

See [the exact Dokploy settings](deploy/DOKPLOY.md), [frontend instructions](frontend/README.md), and [backend instructions](backend/README.md).

## Checks

Each application has its own checks:

```sh
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix backend run typecheck
npm --prefix backend run lint
npm --prefix backend test
npm --prefix backend run build
```

The frontend build needs `VITE_API_URL` set in its environment or frontend `.env` file.

Optional development checks across both applications:

```sh
node scripts/check-domain.mjs
npm --prefix tests ci
TEST_DATABASE_URL=postgres://doris:doris_local_only@localhost:5437/doris_foods npm --prefix backend run test:db
TEST_DATABASE_URL=postgres://doris:doris_local_only@localhost:5437/doris_foods npm --prefix tests test
```

The `tests/` folder is only an integration-test harness. Neither deployment imports it or depends on its packages. Its database fixtures use unique test accounts and are cleaned up afterward; use a local/test database.

Money calculations and versioned sync contracts are committed under each application's `src/domain/`, so builds need no shared package or registry. `node scripts/check-domain.mjs` checks that these files remain identical. Update both copies together when changing the financial/protocol rules, then run the cross-application sync tests.

## Money rules

- Amounts are nonnegative integer kobo. Inputs accept up to two decimal places for naira and three for quantities; extra precision is rejected.
- Each item is calculated with integer arithmetic and rounded half up to the nearest kobo. The sale total is the sum of those rounded lines. For example, two separate lines of half a unit at one kobo each total two kobo.
- Values and aggregates above `9,007,199,254,740,991` kobo are rejected instead of rounded to an unsafe JavaScript number. Invalid checkout inputs show **—** until they can be calculated.
- Repayments must be positive and cannot exceed that sale's outstanding balance. IndexedDB transactions and a PostgreSQL store lock serialize competing writes.
- Repeating a saved request keeps its original receipt and does not charge or deduct stock again. Reusing its ID for changed customers, goods, amounts, or stock counts is rejected.

Before a production release that changes these rules, run both applications' tests, the domain-copy check, and the PostgreSQL integration harness above against an isolated test database. The integration tests cover rounding, boundary amounts, concurrent repayments and stock deductions, rollback, retries after lost responses, and restoration. Connected browser checks are described in [frontend instructions](frontend/README.md).

## Stores and accounts

- First use: enter a store name and create its local ledger, or sign in to restore a backed-up store.
- Store names can repeat. Every store has its own stable UUID, shown in Settings and included in exports.
- A guest store works offline without registration. Pending changes stay local until its owner registers an account.
- Registration attaches the current name and ID to an owner email/password account, then backs up the existing ledger. It does not generate a replacement store ID.
- Login on a fresh browser restores the server's name, ID and records. Restored phones remain read-only until explicit primary-device takeover.
- Local records, drafts or queue entries prevent a different store from replacing that ledger during sign-in. A signed-out registered ledger remains locked until its owner signs in again.
- Each browser profile holds one local store; each account currently owns one store. Multiple independent stores can use the same deployed Shopjot service.

Existing installations are adopted in place. Internal IndexedDB, session-cookie and background-sync identifiers retain their legacy names so existing records, sessions and pending jobs keep working. Older guest ledgers keep the original store name; new stores always choose their own. No PostgreSQL schema change is needed for this rollout because every business record was already scoped by store ID.

## Preserved behavior

Every sale requires a customer and accepts freely typed goods and units. Money is integer kobo with decimal-safe quantity arithmetic. Sales, payments, stock movements, and an ordered outbox commit atomically in IndexedDB. The API validates and commits them idempotently in PostgreSQL. A matching complete-ledger checksum is required before showing **Backed up**.

Sync resumes on writes, startup, reconnect, foregrounding, periodic checks, and supported background-sync events. Browsers control execution after an app closes; pending records remain queued until it can run again. A lost or cleared phone can still lose unacknowledged records. Keep exports as an extra copy.

Replacement phones restore in read-only mode and require explicit primary-device takeover. JSON import, audited correction/voiding UI, and password reset remain follow-up work. Local browser data is not encrypted by this app.

The original [handoff](Doris_Foods_Codex_Handoff.md) remains product context; this independent-folder layout follows the user's later instruction and replaces its suggested workspace layout. See [implementation status](IMPLEMENTATION_STATUS.md) for verification details.

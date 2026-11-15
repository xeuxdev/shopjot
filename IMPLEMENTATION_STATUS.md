# Implementation status — 15 November 2026

The original handoff remains the product source of truth. The application now has an authenticated custom Fastify API and verified offline-first synchronization, with deployment packaging for Dokploy and Neon PostgreSQL.

## Implemented

| Area             | Result                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structure        | Independent `frontend/` and `backend/` applications, each with its own npm lockfile, configuration, domain rules, Dockerfile, and environment example                   |
| Local ledger     | Required customer names, arbitrary goods/units, fractional quantities, full/partial/unpaid sales, drafts, immutable sale snapshots                                      |
| Payments/reports | Repayments against a selected sale; separate daily sales/collections; customer balances; Lagos day boundaries                                                           |
| Inventory        | Explicit product-unit links, transactional stock movements, manual counts, shortage approval, no guessed conversions                                                    |
| Accounts         | Owner registration/login, scrypt password hashes, opaque HttpOnly/Secure/SameSite sessions, origin checks, rate limiting, logout                                        |
| Sync             | Durable ordered outbox; transactionally acknowledged idempotent pushes; paginated pulls; backoff/jitter; startup/reconnect/foreground/manual/native background triggers |
| Verification     | Server cursor, counts, and complete SHA-256 ledger checksum before claiming “Backed up”                                                                                 |
| Recovery         | Verified restore on a replacement device, initially read-only; explicit primary-device takeover                                                                         |
| Deployment       | Two independent Dokploy Applications; static Nginx frontend calls the API URL directly; credentialed CORS; Neon pooled/direct runtime URLs; locked startup migrations   |
| Data safety      | Store-scoped CSV/JSON exports, persistent storage request, clear pending/error/backup state; no credential export                                                       |

## Reliability details

A local financial write commits the sale, customer, items, initial payment, stock movements, and outbox record atomically. Queue sequence numbers are assigned inside the same transaction. The IndexedDB v2 migration orders legacy queued operations by their dependencies without dropping them, preserves existing IDs, and fills receipt positions where needed.

The server validates money and quantities using its own committed copy of the domain rules. It serializes writes per store and commits business records, stock movements, processed-operation acknowledgment, and incremental restore changes in the same PostgreSQL transaction. Retrying after a commit whose response was lost returns the previous acknowledgment. Reusing an operation ID with changed contents is rejected.

The client verifies acknowledgment identity and digest before marking an operation acknowledged. Acknowledged operations remain locally for duplicate prevention. Invalid operations stop the queue for review; transient errors retry and never discard records.

Pull collapses paginated absolute records and applies them in one IndexedDB transaction only when no unacknowledged local changes exist. An interrupted page does not advance the local cursor. A verified backup requires the full local/server ledger to match, covering all seven entity types. A missing queued record is detected rather than silently called backed up.

Web Locks coordinate tabs and service workers and release automatically on termination. A persistent lease provides a bounded fallback for browsers without Web Locks. Browser testing caught and resolved stale-lease behavior after hard navigation; retry triggers that arrive during an active run are coalesced rather than lost.

## Verification after the folder split

- `npm --prefix frontend run typecheck`, `lint`, and `build`: passed, including the custom service worker. The build uses an explicit `VITE_API_URL`.
- `npm --prefix frontend test`: **22 tests passed**.
- `npm --prefix backend run typecheck`, `lint`, and `build`: passed. The backend compiles to JavaScript and runs directly on Node, with no TypeScript runner in the production image.
- `TEST_DATABASE_URL=… npm --prefix backend test`: **15 tests passed**, including four real PostgreSQL constraint tests.
- `TEST_DATABASE_URL=… npm --prefix tests test`: **5 client/server sync tests passed**, including full entity backup, lost response after commit, malformed acknowledgment/reopen, account isolation, device takeover, checksum mismatch detection, and interrupted multi-page restore. This optional test harness is outside both deployable applications.
- `node scripts/check-domain.mjs`: the independently committed money and versioned sync contracts match.
- `docker build -t doris-backend:split backend`: passed using only the backend folder. Its compiled migration entry point applied migrations successfully against the isolated local QA database.
- `docker build --build-arg VITE_API_URL=http://127.0.0.1:18081 -t doris-frontend:split frontend`: passed using only the frontend folder.
- Both containers started independently and reported healthy. Static frontend deep links return 200; `/api/` on the frontend returns 404 because API traffic goes directly to the separate backend.
- `SYNC_E2E=1 E2E_BASE_URL=… SYNC_API_URL=… npm --prefix frontend run test:e2e`: **9 browser tests passed** against the separate frontend/API containers and the isolated local QA database. Includes credentialed cross-origin login, four accessibility scans, offline reload/drafts, stock, repayments, automatic reconnect backup, a dropped response, restored records, and primary-device switching.
- Backend production-dependency audit: zero known vulnerabilities after updating Drizzle ORM to 0.45.4. This result covers production npm dependencies, not an audit of development tooling or container base images.

That is **51 passing tests**: 22 frontend tests, 15 backend tests, five cross-application sync tests, and nine browser tests. Ten domain tests run in each application intentionally, because each ships its own financial/protocol rules.

The old root dependency installation was removed before these checks. There is no root package/workspace manifest or build configuration. Each app can be built from its folder without the sibling application's source. Upstream Zod comment-annotation warnings do not prevent successful production builds.

## Deployment handoff

Create two Dokploy **Applications**, one for `frontend/Dockerfile` with context `frontend`, the other for `backend/Dockerfile` with context `backend`. The frontend serves on port 8080; the backend serves on port 3001. The frontend's public `VITE_API_URL` is a build argument. Backend runtime variables are `WEB_ORIGIN`, pooled Neon `DATABASE_URL`, and direct Neon `DIRECT_DATABASE_URL`.

Use HTTPS subdomains on the same parent domain, e.g. `shop.example.com` and `api.example.com`, so the existing secure SameSite session cookies work. The backend restricts credentialed CORS and mutating request origins to the frontend. There is no production Compose project, reverse proxy to the backend inside the frontend image, or required shared Docker network. See [the complete Dokploy settings](deploy/DOKPLOY.md).

The local-development PostgreSQL Compose file now lives in `backend/docker-compose.yml`. It retains the `shopjot` project and volume name to preserve existing local data. Production uses Neon.

Keep the existing frontend domain and Neon database when replacing an older deployment. Browser storage names, record IDs, schema migrations, queue semantics, and account IDs are unchanged. Sign in once again because the session cookie now belongs to the backend host.

No Neon credentials were supplied, so the actual Neon connection, remote Dokploy deployment, domain certificate, and physical Android/iPhone installation remain unverified. No remote Git push, DNS change, or publication was performed.

## Practical limits and remaining work

- Background work after the browser/app closes is best-effort and browser-controlled. Durable pending records resume whenever the app or service worker can run with connectivity. Lost/cleared device storage before acknowledgment can still lose unbacked records.
- The MVP supports one primary editing device. Takeover prevents further old-device writes on the server; unsynced changes left on an old offline phone are preserved there and require explicit recovery rather than an automatic conflicting merge.
- This trusted phone stays available offline after sign-in. Local IndexedDB is not encrypted by the app. Signing out locks the local interface without deleting records; signing in again needs internet.
- Self-service password reset, JSON import, audited correction/voiding UI, physical-device performance testing, and owner trial remain follow-up work. No unsupported corrections, OCR, or AI scanning are claimed.

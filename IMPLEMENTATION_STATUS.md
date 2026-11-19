# Implementation status — 19 November 2026

Shopjot is now a multi-store offline ledger with optional owner accounts for verified backup. The original handoff remains product context; the later requirements replace the single-store branding and add named-store setup. Frontend and backend remain independently deployable in Dokploy, with Neon PostgreSQL behind the API.

## Implemented

| Area             | Result                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structure        | Independent `frontend/` and `backend/` applications, each with its own npm lockfile, configuration, domain rules, Dockerfile, and environment example                                    |
| Local ledger     | Required customer names, arbitrary goods/units, fractional quantities, full/partial/unpaid sales, recoverable drafts with save status, audited correction/voiding and preserved receipts |
| Payments/reports | Repayments against one sale or an atomic allocation across selected sales; separate daily sales/collections; customer balances; Lagos day boundaries; audit columns in sales CSV         |
| Inventory        | Explicit product-unit links, transactional stock movements, manual counts, shortage approval, no guessed conversions                                                                     |
| Accounts         | Owner registration/login, scrypt password hashes, opaque HttpOnly/Secure/SameSite sessions, origin checks, rate limiting, logout                                                         |
| Sync             | Durable ordered outbox; transactionally acknowledged idempotent pushes; paginated pulls; backoff/jitter; startup/reconnect/foreground/manual/native background triggers                  |
| Verification     | Server cursor, counts, and complete SHA-256 ledger checksum before claiming “Backed up”                                                                                                  |
| Recovery         | Verified restore on additional devices; every phone using the shared store login can record sales                                                                                        |
| Deployment       | Two independent Dokploy Applications; static Nginx frontend calls the API URL directly; credentialed CORS; Neon pooled/direct runtime URLs; locked startup migrations                    |
| Data safety      | Store-scoped CSV/JSON exports, persistent storage request, clear pending/error/backup state; no credential export                                                                        |

## Store lifecycle

A first-time user can create a store with just a name, without an account or an API request. Its cryptographically generated UUID stays attached to its local sales, payments, customers, stock, drafts and ordered outbox. Names can repeat across stores; IDs cannot. The name and full ID appear in Settings and JSON exports; export filenames include the store ID.

Registration sends this existing ID and the chosen name to the backend and signs in its owner. It keeps queued operations and begins verified backup. Login on a fresh browser adopts the server's name and ID and verifies the restored ledger before accepting new changes. Every signed-in phone can then record sales; additional logins do not disable other phones. Server authentication sets the store scope; supplying someone else's ID in a request cannot select their ledger.

All local records and meaningful drafts are checked before switching to another store ID. A draft entered while a sign-in request is in flight also prevents replacement. An authentication check that finishes after sign-out cannot unlock the ledger or resume backup. Each browser profile currently holds one local store, and each account owns one store; the deployed service serves many independent stores.

Existing installations get a named store profile in place, using the account name or original legacy store name. Their database name, device/store IDs, financial records, drafts, queue and sessions are retained. Internal cookie, IndexedDB, lock and background-sync identifiers intentionally retain their old names for compatibility. Store naming did not require a PostgreSQL schema change; audited corrections now add migration `0003_audited_sale_corrections` for void reasons, dates and replacement links.

## UX improvements verified on 19 November

Mobile sale entry keeps a total and **Review & save** shortcut above navigation. Validation identifies and focuses invalid fields. Draft status reflects completed storage writes and supports retry, resume and confirmed discard. Recent goods reuse the last unit/price, and **Save & record another** resets the receipt and focuses the next customer. Suggestions remain reachable by keyboard. Notifications stay above mobile checkout and below modal dialogs.

Customer payments preview an oldest-first allocation across up to 100 selected sales. A correction requires a reason and saves the replacement, original void, payment reversals and stock reversals in one local transaction and one server operation. Original collection dates and sale dates are preserved. Concurrent payments block stale corrections or allocations without partially changing server records. Receipts, reasons, reversal history and replacement links remain visible and are retained in exports.

Verification: 63 frontend unit tests, 15 backend unit tests, four PostgreSQL constraint tests, and 14 cross-application PostgreSQL sync tests passed. Browser checks covered offline sales, draft recovery and failure/retry, consecutive sales, allocation previews, correction/void history, keyboard selection, exports, and accessibility. Both production builds, both linters, shared-domain equality and diff whitespace checks passed. PostgreSQL used a temporary container without mounted data; no remote deployment was changed.

Deploy the migrated backend before the updated frontend. Installed clients need the updated audit fields and operation kinds. Earlier verification results below are historical.

## Reliability details

A local financial write commits the sale, customer, items, initial payment, stock movements, and outbox record atomically. Queue sequence numbers are assigned inside the same transaction. The IndexedDB v2 migration orders legacy queued operations by their dependencies without dropping them, preserves existing IDs, and fills receipt positions where needed.

The server validates money and quantities using its own committed copy of the domain rules. It serializes writes per store and commits business records, stock movements, processed-operation acknowledgment, and incremental restore changes in the same PostgreSQL transaction. Retrying after a commit whose response was lost returns the previous acknowledgment. Reusing an operation ID with changed contents is rejected.

The client verifies acknowledgment identity and digest before marking an operation acknowledged. Acknowledged operations remain locally for duplicate prevention. Invalid operations stop the queue for review; transient errors retry and never discard records.

Pull collapses paginated absolute records and applies them in one IndexedDB transaction only when no unacknowledged local changes exist. An interrupted page does not advance the local cursor. A verified backup requires the full local/server ledger to match, covering all seven entity types. A missing queued record is detected rather than silently called backed up.

Web Locks coordinate tabs and service workers and release automatically on termination. A persistent lease provides a bounded fallback for browsers without Web Locks. Browser testing caught and resolved stale-lease behavior after hard navigation; retry triggers that arrive during an active run are coalesced rather than lost.

## Verification after shared-phone sign-in — 18 November 2026

- Frontend: **57 tests passed**, including writing from a restored phone with a legacy read-only flag, while signed-out and incomplete restores remain blocked.
- Backend: **19 tests passed**, including real PostgreSQL constraints.
- Client/server sync: **10 tests passed** against isolated PostgreSQL, including concurrent sales from two devices, retained payments and negative stock when both offline phones sell the last unit, conflicting repayments retained for review, and independent logout. The two shared-phone cases passed again with fully paid sales.
- Browser: **22 tests passed**, including creating sales on both phones with the same login, cross-phone ledger updates, offline recovery, PDF/CSV exports, installation UI, and accessibility.
- Both builds, type checks, lint, and the domain-copy check passed. Deploy the backend first, then the frontend; this change adds no database migration.

## Verification after multi-store setup — 16 November 2026

- `npm --prefix frontend run typecheck`, `lint`, and `build`: passed, including the custom service worker. The build uses an explicit `VITE_API_URL`.
- `npm --prefix frontend test`: **35 tests passed**, covering store creation, legacy adoption, guest registration, identity preservation, in-flight draft safety and sign-out races.
- `npm --prefix backend run typecheck`, `lint`, and `build`: passed. The backend compiles to JavaScript and runs directly on Node, with no TypeScript runner in the production image.
- `TEST_DATABASE_URL=… npm --prefix backend test`: **15 tests passed**, including four real PostgreSQL constraint tests.
- `TEST_DATABASE_URL=… npm --prefix tests test`: **5 client/server sync tests passed**, including full entity backup, lost response after commit, malformed acknowledgment/reopen, account isolation, device takeover, checksum mismatch detection, and interrupted multi-page restore. This optional test harness is outside both deployable applications.
- `node scripts/check-domain.mjs`: the independently committed money and versioned sync contracts match.
- `docker build -t shopjot-backend:verify backend`: passed using only the backend folder. Its compiled migration entry point applied migrations successfully against the isolated local QA database.
- `docker build --build-arg VITE_API_URL=http://127.0.0.1:18081 -t shopjot-frontend:verify frontend`: passed using only the frontend folder.
- Both containers started independently and reported healthy. Static frontend deep links return 200; `/api/` on the frontend returns 404 because API traffic goes directly to the separate backend.
- `SYNC_E2E=1 E2E_BASE_URL=… SYNC_API_URL=… npm --prefix frontend run test:e2e`: **13 browser tests passed** against the separate frontend/API containers and the isolated local QA database. Includes offline guest setup without API requests, duplicate store names with separate accounts/IDs/backups, store-aware JSON export, 320px long-name layout, setup/sign-in accessibility, four ledger accessibility scans, credentialed cross-origin login, offline reload/drafts, stock, repayments, automatic reconnect backup, a dropped response, restored store identity/name/records, and primary-device switching.
- After the final mobile sign-in layout adjustment, all five store/sync browser checks passed again, including the visible-without-scrolling sign-in button, guest setup, duplicate-name store isolation, backup and restore.
- Backend production-dependency audit: zero known vulnerabilities after updating Drizzle ORM to 0.45.4. This result covers production npm dependencies, not an audit of development tooling or container base images.

That is **68 passing tests**: 35 frontend tests, 15 backend tests, five cross-application sync tests, and 13 browser tests. Ten domain tests run in each application intentionally, because each ships its own financial/protocol rules.

The old root dependency installation was removed before these checks. There is no root package/workspace manifest or build configuration. Each app can be built from its folder without the sibling application's source. Upstream Zod comment-annotation warnings do not prevent successful production builds.

## Deployment handoff

Create two Dokploy **Applications**, one for `frontend/Dockerfile` with context `frontend`, the other for `backend/Dockerfile` with context `backend`. The frontend serves on port 8080; the backend serves on port 3001. The frontend's public `VITE_API_URL` is a build argument. Backend runtime variables are `WEB_ORIGIN`, pooled Neon `DATABASE_URL`, and direct Neon `DIRECT_DATABASE_URL`.

Use HTTPS subdomains on the same parent domain, e.g. `shop.example.com` and `api.example.com`, so the existing secure SameSite session cookies work. The backend restricts credentialed CORS and mutating request origins to the frontend. There is no production Compose project, reverse proxy to the backend inside the frontend image, or required shared Docker network. See [the complete Dokploy settings](deploy/DOKPLOY.md).

The local-development PostgreSQL Compose file now lives in `backend/docker-compose.yml`. It retains the `shopjot` project and volume name to preserve existing local data. Production uses Neon.

Keep the existing frontend domain and Neon database when replacing an older deployment. Browser storage names, record IDs, existing migration history, queue ordering, and account IDs are retained. Apply the added audit migration before the updated frontend. Sign in once again when moving from the legacy same-origin deployment because the session cookie now belongs to the backend host.

No Neon credentials were supplied, so the actual Neon connection, remote Dokploy deployment, domain certificate, and physical Android/iPhone installation remain unverified. No remote Git push, DNS change, or publication was performed.

## Practical limits and remaining work

- Background work after the browser/app closes is best-effort and browser-controlled. Durable pending records resume whenever the app or service worker can run with connectivity. Lost/cleared device storage before acknowledgment can still lose unbacked records.
- Multiple signed-in phones can write after verified restore. Stale repayments, corrections and stock counts can require review; failed operations remain local and block the queue rather than silently overriding newer history.
- This trusted phone stays available offline after sign-in. Local IndexedDB is not encrypted by the app. Signing out locks the local interface without deleting records; signing in again needs internet.
- Self-service password reset, JSON import, physical-device performance testing, and owner trial remain follow-up work. OCR and AI scanning are not implemented.

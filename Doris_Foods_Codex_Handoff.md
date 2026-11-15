# Doris Foods — Codex Implementation Handoff

**Status:** MVP implementation specification  
**Project:** Doris Foods Store Ledger & Inventory  
**Audience:** Codex agent working in VS Code  
**Last updated:** 2026-11-13  
**Priority:** Build a usable, mobile-first, offline-first store ledger. Inventory supports the ledger; it must not slow down recording a sale.

> **Agent instruction:** Treat this document as the source of truth for implementation. Inspect the existing repository before making changes; reuse appropriate existing conventions and code. Implement incrementally, keep the application runnable at the end of each phase, and report what was actually finished, verified, and remains. Do not silently replace the specified stack or introduce unrelated features. Where this document explicitly marks a product decision as open, use the documented MVP default and make it easy to change later. Do not halt the whole project for noncritical clarifications.

---

## 1. Product in one paragraph

Doris Foods is a small Nigerian retail grocery store currently recording every sale in a notebook. The owner needs a simple phone app to enter **every customer's name, freely typed goods bought, quantities, Nigerian/local quantity labels, prices, and how much was paid**. It must maintain a reliable customer ledger, track outstanding credit and later repayments, update inventory for recognized stocked goods, and show **daily sales, money actually collected, and total customer debt**. The app **must work without internet** after initial installation and setup, then synchronize safely when connected. It is for **one owner and one primary phone initially**, with a clean path to other stores later.

### Confirmed requirements

- Business: **retail groceries**.
- Current workflow: **every sale is handwritten in a notebook**.
- Initial operator: **only the owner**.
- Transactions: **all sales require a customer name**, including fully paid sales.
- Goods: **free-text item names**; products must **not** be limited to a fixed dropdown.
- Quantities: both individually counted goods and measured quantities.
- **Quantity labels are free text**, including `mudu`, `paint`, `kg`, `bag`, `carton`, `piece`, `litre`, `bottle`, and any new term the owner types. Suggestions are optional shortcuts, never restrictions.
- Prices: mostly fixed, but allow per-sale price overrides.
- Credit: allow **full payment, partial payment, and no payment**, plus later repayments and accurate outstanding balances.
- Inventory MVP: current stock quantities and selling prices; avoid advanced stock management screens.
- Reports MVP: **daily sales, money collected, customers owing**.
- Offline: **essential**, not a future enhancement.
- Existing notebooks: **no historical migration required**. Start fresh, with current stock manually registered if desired.
- Growth: Doris Foods first; additional stores later.
- Future feature, **not V1**: photograph receipts/purchases and extract goods with OCR/AI.

### Explicit technology constraint

**Do not use or propose Supabase.** Use **PostgreSQL with a custom backend API**. No backend-as-a-service substitutions.

---

## 2. Product principles

1. **Fast enough to replace paper.** The primary workflow should require minimal screens and taps; customer/product suggestions must speed typing rather than obstruct it.
2. **Never require predefined products to record a sale.** New product text is always valid. Only recognized, properly linked stock items affect inventory.
3. **Never guess measurement conversions.** `paint`, `mudu`, `bag`, and `kg` can mean different quantities depending on product/store; support arbitrary unit labels and only convert using explicitly configured per-product rules (not required in initial MVP).
4. **Money and history must be trustworthy.** No double-counting payments, double-deducting stock, or losing a sale due to intermittent internet.
5. **Offline is normal operation.** Local saves are immediate. Clearly communicate whether data is safely backed up to the server.
6. **Support the actual phone user.** Large tap targets, readable text, numeric keyboard for amounts, low-end-device performance, minimal visual clutter.
7. **Small MVP first.** No POS hardware, tax engine, supplier accounting, automated customer messaging, or OCR in V1.

---

## 3. MVP scope and exclusions

### Build in V1

- Installable mobile-first PWA; offline app shell after initial load.
- Owner authentication/setup online, with a sensible local offline unlock strategy for the primary device.
- New sale entry with mandatory customer name; autocomplete existing customers, quick-create new customers.
- One sale containing multiple goods, each with `name`, `quantity`, `quantityLabel`, `unitPrice`, computed `lineTotal`.
- Fast item rows: add another, delete unsaved row, change quantity/price, optional product autocomplete.
- Payment at checkout: paid in full, part payment, unpaid. Persist actual payment amount, not just a status.
- Saved sales and itemized history.
- Customer list, search, individual transaction/debt history and repayments.
- Inventory: add/search product, free-text quantity label, stock count, price per unit, manual count adjustment.
- Auto-deduct inventory for a sale item **only when explicitly linked to a compatible product unit**.
- Dashboard: daily sales value, payments received today (including older-debt repayments), total outstanding debt.
- Local IndexedDB persistence, offline create/read, sync queue, online push/pull and retry.
- Cloud backup to the custom PostgreSQL backend; restore onto a replacement device after login.
- Data export (at least CSV for sales/customers and JSON backup if safe and feasible).
- Basic authenticated access, input validation, audit-friendly records and handling of accidental duplicate submissions.
- Visible backup state: `Saved on this phone`, `Syncing`, `Backed up`, `Sync failed / retry`.

### Deliberately defer

- OCR, AI scanning, purchase-photo extraction, barcode scanners.
- Multiple staff, roles, branches, simultaneous collaborative editing.
- Supplier accounts, purchase orders, expense accounting, profit/margin dashboards.
- Automated SMS/WhatsApp reminders, accounting integrations, POS printers.
- Complex unit conversions and conversion-based stock pooling unless explicitly requested later.
- Historical notebook imports.

---

## 4. Navigation and screen specifications

Use four bottom navigation destinations: **Home, Sales, Customers, Stock**. Settings/backup/export/logout may be in an overflow menu.

### 4.1 Home

- Show **Today's Sales**, **Collected Today**, **Total Owed**, optionally **Number of Sales Today**.
- Primary sticky/prominent button: **Record Sale**.
- Recent activity: sales and later credit payments, clearly differentiated.
- Sync indicator with last successfully backed-up time; warning for unsynced local records.
- All values shown in Nigerian naira: `₦` and grouped digits.
- Dates/day boundaries use store timezone (default `Africa/Lagos`), not accidental browser UTC boundaries.

### 4.2 Record Sale — most important screen

1. **Customer**: free text, required, suggestions from existing customer names. Select a customer or create the new name automatically on save. Prevent unintentional duplicate customers with a confirmation when similar names exist, but do not block saving indefinitely.
2. **Goods**: rows of:
   - Item name: **free text**; show product suggestions as you type; users can ignore them.
   - Quantity: numeric, including fractional values (e.g. `0.5`, `1.25`).
   - Quantity label: **free text** (e.g. `mudu`, `paint`, `kg`, or any label). Suggest recent/commonly used labels as quick chips, not a fixed select.
   - Unit price in NGN: auto-prefill from matched product/unit where available, otherwise manual; always editable for that sale.
   - Computed row subtotal.
   - `+ Add another item` action without leaving the page.
3. **Totals**: running sum of line subtotals.
4. **Payment**: choose `Paid in full`, `Part payment`, `Credit / unpaid`. Input `Amount received` for partial payment. Display remaining balance live. A paid-in-full selection sets amount received equal to total; unpaid sets zero.
5. **Save**: validate fields, commit sale + items + initial payment (if any) + stock movements + outbox operation **atomically to local IndexedDB**. Immediately show a saved confirmation and backup status. Prevent repeat taps creating duplicate sales.
6. If an item is not linked to stock, **do not block the sale**; show `Not tracked in inventory` quietly. Do not silently deduct a similarly named product.

**Illustrative sale (fictional amounts):**

- Customer: `Mama Chika`
- `Rice` — `2 mudu` × `₦3,500` = `₦7,000`
- `Groundnut oil` — `1 bottle` × `₦4,500` = `₦4,500`
- Sale total = `₦11,500`; amount received = `₦5,000`; outstanding = `₦6,500`.

### 4.3 Sales

- Reverse-chronological list with customer, date, total, payment status and outstanding balance.
- Search by customer or item name; simple filters: date, paid/partial/unpaid.
- Sale detail: saved item snapshots, total, initial and later payments, outstanding, timestamp, stock link flags.
- Do not silently edit or hard-delete completed financial records. See section 10 on corrections.

### 4.4 Customers

- Customer search and list; each row optionally displays outstanding balance.
- Detail screen: customer name, optional phone, purchases, total outstanding, payment history.
- **Record Repayment** from a customer's unpaid sale: enter positive amount up to the remaining balance; append payment event; immediately recalculate ledger and dashboard. If a customer has multiple unpaid sales, let the owner **choose which sale is being paid**; don't silently allocate across sales in V1.
- All sales require a customer. `Walk-in Customer` is **not automatically substituted** unless explicitly chosen and confirmed by the owner; original requirement is to record a customer name each time.

### 4.5 Stock

- Add product with free-text name; register one or more **product units/quantity labels**, free-text (e.g. `rice — mudu`, `rice — paint`). Each unit record has quantity on hand and suggested selling price.
- Search, browse, and manual adjust current quantities. Show clear change confirmation and create a stock movement record.
- Selling a product-unit deducts the corresponding stock quantity; prevent quantities from becoming silently incorrect. Warn if insufficient stock and require an explicit override policy (MVP default: warn and allow sale, record negative inventory with warning).
- **No automatic conversions** between different product units without per-product conversion rules. `10 mudu` and `1 paint` are not treated as equivalent; initially they are separately tracked stock entries when explicitly configured that way.
- Product names/units must be reusable as suggestions, but free-text sale entries remain possible.

### 4.6 Settings / data safety

- Online sign-in/account setup, sign-out, last backup time, sync retry status.
- Simple export for own records.
- Explain clearly: offline data is on this device until synchronized, and loss/clearing of browser storage before backup can lose records.
- Option to request persistent device storage where supported.

---

## 5. Suggested stack and codebase layout

Choose the following unless an existing repository already has a closely equivalent established solution:

| Layer | Choice |
| --- | --- |
| Web app | React, TypeScript, Vite |
| UI | Tailwind CSS, shadcn/ui, accessible headless primitives |
| Routing | React Router or existing project routing convention |
| Local state/data | Dexie.js + IndexedDB; reactive local queries where appropriate |
| PWA | `vite-plugin-pwa` / service worker caching app shell/assets |
| API | Node.js + Fastify + TypeScript |
| Schema/SQL | Drizzle ORM + migrations |
| Persistent database | **PostgreSQL** |
| Validation | Zod shared schemas where practical |
| Forms | React Hook Form + Zod, if useful |
| Monorepo | pnpm workspaces |
| Automated tests | Vitest, Testing Library, API integration tests, Playwright mobile/offline E2E |

Proposed structure:

```text
doris-foods/
├── apps/
│   ├── web/
│   │   └── src/
│   │       ├── app/
│   │       ├── pages/        # Home, Sales, Customers, Stock, Settings
│   │       ├── features/     # sale-entry, payments, stock, customers, sync
│   │       ├── components/
│   │       ├── db/           # Dexie schema, migrations, local transactions
│   │       └── lib/
│   └── api/
│       └── src/
│           ├── routes/
│           ├── services/
│           ├── db/           # PostgreSQL + Drizzle migrations
│           ├── auth/
│           └── sync/
├── packages/
│   └── shared/              # Zod contracts, domain types, calculation helpers
├── docker-compose.yml      # local PostgreSQL development
├── .env.example
└── README.md
```

**Do not add a separate Next.js server, GraphQL layer, message broker, microservices, Redis or a cloud auth product for MVP without a demonstrated need.**

---

## 6. Data model (PostgreSQL)

Use UUID IDs generated on the client for offline-created records. Scope every business record to `store_id` now even though only Doris Foods exists in V1. Define foreign keys, unique constraints, indexes, nonnegative/valid-money constraints, and timestamp metadata. Avoid unnecessary duplication of calculated balances; use efficient queries/aggregates or carefully maintained read models.

**Money:** store integer minor currency units (`*_kobo BIGINT`) throughout API/server/local DB where possible. Display `₦` in UI. Never use JS floating point for money calculations.  
**Quantities:** use PostgreSQL `NUMERIC(16,3)` (or equivalent precision) and decimal-safe logic; transfer values through JSON as **decimal strings**, not binary floating point.  
**Time:** UTC timestamps internally, formatted/grouped by `Africa/Lagos` by default.  
**Snapshots:** record exact item names, labels and price at time of sale so edits to product master data never change historical receipts.

### Required tables

| Table | Minimum fields / meaning |
| --- | --- |
| `users` | `id`, credentials/account identity, `created_at` |
| `stores` | `id`, `owner_user_id`, `name`, `timezone`, `created_at` |
| `customers` | `id`, `store_id`, `name`, `normalized_name`, `phone_nullable`, `created_at`, `updated_at` |
| `products` | `id`, `store_id`, `name`, `normalized_name`, `active`, timestamps |
| `product_units` | `id`, `store_id`, `product_id`, `label`, `normalized_label`, `suggested_unit_price_kobo`, `quantity_on_hand` (decimal), timestamps |
| `sales` | `id`, `store_id`, `customer_id`, `total_kobo`, `occurred_at`, `status` (active/voided), `created_at`, timestamps |
| `sale_items` | `id`, `store_id`, `sale_id`, `product_unit_id_nullable`, `name_snapshot`, `quantity_decimal`, `quantity_label_snapshot`, `unit_price_kobo`, `line_total_kobo` |
| `payments` | `id`, `store_id`, `sale_id`, `amount_kobo`, `method_nullable`, `received_at`, `created_at`, optional reversal reference |
| `stock_movements` | `id`, `store_id`, `product_unit_id`, `sale_item_id_nullable`, `quantity_delta_decimal`, `reason` (initial_stock/sale/manual_adjustment/reversal), `occurred_at`, `created_at` |
| `processed_sync_operations` | `store_id`, `operation_id` UNIQUE, `device_id`, `operation_type`, `result`, `processed_at` — guarantees idempotent retries |
| `sync_changes` | monotonic `change_id`, `store_id`, `entity_type`, `entity_id`, `operation`/payload, `created_at` — supports incremental pull and device restore |

Local Dexie should represent enough of the same entities for complete offline read/write plus an `outbox` table: `operationId`, `kind`, `payload`, `createdAt`, `status`, `attemptCount` and optional error text. Also maintain `sync_metadata` with device ID, last pulled cursor and last successful backup time.

### Key domain rules

- All sales must reference a valid customer. New customer creation may be bundled atomically with saving a sale.
- `sale.total_kobo` = sum of `sale_items.line_total_kobo`; compute/verify in trusted domain functions.
- `sale.outstanding_kobo` = `total_kobo` minus sum of nonreversed payments for that sale (derived, not independently user-editable).
- Computed payment status: `paid` if outstanding is zero; `unpaid` if received amount is zero; otherwise `partial`.
- Payments may not be negative, and by MVP default a payment must not exceed that sale's outstanding balance.
- Dashboard `today_sales` = sum of active sale totals with `occurred_at` falling on store's current local day.
- Dashboard `collected_today` = sum of nonreversed payments **received today**, regardless of when the original sale occurred.
- Dashboard `total_owed` = outstanding across all active sales; exclude voided sales and reversed payments according to the correction rules.
- Sale stock deduction is **based on `product_unit_id`, never product name similarity alone**.
- Manual stock changes produce stock movements; do not update a quantity without history.
- Unique product unit labels should be enforced case-insensitively **within a product**; customer duplicate names may exist and must be disambiguated carefully.
- All backend queries validate the authenticated user's access to the store; do not trust a `store_id` in the request without authorization.

### Quantity labels and conversion policy

**The quantity label input is always editable free text.** Suggested shortcuts may include `mudu`, `paint`, `kg`, `bag`, `carton`, `piece`, `litre`, `bottle`, but no hardcoded enum should reject new terms. Preserve display text and a normalized form for comparison.

**MVP recommendation:** track stock separately per explicitly registered `product_unit`. If a stock item is `Rice / mudu`, selling `2 mudu` from its selected product-unit deducts 2. Selling `1 paint` as unlinked free text is still allowed, but does **not** deduct stock from `Rice / mudu`. Show the owner when an item is untracked. Do not invent a universal `paint ↔ mudu`, `bag ↔ kg`, or `carton ↔ piece` factor. Product-specific conversion support can be introduced later when real-world usage makes it necessary.

---

## 7. Backend/API contract

Suggested REST routes (adapt naming consistently). Use auth and store-scoping on all routes except health/login.

```http
POST   /auth/register              # initial owner setup; online
POST   /auth/login
POST   /auth/logout
GET    /auth/me
GET    /stores/current
GET    /customers?search=
POST   /customers
GET    /customers/:id
GET    /products?search=
POST   /products
POST   /products/:id/units
POST   /stock/adjustments
GET    /sales?customerId=&from=&to=
GET    /sales/:id
POST   /sales                    # online direct operation if applicable
POST   /sales/:id/payments
GET    /dashboard?date=YYYY-MM-DD
POST   /sync/push               # authoritative write path for offline operations
GET    /sync/pull?cursor=...    # incremental changes / restore
GET    /health
```

For one consistent implementation, prefer going through the **same domain service functions** whether a change originates from `/sync/push` or a direct API route. No divergence in validation or calculations. Optionally keep direct write routes out of the web UI and send all mutations through the outbox.

### Sample sale operation (illustrative)

```json
{
  "operationId": "client-generated-uuid",
  "deviceId": "stable-local-device-uuid",
  "type": "sale.create",
  "payload": {
    "saleId": "client-generated-uuid",
    "customer": { "id": "client-generated-uuid", "name": "Mama Chika" },
    "occurredAt": "2026-11-13T12:00:00.000Z",
    "items": [
      {
        "id": "item-uuid",
        "name": "Rice",
        "quantity": "2",
        "quantityLabel": "mudu",
        "unitPriceKobo": 350000,
        "productUnitId": null
      },
      {
        "id": "item-uuid-2",
        "name": "Groundnut oil",
        "quantity": "1",
        "quantityLabel": "bottle",
        "unitPriceKobo": 450000,
        "productUnitId": null
      }
    ],
    "initialPaymentKobo": 500000
  }
}
```

These integer kobo example amounts yield `₦7,000 + ₦4,500 = ₦11,500`, received `₦5,000`, outstanding `₦6,500`.

The server must **recalculate** subtotals and total from trusted numeric values and validate that the initial payment does not exceed the sale total. For noninteger fractional quantity, calculate line total using decimal arithmetic and a defined half-up/standard money rounding policy **once per line**.

---

## 8. Offline-first persistence and synchronization

### 8.1 Required local write behavior

When the owner presses Save:

1. Validate locally; assign stable client-generated UUIDs and one stable `operationId`.
2. In a **single Dexie transaction**, write the sale, sale items, customer if needed, initial payment if any, stock movements for linked stock units, and one outbox operation.
3. On success, immediately render updated local views and `Saved on this phone` status.
4. Do not rely on a service worker background-sync event for correctness; trigger sync on app start, `online` events, when the user requests retry, and when the app returns to foreground.
5. Never delete a pending outbox operation until the server explicitly acknowledges it.

### 8.2 Server push and retry behavior

- `POST /sync/push` accepts one or a small ordered batch of operations.
- Each operation runs in a **PostgreSQL transaction**.
- Enforce `(store_id, operation_id)` uniqueness; replaying the same operation returns the previous acknowledgment **without applying it twice**.
- Validate IDs, ownership, product-unit references, totals, payments and stock logic.
- Commit business records, stock movements, processed-operation marker and change log in the same transaction.
- Return per-operation acknowledgments and useful, structured failures.
- Client retries transient failures with exponential backoff and jitter; invalid operations are surfaced to the user for resolution rather than retried forever.
- Client keeps locally committed data if network/server is unavailable.

### 8.3 Pull and recovery

- `GET /sync/pull?cursor=...` returns an authenticated, store-scoped sequence of changes and a stable `nextCursor`; support pagination.
- The client applies remote changes idempotently, without applying remote stock deductions a second time on top of already applied local optimistic movements.
- First login on a replacement device downloads the authoritative store snapshot / change history and reconstructs local records.
- Primary-device-only editing for V1: if another device begins editing, show a device-switch/restore warning or prevent simultaneous writers. This keeps conflicts manageable until multi-device collaboration is explicitly designed.
- Dashboard and all business screens must query local data to remain functional offline.

### 8.4 Offline authentication and data safety

- First-time registration and initial authentication require internet. After successful setup, support reopening the installed app offline on the same authorized device. Decide on a local unlock/PIN experience as a security/UX setting; **never persist the account password in plaintext**.
- Use HTTPS in production; secure sessions/tokens, rate-limited login, password hashing with a modern algorithm (e.g. Argon2id), input validation and safe logging.
- A local PIN is **only a device unlock**, not a substitute for server authentication or database encryption. Never claim IndexedDB is encrypted at rest by the app unless it actually is.
- Request persistent browser storage if supported; warn that browser/app deletion and lost phones can erase unbacked data.
- Show the last successful server backup; do not show `Backed up` before acknowledgment.
- Provide manual export as an additional safety measure. Downloads/exports must not include password hashes or auth tokens.

---

## 9. UI/interaction details

- Mobile-first at roughly 360–430px viewport widths. Desktop layout may expand but is secondary.
- Minimum comfortable tap target of roughly 44px. Important buttons fixed or easily reachable near the bottom when appropriate.
- For amounts and quantities, open a decimal numeric keypad on mobile (`inputMode="decimal"`); for names and labels, standard text keyboard.
- Use standard inline text inputs and autocomplete suggestion menus, **not mandatory product/unit dropdown selection**.
- Suggest recently used customer names, product names, quantity labels, and saved prices.
- Save/reopen form drafts locally so switching apps or an accidental refresh does not lose an unfinished long sale (provided no conflicting submission has occurred).
- Use clear inline totals, explicit errors, validation, empty states, loading and offline/sync states.
- Support Nigerian names, apostrophes, accents and ordinary Unicode text without destructive normalization.
- Currency presentation: e.g. `₦3,500`, `₦12,450.50` if fractional naira are supported. The product is NGN-only for MVP.
- Explain product stock association when a typed item is not currently tracked.
- Prefer clear wording: `Paid`, `Part payment`, `Unpaid`, `Amount received`, `Amount still owed`, `Record payment`, `Saved on this phone`, `Backed up`.
- Keep a short path from launch → new sale → save. Don't force editing the inventory catalog first.

---

## 10. Corrections, deletion and audit safety

The user **has not supplied the choices from the second, five-question form to this conversation**. Therefore, the following are conservative implementation defaults, **not confirmed preferences**:

- Default device assumption: Android-first PWA testing, while keeping iPhone-compatible responsive design.
- Default customer identification: name required; phone optional; disambiguate same-name matches.
- Default recovery: automatic server backup when online; one primary editor device initially.
- Default quantity conversion: none unless explicitly configured per product.
- Default corrections: **auditable corrections, no silent financial hard-deletes**.

Implement the first four defaults straightforwardly. For correction flows, avoid dangerous ad hoc database edits. Minimum MVP: allow the owner to identify an incorrect sale and mark it for correction/voiding while preserving history. If payments or stock were involved, use explicit **reversal records** in the same local/server transactional workflow so totals remain consistent; never simply delete a paid sale or leave its stock deduction behind. If a fully safe correction UI would delay the core flow, build the audited domain operations and mark the advanced UI as a follow-up; document any current limitation prominently. Do not claim corrections are supported before they're tested.

---

## 11. Security, reliability and performance requirements

- Server-controlled authentication and store authorization for all read/write endpoints.
- Zod validation for untrusted API inputs; reject invalid amounts, quantities, names, malformed UUIDs and unauthorized IDs.
- Use parameterized queries / Drizzle queries; no raw string-interpolated SQL.
- Atomic DB transactions for sale creation, repayments, stock changes, and idempotency markers.
- Store-ledger totals must never use client-provided calculated totals as the authoritative value.
- Pagination and indexes for customers/sales/product search; default recent history load reasonably small.
- Password hashing, secure session renewal, no credential leakage in local browser logs or exports.
- Use accessible labels and feedback for keyboard/screen reader use.
- Handle retry storms and duplicate taps without duplicate data.
- Test slow/intermittent connectivity and reloaded pages, not merely full-time airplane mode.
- Use stable domain functions for payments and stock so UI, IndexedDB and API don't implement slightly different rules.

---

## 12. Acceptance tests — must pass before MVP sign-off

### Sales and amounts

1. Enter a new customer name, two freely typed goods with arbitrary quantity labels, save fully offline; the sale appears immediately after reload.
2. Enter `Rice`, quantity `2`, quantity label `mudu`, unit price `₦3,500`; line total shows `₦7,000`.
3. Enter an entirely new quantity label (e.g. `scoop`, `small paint`, `heap`) and save; no validation error or forced dropdown selection.
4. One sale of `₦11,500` with `₦5,000` received creates `₦6,500` outstanding.
5. Later pay `₦2,000` against that sale; outstanding becomes `₦4,500`, and the payment is visible as a distinct historical event.
6. Reject negative/zero quantities, negative prices, payment greater than balance, empty required names; provide precise errors.
7. Editing the current catalog price does **not** change historical sale line values.
8. Tapping Save twice rapidly creates **one** sale.

### Inventory and unit logic

9. Product `Rice / mudu` starts at 15; a linked sale of `2 mudu` leaves 13.
10. A typed but **unlinked** `Rice / paint` sale is valid and does **not** subtract from `Rice / mudu`.
11. Manual stock count adjustment changes the visible number and creates a movement record.
12. Stock balances remain correct after app restart, retrying a sync, and restoring from server.

### Dashboard and credit

13. On a day with `₦100,000` of new sales, `₦60,000` collected against those sales, and `₦15,000` repaid against an older sale, display **Sales = ₦100,000** and **Collected = ₦75,000**.
14. Show each customer's outstanding balance and aggregate total owed correctly.
15. On two outstanding sales for one customer, a repayment must be allocated to an explicitly selected sale.
16. Date groupings use the store's Nigerian timezone around midnight.

### Offline and synchronization

17. After installation/login, create sales, inspect customers, record repayments and adjust stock in airplane mode.
18. Refresh/restart while still offline: committed records survive and remain usable.
19. Reconnect: pending operations synchronize and show acknowledged backup status.
20. Retry the exact same `operationId` multiple times: no duplicate sale/payment/stock movement.
21. Disconnect during an upload after server commit but before response: retry still results in exactly one mutation.
22. Restore on a fresh authorized device from the server after the original is backed up; sale history, payments, customer balances and stock match.
23. Make an unsynced sale and clear local storage during a controlled test: the app must **not** falsely claim it was backed up; warn about this risk in the UI.

### Security and product quality

24. A different account cannot read or mutate Doris Foods records by changing `store_id`/record IDs.
25. Main sale flow is usable at 360px width on an entry-level Android phone without horizontal scrolling.
26. Unit labels and product names remain free-text throughout all screens; no hidden mandatory enum.
27. App handles malformed API responses/network failures without silently losing data.

---

## 13. Build order for Codex

**Phase 0 — Repository assessment and setup**

- Inspect the repository; if empty, scaffold the workspace and chosen stack.
- Add lint/typecheck/test scripts, local PostgreSQL Docker Compose, `.env.example`, database migration setup and concise startup instructions.
- Confirm dev commands for web, API, database migrations and test suite.

**Phase 1 — Local-first core ledger**

- Shared domain types/validation and money/decimal utilities.
- Dexie schema with migration/versioning and atomic mutations.
- Mobile shell, home navigation, customer autocomplete and new sale form.
- Saved sales and customer ledger views; initial and later payments.
- Local dashboard derived from local records.
- Tests for totals, part payments, names, dynamic units and reload persistence.

**Phase 2 — Inventory and stock association**

- Products and product units; stock registration, adjustment and movement history.
- Optional autocomplete/linking inside sale entry; associated stock deductions.
- Free-text unmatched items without deduction.
- Tests for stock changes, fractional quantities and no guessed conversions.

**Phase 3 — Custom backend and sync**

- PostgreSQL schema/migrations and custom owner authentication.
- Store-scoped routes and shared domain validations.
- Operation outbox, idempotent push, cursor-based pull, retries and restore.
- UI backup status; data export; offline/login behavior.
- Server integration tests and Playwright offline/sync scenarios.

**Phase 4 — Polish and owner testing**

- Mobile UX optimization, form drafts, clear errors, empty states and performance.
- Auditable correction/reversal support where practical and tested.
- Accessibility, real-device PWA tests, deployment notes and data safety documentation.
- Test with a few realistic days of fictional Doris Foods records.

At the end of each phase, provide: (a) concise summary of files/features added, (b) commands used, (c) what passed/failed, (d) remaining blockers, (e) suggested next phase. Don't claim features are complete without verifying them.

---

## 14. Definition of done

MVP is ready for owner trial when they can **start from a fresh installed app; enter a customer and arbitrary goods/unit labels; save sales as paid/part-paid/unpaid; record later repayments; see correct daily sales, collections and debts; maintain basic current stock; operate all day offline; sync without duplicating data; and recover backed-up records on a replacement phone**.

Do not prioritize future AI receipt scanning until the manual ledger is quick and reliable in actual use.

---

## 15. Implementation-start prompt for Codex

Copy this prompt into Codex **with this document available in the repository**:

> Read `Doris_Foods_Codex_Handoff.md` fully and treat it as the implementation specification. First inspect the repo, identify existing patterns, and summarize any conflicts with the spec. Do not use Supabase or another BaaS. PostgreSQL + custom Fastify/Node backend are required. Start implementing **Phase 0 and Phase 1**, prioritizing a fast mobile-first offline sale form with mandatory customer name, unrestricted goods and quantity labels (including mudu, paint, kg), partial payments, customer ledger, and Dexie persistence. Use mock or local data only where explicitly appropriate, but preserve the real domain model. Keep the project runnable, add tests, run them, and report precise progress. Don't implement OCR/AI scanning. Preserve the difference between daily sales and payments actually received.


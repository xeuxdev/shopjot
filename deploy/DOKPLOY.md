# Deploy Shopjot frontend and backend separately in Dokploy

Deploy one shared Shopjot service for all stores; each store gets its own account and data scope. Create **two Applications** in the same Dokploy project. Each has its own Dockerfile, install, build, and deploy button. No production Compose setup or shared Docker network is required.

Use two HTTPS subdomains on the same parent domain, for example:

- Frontend: `https://shop.example.com`
- Backend: `https://api.example.com`

The browser calls the backend URL directly. The backend allows credentialed requests only from the configured frontend origin. Keeping both HTTPS hosts on the same parent domain lets the existing secure SameSite session cookies work without third-party cookie exceptions.

## 1. Backend application

Connect this repository and deployment branch, then select Dockerfile build type:

| Dokploy field          | Value                 |
| ---------------------- | --------------------- |
| Source/build path      | `/` (repository root) |
| Dockerfile path        | `backend/Dockerfile`  |
| Docker context path    | `backend`             |
| Build stage            | Leave blank           |
| Start command override | Leave blank           |
| Domain                 | `api.example.com`     |
| Container port         | `3001`                |
| HTTPS / certificate    | On / Let's Encrypt    |

Set these **runtime environment variables** using the same Neon branch/database/role for both URLs:

```dotenv
DATABASE_URL=YOUR_NEON_POOLED_CONNECTION_STRING
DIRECT_DATABASE_URL=YOUR_NEON_DIRECT_CONNECTION_STRING
WEB_ORIGIN=https://shop.example.com
```

`WEB_ORIGIN` must exactly match the frontend origin, with no trailing slash. Keep Neon's TLS parameters in the database URLs. These secrets belong only to the backend runtime, never to the frontend or Docker build arguments.

Deploy the backend. It applies the checked-in migrations under a lock before starting the API. Check `https://api.example.com/api/ready`; it should return readiness JSON. The image already sets production mode, listen host `0.0.0.0`, and port 3001.

## 2. Frontend application

Create another Application using the same repository and branch:

| Dokploy field          | Value                 |
| ---------------------- | --------------------- |
| Source/build path      | `/` (repository root) |
| Dockerfile path        | `frontend/Dockerfile` |
| Docker context path    | `frontend`            |
| Build stage            | Leave blank           |
| Start command override | Leave blank           |
| Domain                 | `shop.example.com`    |
| Container port         | `8080`                |
| HTTPS / certificate    | On / Let's Encrypt    |

Under the Dockerfile **Build Time Arguments**, set:

```dotenv
VITE_API_URL=https://api.example.com
```

This public URL is compiled into the frontend and its service worker. The frontend build rejects a missing or invalid API URL. No Neon credentials belong here. Changing `VITE_API_URL` requires rebuilding the frontend; changing backend database credentials only requires redeploying the backend.

Deploy, then open `https://shop.example.com` and create a named store without an account, then register its owner account through **Settings & data → Backup & account**. Returning owners can sign in directly from the setup screen. Confirm **Backed up** after a fictional sale.

Create DNS A records for both domains pointing to your server before requesting Let's Encrypt certificates. Dokploy routes each domain to its application's container port; direct host-port publishing is unnecessary.

## Store setup after deployment

One frontend and one backend serve all stores. Each store has a unique UUID; names do not need to be unique. Customers, sales, payments, inventory and backup operations are scoped to the authenticated store. Do not create a separate Dokploy application or database for every shop.

A new shop can enter a store name and work offline immediately. To back up, register an owner account in Settings. This links the existing store ID/name and pending records to that account. On another browser, use **Sign in to your store** to restore it. Each browser profile holds one local store; switching accounts cannot silently replace a ledger with saved records or drafts.

This rollout requires no new PostgreSQL migration. Existing databases and browser IDs remain valid. Preserve the frontend origin and database URLs when updating; the public Shopjot rebrand does not require renaming local databases, Docker volumes or session cookies.

## Updates and existing records

Deploy the frontend and backend independently. Each build context contains only that application's folder and lockfile. A frontend change never needs a backend build, and a backend change never needs a frontend build.

If replacing the older Compose deployment:

1. Use the **same Neon database** for the new backend.
2. Bring up the new backend at its API subdomain.
3. Move the existing frontend domain to the new frontend Application once it is ready; stop the old deployment after cutover.
4. Keep the exact frontend HTTPS domain. IndexedDB, drafts, queued records, and device identity remain at that origin. Do not clear browser storage.
5. Sign in again once: session cookies now belong to the API host rather than the old frontend host. Existing account/store IDs and queued operations remain valid.

The API schema, operation IDs, retry logic, and browser database name are unchanged by the folder split. A different frontend hostname has separate browser storage and does not automatically receive the old phone's unbacked records.

## Verify

- Frontend health: `https://shop.example.com/healthz`
- Backend readiness: `https://api.example.com/api/ready`
- Refresh `https://shop.example.com/sales/new` directly.
- Record a fictional sale offline, reload, reconnect, and wait for **Backed up**.
- On a fresh browser/device, sign in and restore. The replacement starts read-only until explicit primary-device takeover.

Reliable sync retains pending changes until matching acknowledgment, verifies complete ledger counts/checksum, and retries without duplicating money or stock. Browser execution after closing remains best-effort; the queue resumes whenever the app or service worker can run. Records lost from a phone before server acknowledgment cannot be recovered from the server.

## Local commands

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

Open `http://127.0.0.1:5173`. The frontend's `VITE_API_URL` points to `http://127.0.0.1:3001`, and the backend's `WEB_ORIGIN` allows the frontend. Development uses non-Secure cookies on loopback; production uses HTTPS and Secure cookies.

The backend's development Compose file retains the existing `shopjot` project/volume name to preserve previously created local PostgreSQL data. There is no production database container; production uses Neon.

## References

- [Dokploy Dockerfile paths and build arguments](https://docs.dokploy.com/docs/core/applications/build-type)
- [Vite build-time environment variables](https://vite.dev/guide/env-and-mode)
- [Fastify credentialed CORS](https://github.com/fastify/fastify-cors)
- [Cookie SameSite behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies)

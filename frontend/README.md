# Doris Foods frontend

This folder is a complete standalone React/TypeScript/Vite PWA. It needs no files from `backend/` or the repository root to install or build.

```sh
cp .env.example .env
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. `VITE_API_URL` is the backend origin, e.g. `http://127.0.0.1:3001` locally or `https://api.example.com` in production. The backend must allow this frontend's origin in `WEB_ORIGIN`.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run preview
```

`VITE_API_URL` is required when building and is also compiled into the service worker. Use HTTPS in production and put the API on the same parent domain as the frontend for secure session cookies. Changing the API URL requires a frontend rebuild. No database credentials belong in this application.

Standalone Docker build, from this folder:

```sh
docker build --build-arg VITE_API_URL=https://api.example.com -t doris-frontend .
```

The image serves static files on port **8080**. It has no backend proxy or container dependency. Dokploy can deploy it independently using this folder as the build context.

Browser checks:

```sh
npx playwright install chromium
npm run test:e2e
```

For a connected check, run both applications against an isolated test database, build with the matching API URL, and set `SYNC_E2E=1`, `E2E_BASE_URL` to the frontend URL, and `SYNC_API_URL` to the backend URL. Connected browser tests create fictional accounts/records; do not use an owner-production database.

Existing phone data remains at the same frontend origin and IndexedDB name. The money/sync contract lives locally in `src/domain/`; the repository's optional contract check and integration tests detect differences from the API's copy without coupling deployment builds.

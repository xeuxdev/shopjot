FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3001
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=35s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/server.js"]

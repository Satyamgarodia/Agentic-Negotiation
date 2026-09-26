# ---- Build stage: install deps + build Vite frontend ----
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --legacy-peer-deps
# Copy the rest of the source and build the frontend into dist/
COPY . .
RUN npm run build

# ---- Runtime stage: lean production image ----
FROM node:20-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
# Cloud Run injects $PORT (defaults to 8080). server.ts reads process.env.PORT.
ENV PORT=8080

# Reuse the node_modules built above (includes tsx, used by `npm start`)
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Production artifacts: compiled frontend + server entrypoint
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.ts ./

EXPOSE 8080

CMD ["npx", "tsx", "server.ts"]

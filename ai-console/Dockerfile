FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY ai-console/package.json ./ai-console/package.json
RUN npm ci

FROM deps AS builder
COPY ai-console ./ai-console
RUN npm run build --workspace ai-console

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    AI_CONSOLE_DATA_DIR=/data

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && mkdir -p /data \
  && chown -R nextjs:nodejs /data

COPY --from=builder --chown=nextjs:nodejs /app/ai-console/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/ai-console/.next/static ./ai-console/.next/static

USER nextjs
WORKDIR /app/ai-console
EXPOSE 3000

CMD ["node", "server.js"]

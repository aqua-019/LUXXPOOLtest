# ═══════════════════════════════════════════════════════════
# LUXXPOOL — Production Dockerfile
# ═══════════════════════════════════════════════════════════

FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-alpine

RUN apk add --no-cache tini
RUN addgroup -S luxxpool && adduser -S luxxpool -G luxxpool
RUN mkdir -p /var/log/luxxpool && chown luxxpool:luxxpool /var/log/luxxpool

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

USER luxxpool

EXPOSE 3333 3334 3336 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]

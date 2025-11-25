FROM oven/bun:1.3.3-slim AS base
WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 elapse && \
    adduser --system --uid 1001 --ingroup elapse elapse

# Dependencies stage
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Production image
FROM base AS runner

LABEL org.opencontainers.image.source="https://github.com/kdcokenny/elapse"
LABEL org.opencontainers.image.description="AI-powered standup bot for GitHub"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production

COPY --from=deps --chown=elapse:elapse /app/node_modules ./node_modules
COPY --chown=elapse:elapse src ./src
COPY --chown=elapse:elapse package.json ./

USER elapse
EXPOSE 3000

# Healthcheck using bun (no curl dependency)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/index.ts"]

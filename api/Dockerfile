# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
COPY simulator/package.json simulator/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile --filter kinan-works-api

FROM dependencies AS build
COPY api api
RUN bun run --cwd api build

FROM oven/bun:1.3.14-alpine AS runtime
ENV NODE_ENV=production \
    API_PORT=3000 \
    SQLITE_PATH=/data/kinan.sqlite
WORKDIR /app
COPY --from=build --chown=bun:bun /app/api/dist ./dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "dist/index.js"]

# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
COPY simulator/package.json simulator/package.json
COPY exporter/package.json exporter/package.json
# The xlsx tarball is large and registry extraction has been flaky on the
# GitHub runner; retry the install on transient download failures.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    for attempt in 1 2 3; do \
      bun install --frozen-lockfile --filter kinan-works-exporter && exit 0; \
      echo "install attempt $attempt failed; retrying"; sleep $((attempt * 5)); \
    done; \
    exit 1

FROM dependencies AS build
COPY exporter exporter
RUN bun build exporter/src/index.ts --target bun --outdir exporter/dist

FROM oven/bun:1.3.14-alpine AS runtime
ENV NODE_ENV=production \
    EXPORTER_PORT=3100 \
    EXPORTER_SQLITE_PATH=/data/kinan.sqlite \
    EXPORTER_STORE_PATH=/data/exporter.sqlite \
    EXPORTER_FILES_DIR=/data/exports
WORKDIR /app
COPY --from=build --chown=bun:bun /app/exporter/dist ./dist
RUN mkdir -p /data
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:3100/internal/exports/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "dist/index.js"]

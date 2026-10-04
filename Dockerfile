# Build: install all deps, build the web app.
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

# Runtime: production deps only, server code, models, built web app and the private serving snapshot.
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIR=/app/web/dist \
    SERVING_PATH=/app/data/serving.sqlite \
    OPS_PATH=/tmp/ops.sqlite \
    SPEND_LEDGER_PATH=/tmp/spend-ledger.sqlite
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/server ./server
COPY --from=build /app/pipeline/config.ts ./pipeline/config.ts
COPY --from=build /app/ml/models ./ml/models
COPY --from=build /app/web/dist ./web/dist
# `data/` in the repo (and thus in the primary build context) is a symlink to the real dataset directory,
# which lives outside this worktree and is participant-only (never committed, never added to the build
# context — see .dockerignore). Docker does not dereference a symlink that points outside the build
# context, so a plain `COPY data/serving.sqlite` would copy a dangling link instead of the file.
# `servingdata` is a named *additional* build context pointed at the real, on-disk data directory
# (see the `docker:build` script in package.json, which resolves it with `readlink -f data` and passes
# it via `docker build --build-context servingdata=<real path>`). This COPY reads straight from that
# named context, so the real serving.sqlite lands in the image without the host data/ directory ever
# being part of the primary (tar'd) build context.
COPY --from=servingdata serving.sqlite ./data/serving.sqlite
USER bun
EXPOSE 8080
CMD ["bun", "server/main.ts"]

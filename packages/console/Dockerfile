FROM rust:1.97-bookworm AS compiler
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN rustup target add wasm32-unknown-unknown && cargo build --locked --release --target wasm32-unknown-unknown -p forgegraph-editor

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY . .
COPY --from=compiler /source/target/wasm32-unknown-unknown/release/forgegraph_editor.wasm /build/editor.wasm
ENV FORGE_EDITOR_WASM=/build/editor.wasm
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @forgegraph/console build

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8787 DATA_PATH=/data/console.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/packages/console/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]

# syntax=docker/dockerfile:1

FROM rust:1.90-bookworm AS gmtrade-build

WORKDIR /build/services/gmtrade-adapter
COPY services/gmtrade-adapter/Cargo.toml services/gmtrade-adapter/Cargo.lock ./
COPY services/gmtrade-adapter/src ./src
RUN cargo build --release --locked

FROM node:22-bookworm-slim AS web-build

WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
COPY apps/web/vendor ./vendor
RUN npm ci

COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts apps/web/vitest.config.ts ./
COPY apps/web/public ./public
COPY apps/web/src ./src
COPY apps/web/server ./server
COPY apps/web/shared ./shared

ARG VITE_PRIVY_APP_ID
ARG VITE_PRIVY_AUTHORIZATION_KEY_ID
ARG VITE_PRIVY_ONRAMP_ENV=production
ENV VITE_PRIVY_APP_ID=${VITE_PRIVY_APP_ID}
ENV VITE_PRIVY_AUTHORIZATION_KEY_ID=${VITE_PRIVY_AUTHORIZATION_KEY_ID}
ENV VITE_PRIVY_ONRAMP_ENV=${VITE_PRIVY_ONRAMP_ENV}
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/apps/web
RUN chown node:node /app/apps/web
COPY --chown=node:node apps/web/package.json apps/web/package-lock.json ./
COPY --chown=node:node apps/web/vendor ./vendor
USER node
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --from=web-build --chown=node:node /app/apps/web/dist ./dist
COPY --chown=node:node apps/web/server ./server
COPY --chown=node:node apps/web/shared ./shared
COPY --from=gmtrade-build --chown=node:node /build/services/gmtrade-adapter/target/release/flay-gmtrade-adapter /app/services/gmtrade-adapter/target/release/flay-gmtrade-adapter

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV GMTRADE_ADAPTER_BIN=/app/services/gmtrade-adapter/target/release/flay-gmtrade-adapter

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]

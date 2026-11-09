# The web proxy: Caddy with the website build in it. proxy/Caddyfile says what it serves.

# Stage 1: Dependencies
# Node 25+ no longer bundles Corepack, so each Node stage installs a pinned one for Yarn
FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS deps
RUN npm i -g corepack@0.36.0 && corepack enable
WORKDIR /app

# Root workspace files + website manifest
COPY package.json yarn.lock .yarnrc.yml ./
COPY website/package.json ./website/

RUN corepack prepare --activate
RUN yarn install

# Stage 2: Builder
FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS builder
RUN npm i -g corepack@0.36.0 && corepack enable
WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
COPY website/package.json ./website/
RUN corepack prepare --activate

COPY --from=deps /app/node_modules ./node_modules
COPY website/ ./website/
COPY THIRD_PARTY_NOTICES.md ./

RUN yarn workspace website build

# Stage 3: Caddy, as its own user. The compose file lets that user bind ports 80 and 443, so the binary's own
# capability goes, as no-new-privileges refuses to run a binary that asks for one. Nothing here uses the image's curl
FROM caddy:2.11.8-alpine@sha256:f6228111e5fafa1a5238258d0858e103f10599b8d1659a146e7726681a002bb9
RUN setcap -r /usr/bin/caddy && apk del --no-cache curl && adduser -D -H -u 1002 caddy && chown -R caddy:caddy /data /config
COPY proxy/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/website/dist /srv
USER caddy

# The web proxy: Caddy with the website build in it. proxy/Caddyfile says what it serves.

# Stage 1: Dependencies
# Node 25+ no longer bundles Corepack, so each Node stage installs a pinned one for Yarn
# The website build is the same on every platform, so the Node stages run natively and never under arm64 emulation
FROM --platform=$BUILDPLATFORM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS deps
RUN npm i -g corepack@0.36.0 && corepack enable
WORKDIR /app

# Root workspace files + website manifest
COPY package.json yarn.lock .yarnrc.yml ./
COPY website/package.json ./website/

RUN corepack prepare --activate
RUN yarn install

# Stage 2: Builder
FROM --platform=$BUILDPLATFORM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS builder
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
FROM caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee
# shortcut: zlib is upgraded past the base for CVE-2026-4738, drop the upgrade once the pinned base ships zlib 1.4
RUN apk upgrade --no-cache zlib && setcap -r /usr/bin/caddy && apk del --no-cache curl && adduser -D -H -u 1002 caddy && chown -R caddy:caddy /data /config
COPY proxy/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/website/dist /srv
USER caddy

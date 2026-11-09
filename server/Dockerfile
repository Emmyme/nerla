# Stage 1: Dependencies
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS deps
# Node 25+ no longer bundles Corepack, so each Node stage installs a pinned one for Yarn
RUN npm i -g corepack@0.36.0 && corepack enable

WORKDIR /app

# Corepack reads the Yarn version from the packageManager field in package.json
COPY package.json yarn.lock .yarnrc.yml ./
COPY server/package.json ./server/
RUN corepack prepare --activate
RUN yarn install

# Stage 2: Builder
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS builder
RUN npm i -g corepack@0.36.0 && corepack enable

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
COPY server/package.json ./server/
COPY server/tsconfig.json ./server/
COPY server/drizzle.config.ts ./server/
RUN corepack prepare --activate

# Yarn hoists every workspace dependency, TypeScript included, to the root node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY server/src ./server/src/

WORKDIR /app/server
RUN node ../node_modules/typescript/lib/tsc.js

# Stage 3: The server's production dependencies, installed here so Yarn and its cache stay out of the runner
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS prod-deps
RUN npm i -g corepack@0.36.0 && corepack enable
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY server/package.json ./server/
RUN corepack prepare --activate
RUN yarn workspaces focus server --production

# Stage 4: Runner (production)
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS runner

WORKDIR /app

# No package manager at runtime, and a non-root user for security
# shortcut: zlib is upgraded past the base for CVE-2026-4738, drop the upgrade once the pinned base ships zlib 1.4
RUN apk upgrade --no-cache zlib && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs

ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY server/package.json ./server/

COPY --from=builder --chown=nodejs:nodejs /app/server/dist ./server/dist

# The migrations the server applies as it starts
COPY --chown=nodejs:nodejs server/drizzle ./server/drizzle

# Nerla's licence and the licences of everything the image carries
COPY --chown=nodejs:nodejs LICENSE ./LICENSE
COPY --chown=nodejs:nodejs server/THIRD_PARTY_LICENSES.md ./server/THIRD_PARTY_LICENSES.md

COPY --chown=nodejs:nodejs server/start.sh ./server/start.sh
RUN chmod +x ./server/start.sh

# Where STORAGE_DRIVER=local keeps files. A new volume mounted here takes this owner
RUN mkdir -p /data/files && chown nodejs:nodejs /data/files

USER nodejs

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# The server applies pending migrations as it starts
WORKDIR /app/server
CMD ["sh", "start.sh"]

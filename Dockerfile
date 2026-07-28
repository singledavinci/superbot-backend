FROM node:22-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN npm ci \
    && npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/scripts ./scripts

USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "start:bot"]

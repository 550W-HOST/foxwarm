FROM node:22-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/webui/package.json packages/webui/package-lock.json ./packages/webui/

RUN npm ci && npm --prefix packages/webui ci

COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates
COPY packages/webui ./packages/webui

RUN npm run build && npm --prefix packages/webui run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/lib ./lib
COPY --from=build /app/templates ./templates
COPY --from=build /app/packages/webui/dist ./packages/webui/dist
COPY --from=build /app/packages/webui/public ./packages/webui/public

RUN mkdir -p state agents skills

EXPOSE 3001

CMD ["node", "lib/index.js"]

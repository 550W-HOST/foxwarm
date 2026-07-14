FROM node:24.17.0-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/webui/package.json packages/webui/package-lock.json ./packages/webui/
COPY packages/cli-node/package.json packages/cli-node/package-lock.json ./packages/cli-node/

RUN npm ci && npm --prefix packages/webui ci && npm --prefix packages/cli-node ci

COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates
COPY skills ./skills
COPY scripts/start-sandbox-node.sh ./scripts/start-sandbox-node.sh
COPY packages/shared ./packages/shared
COPY packages/webui ./packages/webui
COPY packages/cli-node ./packages/cli-node
COPY packages/cli-node-runtime ./packages/cli-node-runtime

RUN npm run build && npm --prefix packages/webui run build
RUN rm -rf /app/packages/shared/node_modules /app/packages/cli-node/node_modules /app/packages/cli-node-runtime/node_modules

# Code workbench assets are optional; extension bundles are always present.
COPY packages/vscode-web ./packages/vscode-web
RUN mkdir -p /app/packages/vscode-web/assets/vscode-web

FROM node:24.17.0-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        curl \
        dnsutils \
        file \
        git \
        iproute2 \
        iputils-ping \
        jq \
        less \
        lsof \
        netcat-openbsd \
        procps \
        python-is-python3 \
        python3 \
        python3-pip \
        rsync \
        ripgrep \
        tmux \
        unzip \
        vim-tiny \
        xz-utils \
        zip \
        build-essential \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/lib ./lib
COPY --from=build /app/templates ./templates
COPY --from=build /app/skills ./skills
COPY --from=build /app/scripts/start-sandbox-node.sh ./scripts/start-sandbox-node.sh
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/cli-node ./packages/cli-node
COPY --from=build /app/packages/cli-node-runtime ./packages/cli-node-runtime
COPY --from=build /app/packages/webui/dist ./packages/webui/dist
COPY --from=build /app/packages/webui/public ./packages/webui/public
COPY --from=build /app/packages/vscode-web/foxwarm-fs ./packages/vscode-web/foxwarm-fs
COPY --from=build /app/packages/vscode-web/foxwarm-terminal ./packages/vscode-web/foxwarm-terminal
COPY --from=build /app/packages/vscode-web/foxwarm-scm ./packages/vscode-web/foxwarm-scm
COPY --from=build /app/packages/vscode-web/assets ./packages/vscode-web/assets

RUN mkdir -p /data

ENV FOXWARM_DATA_DIR=/data

EXPOSE 3001

CMD ["node", "lib/index.js"]

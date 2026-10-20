# Build Main and its delivery resources from source. No host build output is used.
FROM node:24.17.0-trixie AS build

RUN curl -fsSLo /tmp/packages-microsoft-prod.deb https://packages.microsoft.com/config/debian/13/packages-microsoft-prod.deb \
    && dpkg -i /tmp/packages-microsoft-prod.deb \
    && rm /tmp/packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends dotnet-sdk-10.0 python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/webui/package.json packages/webui/package-lock.json ./packages/webui/
RUN npm ci && npm --prefix packages/webui ci

COPY tsconfig.json tsconfig.artifacts.json ./
COPY src/artifacts/managedPrepare.ts src/artifacts/reactCompiler.ts src/artifacts/rasterMetadata.ts ./src/artifacts/
COPY dotnet ./dotnet
COPY templates ./templates
COPY skills ./skills
COPY scripts ./scripts
COPY packages/shared ./packages/shared
COPY packages/webui ./packages/webui
COPY packages/cli-node ./packages/cli-node
COPY packages/cli-node-runtime ./packages/cli-node-runtime
COPY packages/vscode-web ./packages/vscode-web
COPY LICENSE ./LICENSE

# Delivery.targets is the only collector for runtime assets and notices.
RUN npm run build:assets \
    && dotnet publish dotnet/Foxwarm/Foxwarm.csproj -c Release --self-contained false -o /out

FROM node:24.17.0-trixie-slim AS runtime

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
    && curl -fsSLo /tmp/packages-microsoft-prod.deb https://packages.microsoft.com/config/debian/13/packages-microsoft-prod.deb \
    && dpkg -i /tmp/packages-microsoft-prod.deb \
    && rm /tmp/packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends aspnetcore-runtime-10.0 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    ASPNETCORE_ENVIRONMENT=Production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
# Keep the existing JS/stdio MCP and operator tool environment, independently
# of Main's managed runtime. The retained public JS bins use this lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /out ./
RUN mkdir -p /data /app/packages/vscode-web/assets/vscode-web

ENV FOXWARM_DATA_DIR=/data
EXPOSE 3001
CMD ["dotnet", "Foxwarm.dll"]

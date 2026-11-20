# Build native Main and its delivery resources from source (default target), or package a
# prebuilt native Linux release (target `release`). No host build output is used. Main is a
# NativeAOT executable in both targets; the image contains no .NET runtime.
FROM node:24.17.0-trixie AS build

# NativeAOT links with clang against this stage's glibc, the same Debian release as the runtime base.
RUN curl -fsSLo /tmp/packages-microsoft-prod.deb https://packages.microsoft.com/config/debian/13/packages-microsoft-prod.deb \
    && dpkg -i /tmp/packages-microsoft-prod.deb \
    && rm /tmp/packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends dotnet-sdk-10.0 python3 clang zlib1g-dev \
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
COPY packages/browser-node ./packages/browser-node
COPY packages/browser-host ./packages/browser-host
COPY packages/vscode-web ./packages/vscode-web
COPY LICENSE ./LICENSE

# Delivery.targets is the only collector for runtime assets and notices.
RUN npm run build:assets \
    && case "$(dpkg --print-architecture)" in amd64) rid=linux-x64 ;; arm64) rid=linux-arm64 ;; *) exit 1 ;; esac \
    && dotnet publish dotnet/Foxwarm/Foxwarm.csproj -c Release -r "$rid" --self-contained true \
        -p:PublishAot=true -p:StripSymbols=true -p:DebugType=None -p:DebugSymbols=false -o /out \
    && find /out \( -name '*.dbg' -o -name '*.pdb' -o -name '*.xml' \) -delete \
    && test ! -e /out/Foxwarm.dll

FROM node:24.17.0-trixie-slim AS base

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
        sudo \
        util-linux \
        vim-tiny \
        xz-utils \
        zip \
        build-essential \
        pkg-config \
        libicu76 \
        libssl3t64 \
    && rm -rf /var/lib/apt/lists/*

# Native Main loads ICU and OpenSSL at run time; there is no .NET runtime in the image.
ENV NODE_ENV=production \
    ASPNETCORE_ENVIRONMENT=Production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
# Keep the existing JS/stdio MCP and operator tool environment, independently
# of Main's managed runtime. The retained public JS bins use this lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN mkdir -p /data /app/packages/vscode-web/assets/vscode-web \
    && chown -R node:node /data /app/packages/vscode-web/assets

# Foxwarm and everything it launches run as the image's fixed non-root `node` account (uid 1000),
# which has passwordless sudo so Agents can still install packages.
# The entry point starts as root only to check that the data directory is writable by that account,
# then drops privileges with setpriv; it does not change ownership of mounted data. Chromium's own sandbox is left on; it needs the
# seccomp profile in docker/seccomp-chromium.json (see the install guide).
RUN echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node \
    && visudo -cf /etc/sudoers.d/node
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/foxwarm-entrypoint

ENV FOXWARM_DATA_DIR=/data
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/foxwarm-entrypoint"]
CMD ["/app/Foxwarm"]

# Published image: an extracted native linux-x64 release package, e.g.
#   docker build --target release --build-context package=foxwarm-0.9.4-linux-x64 .
FROM base AS release
COPY --from=package . ./

# Default: build the same payload from this checkout.
FROM base AS runtime
COPY --from=build /out ./

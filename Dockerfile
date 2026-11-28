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

COPY dotnet ./dotnet
COPY templates ./templates
COPY skills ./skills
COPY scripts ./scripts
COPY packages/shared ./packages/shared
COPY packages/artifact-runtime ./packages/artifact-runtime
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

# The decoder is a separate NativeAOT executable only for hosted deployments. Main's output
# already supplies the same RID's libSkiaSharp.so and notices. File-mode/Desktop payloads
# do not depend on a second executable or Linux process confinement.
FROM build AS hosted-decoder-build
RUN case "$(dpkg --print-architecture)" in amd64) rid=linux-x64 ;; arm64) rid=linux-arm64 ;; *) exit 1 ;; esac \
    && dotnet publish dotnet/Foxwarm.ImageDecoder -c Release -r "$rid" -o /decoder \
    && test -x /decoder/Foxwarm.ImageDecoder

# Hosted mode (`--target hosted`): the same native payload on a minimal base for stateless
# replicas. Tenant state lives in PostgreSQL and object storage; a replica writes only to its
# scratch directory, so the root filesystem can be read-only. The
# base has CA certificates, time zones and the ICU and OpenSSL libraries native Main loads, and
# no tools for Agents: no Chromium, git or Python.
FROM debian:trixie-slim AS hosted
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata libicu76 libssl3t64 tini util-linux libseccomp2 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin foxwarm \
    && mkdir -p /scratch /etc/foxwarm \
    && chown 1000:1000 /scratch
COPY --from=build /out /app/
COPY --from=hosted-decoder-build /decoder/Foxwarm.ImageDecoder /app/
COPY --chmod=755 docker/hosted-entrypoint.sh /usr/local/bin/foxwarm-hosted
# Replica-specific settings (FOXWARM_REPLICA_ID, FOXWARM_ADVERTISE_ADDRESS) and secrets come from
# the orchestrator; the scratch directory is an ephemeral mount.
ENV FOXWARM_MODE=hosted \
    FOXWARM_SCRATCH_DIR=/scratch \
    FOXWARM_DEPLOYMENT_CONFIG=/etc/foxwarm/deployment.yaml \
    TMPDIR=/scratch/.temp \
    ASPNETCORE_ENVIRONMENT=Production
WORKDIR /app
USER 1000:1000
# Probes the replica's health listener (`health.port` of the deployment configuration) at
# /livez, so a waiting standby counts as healthy; orchestrators route on /readyz themselves.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
    CMD ["/app/Foxwarm", "hosted", "health"]
# tini is PID 1: it forwards signals to Foxwarm, passes on its exit code and reaps orphaned
# descendants of the processes Foxwarm starts (ToolScript workers, Node providers).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/foxwarm-hosted"]

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

# The pinned operator runs the full local toolchain over hosted structured stores. The
# persistent mount holds only its Agent directories, per-tenant scratch and local tool state.
FROM base AS master-host
RUN apt-get update && apt-get install -y --no-install-recommends tini libseccomp2 && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /master /etc/foxwarm && chown 1000:1000 /master
COPY --from=build /out /app/
COPY --from=hosted-decoder-build /decoder/Foxwarm.ImageDecoder /app/
# The version-matched optional Code package, supplied as a named build context.
COPY --from=code /foxwarm-code-*.fwassets /app/packages/vscode-web/assets/foxwarm.assets
COPY --chmod=755 docker/hosted-entrypoint.sh /usr/local/bin/foxwarm-hosted
ENV FOXWARM_MODE=hosted \
    FOXWARM_ROLE=master-host \
    FOXWARM_AGENTS_DIR=/master \
    FOXWARM_SCRATCH_DIR=/master/scratch \
    FOXWARM_DEPLOYMENT_CONFIG=/etc/foxwarm/deployment.yaml \
    HOME=/tmp/home TMPDIR=/tmp
USER 1000:1000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 CMD ["/app/Foxwarm", "hosted", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/foxwarm-hosted"]
CMD []

# Default: build the same payload from this checkout.
FROM base AS runtime
COPY --from=build /out ./

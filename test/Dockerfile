FROM node:24.17.0-bookworm AS webui

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY packages/webui/package.json packages/webui/package-lock.json packages/webui/
RUN npm ci --prefix packages/webui
COPY packages/shared/src/ packages/shared/src/
COPY packages/webui/ packages/webui/
RUN npm --prefix packages/webui run build

FROM node:24.17.0-bookworm AS node-assets

WORKDIR /src
COPY packages/shared/package.json packages/shared/package-lock.json packages/shared/
COPY packages/cli-node/package.json packages/cli-node/package-lock.json packages/cli-node/
RUN npm ci --prefix packages/shared && npm ci --prefix packages/cli-node
COPY packages/shared/src/ packages/shared/src/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/cli-node/src/ packages/cli-node/src/
COPY packages/cli-node/scripts/ packages/cli-node/scripts/
COPY packages/cli-node/tsconfig.json packages/cli-node/
RUN npm --prefix packages/shared run build && npm --prefix packages/cli-node run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY dotnet/scripts/acquire-monty-native.py dotnet/scripts/
COPY dotnet/Foxwarm/ToolScript/MONTY-LICENSE dotnet/Foxwarm/ToolScript/
RUN python3 dotnet/scripts/acquire-monty-native.py /opt/monty
COPY . .
COPY --from=webui /src/packages/webui/dist packages/webui/dist
COPY --from=node-assets /src/packages/shared/dist packages/shared/dist
COPY --from=node-assets /src/packages/cli-node/dist packages/cli-node/dist
RUN dotnet publish dotnet/Foxwarm/Foxwarm.csproj -c Release -o /out /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out ./
COPY --from=build /opt/monty /opt/monty
COPY --from=webui /src/packages/webui/dist /app/webui-dist

RUN mkdir -p /data /workspace

ENV ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_EnableDiagnostics=0 \
    FOXWARM_DATA_DIR=/data \
    FOXWARM_EXPERIMENT_TOOL_ROOT=/workspace \
    FOXWARM_EXPERIMENT_MONTY_BINARY=/opt/monty/bin/monty \
    FOXWARM_EXPERIMENT_WEBUI_DIST=/app/webui-dist \
    FOXWARM_EXPERIMENT_PORT=3001 \
    FOXWARM_EXPERIMENT_BIND_ADDRESS=0.0.0.0

EXPOSE 3001
ENTRYPOINT ["dotnet", "Foxwarm.dll"]

FROM node:24.17.0-bookworm AS webui

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY packages/webui/package.json packages/webui/package-lock.json packages/webui/
RUN npm ci --prefix packages/webui
COPY packages/webui/ packages/webui/
RUN npm --prefix packages/webui run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .
COPY --from=webui /src/packages/webui/dist packages/webui/dist
RUN dotnet publish dotnet/Foxwarm/Foxwarm.csproj -c Release -o /out /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime

WORKDIR /app
COPY --from=build /out ./
COPY --from=webui /src/packages/webui/dist /app/webui-dist

RUN mkdir -p /data /workspace

ENV ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_EnableDiagnostics=0 \
    FOXWARM_DATA_DIR=/data \
    FOXWARM_EXPERIMENT_TOOL_ROOT=/workspace \
    FOXWARM_EXPERIMENT_WEBUI_DIST=/app/webui-dist \
    FOXWARM_EXPERIMENT_PORT=3001 \
    FOXWARM_EXPERIMENT_BIND_ADDRESS=0.0.0.0

EXPOSE 3001
ENTRYPOINT ["dotnet", "Foxwarm.dll"]

# Build the full CLI, including PTY, using only native-musl SDK/distro inputs.
ARG SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0.401-alpine3.23
FROM ${SDK_IMAGE} AS build
RUN apk add --no-cache build-base clang binutils file cmake linux-headers \
    icu-static icu-dev icu-data-full openssl-dev openssl-libs-static zlib-static
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
WORKDIR /src
COPY package.json ./
COPY dotnet/Directory.Build.props dotnet/
COPY dotnet/Foxwarm.CliNode/ dotnet/Foxwarm.CliNode/
COPY dotnet/Foxwarm.NodePrimitives/ dotnet/Foxwarm.NodePrimitives/
COPY dotnet/Foxwarm.BrowserSupport/ dotnet/Foxwarm.BrowserSupport/
COPY scripts/native-aot/pty-native-probe.c scripts/native-aot/
RUN dotnet --info && apk info -v && clang --version && gcc --version
RUN gcc -std=c11 -O2 -Wall -Wextra -Werror -static -DFOXWARM_STATIC_MUSL \
      scripts/native-aot/pty-native-probe.c -pthread -lutil -o /tmp/pty-native-probe \
    && timeout 30s /tmp/pty-native-probe \
    && timeout 30s /tmp/pty-native-probe --fallback \
    && timeout 30s /tmp/pty-native-probe --no-close-mechanism
ARG ICU_DATA_PATH=/usr/share/icu/76.1/icudt76l.dat
RUN dotnet publish dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj \
    -c Release -r linux-musl-x64 -p:PublishAot=true \
    -p:RuntimeFrameworkVersion=10.0.12 -p:StaticExecutable=true \
    -p:InvariantGlobalization=false -p:StaticICULinking=true \
    -p:StaticOpenSslLinking=true -p:FoxwarmStaticMusl=true \
    -p:EmbedIcuDataPath="${ICU_DATA_PATH}" -o /publish
RUN file /publish/Foxwarm.CliNode \
    && readelf -h -l -d /publish/Foxwarm.CliNode \
    && ! readelf -l /publish/Foxwarm.CliNode | grep -q INTERP \
    && ! readelf -d /publish/Foxwarm.CliNode | grep -q NEEDED \
    && test ! -e /publish/libfoxwarm-pty.so
FROM scratch AS artifact
COPY --from=build /publish/ /


# Separate redistribution target; the qualified compiler/linker invocation above
# and the raw artifact target remain unchanged.
FROM build AS distribution-build
ARG SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0.401-alpine3.23
COPY scripts/native-aot/collect-notices.sh scripts/native-aot/
RUN sh scripts/native-aot/collect-notices.sh /distribution
FROM scratch AS distribution
COPY --from=distribution-build /distribution/ /

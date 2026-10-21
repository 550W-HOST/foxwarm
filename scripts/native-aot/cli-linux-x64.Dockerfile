# Build from the repository root. The SDK is copied, never the SDK image's libc.
ARG SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0.401
ARG BUILD_IMAGE=registry.access.redhat.com/ubi9/ubi:latest
FROM ${SDK_IMAGE} AS sdk
FROM ${BUILD_IMAGE} AS build
RUN dnf install -y clang gcc binutils zlib-devel libicu openssl-libs krb5-libs \
    && dnf clean all
COPY --from=sdk /usr/share/dotnet /usr/share/dotnet
ENV PATH=/usr/share/dotnet:$PATH \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
WORKDIR /src
COPY package.json ./
COPY dotnet/Directory.Build.props dotnet/
COPY dotnet/Foxwarm.CliNode/ dotnet/Foxwarm.CliNode/
COPY dotnet/Foxwarm.NodePrimitives/ dotnet/Foxwarm.NodePrimitives/
COPY dotnet/Foxwarm.BrowserSupport/ dotnet/Foxwarm.BrowserSupport/
RUN dotnet --info && clang --version && gcc --version && ldd --version
RUN dotnet publish dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj \
    -c Release -r linux-x64 -p:PublishAot=true -p:RuntimeFrameworkVersion=10.0.12 \
    -o /publish
RUN file=/publish/Foxwarm.CliNode; readelf -h -l -d -V "$file" \
    && objdump -T "$file" | grep -E 'GLIBC_|GLIBCXX_' \
    && readelf -h -l -d -V /publish/libfoxwarm-pty.so
FROM scratch AS artifact
COPY --from=build /publish/ /

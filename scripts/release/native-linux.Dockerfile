# Build environment for the native Linux package. A NativeAOT executable requires the glibc
# it was linked against, so it is built on glibc 2.34 (UBI 9, RHEL 9 compatible): the package
# then runs on Ubuntu 22.04, Debian 12, RHEL 9 and later. The SDK is copied from its official
# image, never that image's newer libc. The release job mounts the checkout (with delivery
# assets already built) and the runner's Node.js, and runs scripts/release/package.mjs here.
ARG SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0.403
ARG BUILD_IMAGE=registry.access.redhat.com/ubi9/ubi:latest
FROM ${SDK_IMAGE} AS sdk
FROM ${BUILD_IMAGE}
RUN dnf install -y clang gcc binutils glibc-devel zlib-devel python3 git-core findutils tar gzip \
        libicu openssl-libs krb5-libs \
    && dnf clean all
COPY --from=sdk /usr/share/dotnet /usr/share/dotnet
ENV PATH=/usr/share/dotnet:$PATH \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
RUN dotnet --info && clang --version && ldd --version

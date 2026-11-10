# Build environment for the Linux x64 LanceDB library. The library from the LanceDB package is
# linked on glibc 2.39; building the same pinned source on glibc 2.34 (UBI 9, RHEL 9
# compatible) lets semantic search run wherever Main runs. See build-lancedb-linux.sh.
ARG BUILD_IMAGE=registry.access.redhat.com/ubi9/ubi:latest
FROM ${BUILD_IMAGE}
# Rust must match the channel in the pinned source's pinvoke/rust-toolchain.toml.
ARG RUST_VERSION=1.93.1
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG PROTOC_VERSION=36.2
ARG PROTOC_SHA256=121f6c7afe1d4d0e3ea6aab9432038599250134cbf4474cb1167d2c7decd4278
RUN dnf install -y gcc gcc-c++ make cmake perl-interpreter glibc-devel binutils python3 tar gzip unzip \
    && dnf clean all
ENV RUSTUP_HOME=/opt/rust/rustup PATH=/opt/rust/cargo/bin:/opt/protoc/bin:$PATH \
    PROTOC=/opt/protoc/bin/protoc PROTOC_INCLUDE=/opt/protoc/include
RUN curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
    && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && CARGO_HOME=/opt/rust/cargo /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
    && rm /tmp/rustup-init \
    && curl -fsSLo /tmp/protoc.zip "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip" \
    && echo "${PROTOC_SHA256}  /tmp/protoc.zip" | sha256sum -c - \
    && mkdir -p /opt/protoc && unzip -q /tmp/protoc.zip -d /opt/protoc && rm /tmp/protoc.zip \
    && chmod -R a+rX /opt/rust /opt/protoc
RUN rustc --version && protoc --version && ldd --version

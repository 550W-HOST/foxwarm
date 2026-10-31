# Test-only image: no CLR or SDK. Node drives the protocol peer, not CLI features.
ARG BASE_IMAGE=ubuntu:22.04
ARG DRIVER_IMAGE=node:22-bookworm-slim
FROM ${DRIVER_IMAGE} AS driver
FROM ${BASE_IMAGE}
USER root
ARG INSTALL_GIT=1
ARG INSTALL_CHROMIUM=0
RUN if command -v apt-get >/dev/null; then \
      apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates libicu-dev openssl libstdc++6 zlib1g git procps \
      && if [ "$INSTALL_CHROMIUM" = 1 ]; then apt-get install -y --no-install-recommends chromium; fi \
      && rm -rf /var/lib/apt/lists/*; \
    elif command -v apk >/dev/null; then \
      apk add --no-cache bash ca-certificates-bundle libstdc++ procps \
      && if [ "$INSTALL_GIT" = 1 ]; then apk add --no-cache git; fi; \
    else \
      dnf install -y bash ca-certificates libicu openssl-libs libstdc++ zlib git procps-ng \
      && dnf clean all; \
    fi
COPY --from=driver /usr/local/bin/node /test-driver/node
# The artifact and repository fixtures are supplied read-only at run time.
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/test-driver/node", "/repo/packages/webui/test/dotnetCliNodeAotLinux.e2e.mjs"]

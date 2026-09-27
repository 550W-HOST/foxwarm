FROM node:24.17.0-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY packages/sandbox-node-runtime/dist/invoke.bundle.js /opt/foxwarm-sandbox-runtime/invoke.bundle.js

WORKDIR /tmp
CMD ["tail", "-f", "/dev/null"]
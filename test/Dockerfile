FROM node:24.17.0-bookworm

# Install chromium for browser automation
RUN apt-get update && \
    apt-get install -y chromium jq curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Container will run npm install, build, and start via docker-compose command

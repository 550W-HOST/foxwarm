FROM node:22-bookworm

# Install chromium for browser automation
RUN apt-get update && \
    apt-get install -y chromium && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set chromium executable path for puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Expose ports
EXPOSE 3001

# Start the bot
CMD ["sh", "-c", "npm run build && node lib/index.js"]

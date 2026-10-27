# Node 24.22.1 includes the CVE-2026-111497 Brotli decoder fix.
FROM node:24.22.1-alpine

WORKDIR /app

# Install poppler-utils for PDF processing and timezone data
RUN apk add --no-cache poppler-utils tzdata

# Install dependencies, then remove package managers unused at runtime
COPY package*.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx

# Copy application files
COPY . .

# Default environment
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]

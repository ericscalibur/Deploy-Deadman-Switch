# Use Node.js 20 Alpine for smaller image size
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies
# python3: generate_secret.py (initial setup)
# curl: health check endpoint
# yq: YAML parsing in start9/configurator.sh
RUN apk add --no-cache python3 py3-pip curl yq bash

# Copy package files
COPY package*.json ./

# Install Node.js dependencies (includes @zxing/library for the UMD bundle)
RUN npm install --production

# Copy application files
COPY . .

# Make ZXing UMD bundle available to the frontend
RUN cp node_modules/@zxing/library/umd/index.min.js public/zxing.min.js

# Make pure-JS image decoders available to the frontend (bypass Tor Browser canvas fingerprinting)
RUN cp node_modules/pako/dist/pako_inflate.min.js public/pako_inflate.min.js
RUN cp node_modules/upng-js/UPNG.js public/upng.js
RUN cp node_modules/jpeg-js/lib/decoder.js public/jpegdecoder.js

# Make Start9 scripts available in PATH
RUN cp start9/*.sh /usr/local/bin/ && chmod +x /usr/local/bin/*.sh

# Install su-exec for safe privilege dropping in entrypoint
RUN apk add --no-cache su-exec

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S deadman -u 1001
RUN mkdir -p /app/data && chown -R deadman:nodejs /app

# Entrypoint runs as root to fix volume permissions, then drops to deadman
# (do not set USER here)

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start command
CMD ["node", "server.js"]

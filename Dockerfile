# Use Node.js 18 Alpine for smaller image size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install dependencies
# python3: generate_secret.py (initial setup)
# curl: health check endpoint
# yq: YAML parsing in start9/configurator.sh
RUN apk add --no-cache python3 py3-pip curl yq bash

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p data database public routes utils models

# Set permissions for data directory
RUN chmod 755 data database

# Make Start9 scripts available in PATH
RUN cp start9/*.sh /usr/local/bin/ && chmod +x /usr/local/bin/*.sh

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S deadman -u 1001
RUN chown -R deadman:nodejs /app
USER deadman

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start command
CMD ["node", "server.js"]

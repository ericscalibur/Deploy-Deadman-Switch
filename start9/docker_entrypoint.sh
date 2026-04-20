#!/bin/bash

set -ea

# Running as root — fix volume permissions then drop to app user
mkdir -p /app/data
chown -R deadman:nodejs /app/data

# Generate .env in the persistent data volume if it doesn't exist
if [ ! -f /app/data/.env ]; then
    echo "Generating initial .env configuration..."
    python3 /app/generate_secret.py --auto --out /app/data/.env
fi

# Load .env into the environment
if [ -f /app/data/.env ]; then
    set -a
    source /app/data/.env
    set +a
fi

# Start9 handles all SSL/Tor proxying — container serves plain HTTP on 3000 only
export NODE_ENV="production"
export PORT="3000"
export DB_PATH="/app/data/deadman_switch.db"
# APP_URL comes from .env (set via config); fall back to localhost if not configured
export APP_URL="${APP_URL:-http://localhost:3000}"
unset SSL_KEY_PATH
unset SSL_CERT_PATH

# Initialize database as app user
echo "Initializing database..."
su-exec deadman node -e "
const initDb = require('./database/init.js');
initDb.initializeDatabase().then(() => {
    console.log('Database initialized successfully');
    process.exit(0);
}).catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
});" || { echo 'Database init failed'; exit 1; }

# Drop to app user and start server
echo "Starting Deadman Switch server..."
exec su-exec deadman node /app/server.js

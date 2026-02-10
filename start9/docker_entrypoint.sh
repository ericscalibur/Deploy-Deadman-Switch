#!/bin/bash

set -ea

_term() {
    echo "Caught SIGTERM signal!"
    kill -TERM "$child" 2>/dev/null
}

trap _term SIGTERM

# Create data directories if they don't exist
mkdir -p /app/data
mkdir -p /app/database

# Generate .env file if it doesn't exist
if [ ! -f /app/.env ]; then
    echo "Generating initial .env configuration..."
    python3 /app/generate_secret.py --auto
fi

# Set default environment variables if not provided
export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-3000}"
export APP_URL="${APP_URL:-http://localhost:3000}"

# Initialize database
echo "Initializing database..."
cd /app && node -e "
const initDb = require('./database/init.js');
initDb.initializeDatabase().then(() => {
    console.log('Database initialized successfully');
    process.exit(0);
}).catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
});
"

# Start the application
echo "Starting Deadman Switch server..."
cd /app
exec node server.js &

child=$!
wait "$child"

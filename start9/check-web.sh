#!/bin/bash

set -ea

PORT="${PORT:-3000}"
URL="http://localhost:${PORT}/health"

response_code=$(curl -s -o /dev/null -w "%{http_code}" "$URL" --max-time 10 || echo "000")

if [ "$response_code" = "200" ]; then
    echo '{"result": "success", "message": "Deadman Switch web interface is ready"}'
else
    echo '{"result": "starting", "message": "Deadman Switch is starting up, web interface not yet available"}'
fi

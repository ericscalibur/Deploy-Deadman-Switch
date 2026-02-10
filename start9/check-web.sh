#!/bin/bash

set -ea

# Health check for the web interface
# This script checks if the Deadman Switch web service is running and accessible

# Check if the server is responding on the expected port
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"

# Function to check HTTP response
check_http() {
    local response_code=$(curl -s -o /dev/null -w "%{http_code}" "$URL" --max-time 10)

    if [ "$response_code" = "200" ]; then
        return 0
    else
        return 1
    fi
}

# Function to check if process is running
check_process() {
    pgrep -f "node server.js" > /dev/null 2>&1
}

# Main health check logic
main() {
    local status="starting"
    local message=""

    # Check if process is running
    if ! check_process; then
        status="error"
        message="Deadman Switch process is not running"
    # Check if HTTP server is responding
    elif ! check_http; then
        status="starting"
        message="Deadman Switch is starting up, web interface not yet available"
    else
        status="success"
        message="Deadman Switch web interface is ready"
    fi

    # Output JSON result for Start9
    cat << EOF
{
    "status": "${status}",
    "message": "${message}",
    "details": {
        "port": ${PORT},
        "url": "${URL}",
        "timestamp": "$(date -Iseconds)"
    }
}
EOF
}

main "$@"

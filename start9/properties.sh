#!/bin/bash

set -ea

# Properties script for Start9 - provides service information and status

# Get service status and properties
main() {
    local config_file="/app/start9/config.yaml"
    local env_file="/app/.env"
    local port="${PORT:-3000}"

    # Check if service is configured
    local configured="false"
    if [ -f "$env_file" ] && grep -q "EMAIL_USER\|SMTP_HOST" "$env_file"; then
        configured="true"
    fi

    # Check if service is running
    local running="false"
    if pgrep -f "node server.js" > /dev/null 2>&1; then
        running="true"
    fi

    # Get email provider if configured
    local email_provider="not configured"
    if [ -f "$env_file" ]; then
        if grep -q "EMAIL_USER=" "$env_file"; then
            email_provider="Gmail"
        elif grep -q "SMTP_HOST=" "$env_file"; then
            email_provider="Custom SMTP"
        fi
    fi

    # Get current version
    local version="1.0.0"
    if [ -f "/app/package.json" ]; then
        version=$(node -e "console.log(require('/app/package.json').version || '1.0.0')" 2>/dev/null || echo "1.0.0")
    fi

    # Calculate data directory size
    local data_size="0"
    if [ -d "/app/data" ]; then
        data_size=$(du -sh /app/data 2>/dev/null | cut -f1 || echo "0")
    fi

    # Count active users (if database exists)
    local user_count="0"
    if [ -f "/app/database/deadman_switch.db" ]; then
        user_count=$(sqlite3 /app/database/deadman_switch.db "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")
    fi

    # Output properties as JSON
    cat << EOF
{
    "version": "$version",
    "configured": $configured,
    "running": $running,
    "email_provider": "$email_provider",
    "port": $port,
    "data_size": "$data_size",
    "user_count": "$user_count",
    "service_url": "https://$(hostname).local",
    "features": [
        "JWT Authentication",
        "Encrypted Data Storage",
        "Email Notifications",
        "Configurable Timers",
        "One-click Check-ins",
        "Real-time Dashboard"
    ],
    "configuration_items": [
        {
            "name": "Email Provider",
            "description": "Configure Gmail or custom SMTP for notifications",
            "configured": $configured
        },
        {
            "name": "Security",
            "description": "JWT tokens and encrypted user data",
            "configured": true
        }
    ],
    "stats": {
        "uptime": "$(uptime -p 2>/dev/null || echo 'unknown')",
        "memory_usage": "$(free -h 2>/dev/null | awk '/^Mem:/ {print $3}' || echo 'unknown')",
        "disk_usage": "$data_size"
    }
}
EOF
}

main "$@"

#!/bin/bash

set -ea

ACTION="${1:-create}"
BACKUP_DIR="/mnt/backup"
DATA_DIR="/app/data"
DATABASE_DIR="/app/database"
CONFIG_FILE="/app/.env"
START9_CONFIG="/app/start9/config.yaml"

# Create backup
create_backup() {
    echo "Creating Deadman Switch backup..."

    # Create backup directory structure
    mkdir -p "$BACKUP_DIR/data"
    mkdir -p "$BACKUP_DIR/database"
    mkdir -p "$BACKUP_DIR/config"

    # Backup user data directory
    if [ -d "$DATA_DIR" ]; then
        echo "Backing up user data..."
        cp -r "$DATA_DIR"/* "$BACKUP_DIR/data/" 2>/dev/null || true
        echo "User data backed up"
    else
        echo "No user data directory found"
    fi

    # Backup database
    if [ -d "$DATABASE_DIR" ]; then
        echo "Backing up database..."
        cp -r "$DATABASE_DIR"/* "$BACKUP_DIR/database/" 2>/dev/null || true
        echo "Database backed up"
    else
        echo "No database directory found"
    fi

    # Backup configuration files (excluding secrets)
    if [ -f "$CONFIG_FILE" ]; then
        echo "Backing up configuration..."
        # Only backup non-sensitive config items
        grep -E "^(PORT|NODE_ENV|APP_URL)" "$CONFIG_FILE" > "$BACKUP_DIR/config/env.backup" 2>/dev/null || true
        echo "Configuration backed up (secrets excluded)"
    fi

    if [ -f "$START9_CONFIG" ]; then
        echo "Backing up Start9 configuration..."
        cp "$START9_CONFIG" "$BACKUP_DIR/config/start9.yaml" 2>/dev/null || true
        echo "Start9 configuration backed up"
    fi

    # Create backup manifest
    cat > "$BACKUP_DIR/manifest.json" << EOF
{
    "service": "deadman-switch",
    "version": "1.0.0",
    "timestamp": "$(date -Iseconds)",
    "backup_type": "full",
    "contents": {
        "user_data": $([ -d "$DATA_DIR" ] && echo "true" || echo "false"),
        "database": $([ -d "$DATABASE_DIR" ] && echo "true" || echo "false"),
        "configuration": $([ -f "$CONFIG_FILE" ] && echo "true" || echo "false")
    },
    "notes": "Backup excludes sensitive credentials (SECRET_KEY, EMAIL_PASS) for security"
}
EOF

    echo "Backup completed successfully"
    echo "Backup location: $BACKUP_DIR"

    # Output backup info for Start9
    cat << EOF
backup_complete: true
backup_size: "$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1 || echo 'unknown')"
backup_timestamp: "$(date -Iseconds)"
items_backed_up:
  - user_data: $([ -d "$DATA_DIR" ] && echo "true" || echo "false")
  - database: $([ -d "$DATABASE_DIR" ] && echo "true" || echo "false")
  - configuration: $([ -f "$CONFIG_FILE" ] && echo "true" || echo "false")
EOF
}

# Restore backup
restore_backup() {
    echo "Restoring Deadman Switch backup..."

    if [ ! -d "$BACKUP_DIR" ]; then
        echo "Error: No backup directory found at $BACKUP_DIR"
        exit 1
    fi

    if [ ! -f "$BACKUP_DIR/manifest.json" ]; then
        echo "Error: Invalid backup - missing manifest.json"
        exit 1
    fi

    # Stop any running service (if applicable)
    pkill -f "node server.js" 2>/dev/null || true
    sleep 2

    # Restore user data
    if [ -d "$BACKUP_DIR/data" ]; then
        echo "Restoring user data..."
        mkdir -p "$DATA_DIR"
        cp -r "$BACKUP_DIR/data"/* "$DATA_DIR/" 2>/dev/null || true
        chown -R deadman:nodejs "$DATA_DIR" 2>/dev/null || true
        echo "User data restored"
    fi

    # Restore database
    if [ -d "$BACKUP_DIR/database" ]; then
        echo "Restoring database..."
        mkdir -p "$DATABASE_DIR"
        cp -r "$BACKUP_DIR/database"/* "$DATABASE_DIR/" 2>/dev/null || true
        chown -R deadman:nodejs "$DATABASE_DIR" 2>/dev/null || true
        echo "Database restored"
    fi

    # Restore configuration (merge with existing)
    if [ -f "$BACKUP_DIR/config/env.backup" ]; then
        echo "Restoring configuration..."

        # If .env exists, preserve secrets and merge
        if [ -f "$CONFIG_FILE" ]; then
            # Create temp file with secrets
            grep -E "^(SECRET_KEY|EMAIL_PASS|EMAIL_USER|SMTP_PASS)" "$CONFIG_FILE" > /tmp/secrets.env 2>/dev/null || true

            # Restore non-sensitive settings
            cat "$BACKUP_DIR/config/env.backup" > "$CONFIG_FILE"

            # Add back secrets if they existed
            if [ -s /tmp/secrets.env ]; then
                cat /tmp/secrets.env >> "$CONFIG_FILE"
            fi

            rm -f /tmp/secrets.env
        else
            # No existing config, just restore backup
            cp "$BACKUP_DIR/config/env.backup" "$CONFIG_FILE"
        fi
        echo "Configuration restored"
    fi

    # Restore Start9 configuration
    if [ -f "$BACKUP_DIR/config/start9.yaml" ]; then
        echo "Restoring Start9 configuration..."
        cp "$BACKUP_DIR/config/start9.yaml" "$START9_CONFIG"
        echo "Start9 configuration restored"
    fi

    # Set proper permissions
    chown -R deadman:nodejs /app/data /app/database 2>/dev/null || true
    chmod -R 755 /app/data /app/database 2>/dev/null || true

    echo "Restore completed successfully"

    # Output restore info for Start9
    cat << EOF
restore_complete: true
restore_timestamp: "$(date -Iseconds)"
items_restored:
  - user_data: $([ -d "$BACKUP_DIR/data" ] && echo "true" || echo "false")
  - database: $([ -d "$BACKUP_DIR/database" ] && echo "true" || echo "false")
  - configuration: $([ -f "$BACKUP_DIR/config/env.backup" ] && echo "true" || echo "false")
next_steps:
  - "Service will restart automatically"
  - "Reconfigure email settings if needed"
  - "Verify deadman switch functionality"
EOF
}

case "$ACTION" in
    create)
        create_backup
        ;;
    restore)
        restore_backup
        ;;
    *)
        echo "Usage: $0 [create|restore]"
        exit 1
        ;;
esac

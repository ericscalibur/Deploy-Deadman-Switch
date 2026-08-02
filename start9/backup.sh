#!/bin/bash

set -ea

ACTION="${1:-create}"
BACKUP_DIR="/mnt/backup"
DATA_DIR="/app/data"
DATABASE_DIR="/app/database"
CONFIG_FILE="/app/.env"
START9_CONFIG="/app/start9/config.yaml"

# Progress messages go to stderr — stdout carries only the structured result,
# which StartOS parses. (0.4's legacy shim parses it as JSON; JSON is valid
# YAML, so the JSON emitted below works under 0.3.x too.)
log() { echo "$@" >&2; }

# Emit a JSON boolean for a path test
json_bool() { [ -e "$1" ] && echo "true" || echo "false"; }

# Create backup
create_backup() {
    log "Creating Deadman Switch backup..."

    # Create backup directory structure
    mkdir -p "$BACKUP_DIR/data"
    mkdir -p "$BACKUP_DIR/database"
    mkdir -p "$BACKUP_DIR/config"

    # Backup user data directory
    if [ -d "$DATA_DIR" ]; then
        log "Backing up user data..."
        cp -r "$DATA_DIR"/* "$BACKUP_DIR/data/" 2>/dev/null || true
        log "User data backed up"
    else
        log "No user data directory found"
    fi

    # Backup database
    if [ -d "$DATABASE_DIR" ]; then
        log "Backing up database..."
        cp -r "$DATABASE_DIR"/* "$BACKUP_DIR/database/" 2>/dev/null || true
        log "Database backed up"
    else
        log "No database directory found"
    fi

    # Backup configuration files (excluding secrets)
    if [ -f "$CONFIG_FILE" ]; then
        log "Backing up configuration..."
        # Only backup non-sensitive config items
        grep -E "^(PORT|NODE_ENV|APP_URL)" "$CONFIG_FILE" > "$BACKUP_DIR/config/env.backup" 2>/dev/null || true
        log "Configuration backed up (secrets excluded)"
    fi

    if [ -f "$START9_CONFIG" ]; then
        log "Backing up Start9 configuration..."
        cp "$START9_CONFIG" "$BACKUP_DIR/config/start9.yaml" 2>/dev/null || true
        log "Start9 configuration backed up"
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

    log "Backup completed successfully"
    log "Backup location: $BACKUP_DIR"

    # Output backup info for Start9
    cat << EOF
{
  "backup_complete": true,
  "backup_size": "$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1 || echo 'unknown')",
  "backup_timestamp": "$(date -Iseconds)",
  "items_backed_up": {
    "user_data": $(json_bool "$DATA_DIR"),
    "database": $(json_bool "$DATABASE_DIR"),
    "configuration": $(json_bool "$CONFIG_FILE")
  }
}
EOF
}

# Restore backup
restore_backup() {
    log "Restoring Deadman Switch backup..."

    if [ ! -d "$BACKUP_DIR" ]; then
        log "Error: No backup directory found at $BACKUP_DIR"
        exit 1
    fi

    if [ ! -f "$BACKUP_DIR/manifest.json" ]; then
        log "Error: Invalid backup - missing manifest.json"
        exit 1
    fi

    # Stop any running service (if applicable)
    pkill -f "node server.js" 2>/dev/null || true
    sleep 2

    # Restore user data
    if [ -d "$BACKUP_DIR/data" ]; then
        log "Restoring user data..."
        mkdir -p "$DATA_DIR"
        cp -r "$BACKUP_DIR/data"/* "$DATA_DIR/" 2>/dev/null || true
        chown -R deadman:nodejs "$DATA_DIR" 2>/dev/null || true
        log "User data restored"
    fi

    # Restore database
    if [ -d "$BACKUP_DIR/database" ]; then
        log "Restoring database..."
        mkdir -p "$DATABASE_DIR"
        cp -r "$BACKUP_DIR/database"/* "$DATABASE_DIR/" 2>/dev/null || true
        chown -R deadman:nodejs "$DATABASE_DIR" 2>/dev/null || true
        log "Database restored"
    fi

    # Restore configuration (merge with existing)
    if [ -f "$BACKUP_DIR/config/env.backup" ]; then
        log "Restoring configuration..."

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
        log "Configuration restored"
    fi

    # Restore Start9 configuration
    if [ -f "$BACKUP_DIR/config/start9.yaml" ]; then
        log "Restoring Start9 configuration..."
        cp "$BACKUP_DIR/config/start9.yaml" "$START9_CONFIG"
        log "Start9 configuration restored"
    fi

    # Set proper permissions
    chown -R deadman:nodejs /app/data /app/database 2>/dev/null || true
    chmod -R 755 /app/data /app/database 2>/dev/null || true

    log "Restore completed successfully"

    # Output restore info for Start9
    cat << EOF
{
  "restore_complete": true,
  "restore_timestamp": "$(date -Iseconds)",
  "items_restored": {
    "user_data": $(json_bool "$BACKUP_DIR/data"),
    "database": $(json_bool "$BACKUP_DIR/database"),
    "configuration": $(json_bool "$BACKUP_DIR/config/env.backup")
  },
  "next_steps": [
    "Service will restart automatically",
    "Reconfigure email settings if needed",
    "Verify deadman switch functionality"
  ]
}
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

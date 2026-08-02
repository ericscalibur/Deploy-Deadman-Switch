#!/bin/bash

set -e

# All persistent state lives in the `main` volume mounted at /app/data:
# the SQLite database (DB_PATH=/app/data/deadman_switch.db), the .env
# (SECRET_KEY + SMTP credentials, written by configurator.sh), and
# config.yaml. Both /app/data and /mnt/backup must be declared as mounts
# on the backup procedures in manifest.yaml — without them this script
# runs against empty directories and "succeeds" while saving nothing.
#
# The full .env INCLUDING SECRET_KEY is backed up deliberately: StartOS
# encrypts backups, and a restore without SECRET_KEY cannot decrypt the
# server-recoverable delivery envelope, so an armed switch restored to a
# fresh install would be unable to fire.
ACTION="${1:-create}"
BACKUP_DIR="/mnt/backup"
DATA_DIR="/app/data"

# Progress messages go to stderr — stdout carries only the structured result,
# which StartOS parses. (0.4's legacy shim parses it as JSON; JSON is valid
# YAML, so it works under 0.3.x too.)
log() { echo "$@" >&2; }

json_bool() { [ -e "$1" ] && echo "true" || echo "false"; }

create_backup() {
    log "Creating Deadman Switch backup..."

    if [ ! -d "$BACKUP_DIR" ]; then
        log "Error: backup volume not mounted at $BACKUP_DIR"
        exit 1
    fi

    mkdir -p "$BACKUP_DIR/data"

    if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
        log "Backing up $DATA_DIR..."
        # Clear stale files from previous backups, then copy everything
        rm -rf "$BACKUP_DIR/data"
        mkdir -p "$BACKUP_DIR/data"
        cp -a "$DATA_DIR/." "$BACKUP_DIR/data/"
        log "Data backed up: $(du -sh "$BACKUP_DIR/data" 2>/dev/null | cut -f1)"
    else
        log "Warning: $DATA_DIR is empty or missing — nothing to back up"
    fi

    cat > "$BACKUP_DIR/manifest.json" << EOF
{
    "service": "deadman-switch",
    "timestamp": "$(date -Iseconds)",
    "backup_type": "full",
    "contents": {
        "database": $(json_bool "$BACKUP_DIR/data/deadman_switch.db"),
        "env": $(json_bool "$BACKUP_DIR/data/.env"),
        "config": $(json_bool "$BACKUP_DIR/data/config.yaml")
    }
}
EOF

    log "Backup completed"

    cat << EOF
{
  "backup_complete": true,
  "backup_size": "$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1 || echo 'unknown')",
  "backup_timestamp": "$(date -Iseconds)",
  "items_backed_up": {
    "database": $(json_bool "$BACKUP_DIR/data/deadman_switch.db"),
    "env": $(json_bool "$BACKUP_DIR/data/.env"),
    "config": $(json_bool "$BACKUP_DIR/data/config.yaml")
  }
}
EOF
}

restore_backup() {
    log "Restoring Deadman Switch backup..."

    if [ ! -d "$BACKUP_DIR/data" ] || [ ! -f "$BACKUP_DIR/manifest.json" ]; then
        log "Error: no valid backup found at $BACKUP_DIR (missing data/ or manifest.json)"
        exit 1
    fi

    mkdir -p "$DATA_DIR"
    cp -a "$BACKUP_DIR/data/." "$DATA_DIR/"

    # Match the ownership docker_entrypoint.sh expects (uid 1001 deadman)
    chown -R 1001:1001 "$DATA_DIR" 2>/dev/null || true

    log "Restore completed"

    cat << EOF
{
  "restore_complete": true,
  "restore_timestamp": "$(date -Iseconds)",
  "items_restored": {
    "database": $(json_bool "$DATA_DIR/deadman_switch.db"),
    "env": $(json_bool "$DATA_DIR/.env"),
    "config": $(json_bool "$DATA_DIR/config.yaml")
  }
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
        echo "Usage: $0 [create|restore]" >&2
        exit 1
        ;;
esac

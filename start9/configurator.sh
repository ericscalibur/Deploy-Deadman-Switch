#!/bin/bash

set -ea

ACTION="${1:-get}"
CONFIG_FILE="/app/data/config.yaml"
ENV_FILE="/app/data/.env"
INTERNAL_URL="http://localhost:3000/internal/config"

# Emit the config spec (field definitions for the Start9 UI)
config_spec() {
cat << 'EOF'
spec:
  email_provider:
    type: enum
    name: Email Provider
    description: Choose your email service provider
    default: gmail
    values:
      - gmail
      - smtp
  gmail_user:
    type: string
    name: Gmail Address
    description: Your Gmail email address
    nullable: true
    masked: false
    placeholder: "your-email@gmail.com"
    default: ~
  gmail_password:
    type: string
    name: Gmail App Password
    description: Gmail app password (not your regular password). Enable 2FA and generate one at myaccount.google.com/apppasswords.
    nullable: true
    masked: true
    placeholder: "16-character app password"
    default: ~
  smtp_host:
    type: string
    name: SMTP Host
    description: SMTP server hostname (required if using smtp provider)
    nullable: true
    masked: false
    placeholder: "smtp.your-provider.com"
    default: ~
  smtp_port:
    type: number
    name: SMTP Port
    description: SMTP server port (usually 587 for TLS)
    nullable: true
    range: "[1,65535]"
    default: 587
  smtp_user:
    type: string
    name: SMTP Username
    description: SMTP authentication username
    nullable: true
    masked: false
    placeholder: "your-smtp-username"
    default: ~
  smtp_password:
    type: string
    name: SMTP Password
    description: SMTP authentication password
    nullable: true
    masked: true
    placeholder: "your-smtp-password"
    default: ~
  app_url:
    type: string
    name: Service URL
    description: Your Tor or LAN address for this service (used in check-in email links). Find it in Start9 under Services → Deploy → Interfaces.
    nullable: true
    masked: false
    placeholder: "http://yourtoraddress.onion"
    default: ~
EOF
}

# Read saved config — try the running service first, then fall back to file
get_config() {
    config_spec

    RESPONSE=$(curl -sf --max-time 3 "$INTERNAL_URL" 2>/dev/null) || RESPONSE=""

    if [ -n "$RESPONSE" ]; then
        # Service is running (inject:true shares network namespace) — convert JSON to YAML
        echo "value:"
        echo "$RESPONSE" | node -e '
const d = JSON.parse(require("fs").readFileSync("/dev/stdin", "utf8"));
const y = v => {
  if (v == null || v === "") return "~";
  const s = String(v).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return "\"" + s + "\"";
};
process.stdout.write([
  "  email_provider: " + (d.email_provider || "gmail"),
  "  gmail_user: " + y(d.gmail_user),
  "  gmail_password: " + y(d.gmail_password),
  "  smtp_host: " + y(d.smtp_host),
  "  smtp_port: " + (d.smtp_port || 587),
  "  smtp_user: " + y(d.smtp_user),
  "  smtp_password: " + y(d.smtp_password),
  "  app_url: " + y(d.app_url)
].join("\n") + "\n");
'
    elif [ -f "$CONFIG_FILE" ]; then
        # File fallback (works if volume mounts are available for config containers)
        echo "value:"
        sed 's/^/  /' "$CONFIG_FILE"
    else
        # No saved config — return defaults
        cat << 'EOF'
value:
  email_provider: gmail
  gmail_user: ~
  gmail_password: ~
  smtp_host: ~
  smtp_port: 587
  smtp_user: ~
  smtp_password: ~
  app_url: ~
EOF
    fi
}

# Save config — try the running service's internal API first, then fall back to files
set_config() {
    CONFIG_INPUT=$(cat)

    EMAIL_PROVIDER=$(echo "$CONFIG_INPUT" | yq e '.email_provider // "gmail"' -)
    GMAIL_USER=$(echo "$CONFIG_INPUT" | yq e '.gmail_user // ""' -)
    GMAIL_PASS=$(echo "$CONFIG_INPUT" | yq e '.gmail_password // ""' -)
    SMTP_HOST=$(echo "$CONFIG_INPUT" | yq e '.smtp_host // ""' -)
    SMTP_PORT=$(echo "$CONFIG_INPUT" | yq e '.smtp_port // 587' -)
    SMTP_USER=$(echo "$CONFIG_INPUT" | yq e '.smtp_user // ""' -)
    SMTP_PASS=$(echo "$CONFIG_INPUT" | yq e '.smtp_password // ""' -)
    APP_URL=$(echo "$CONFIG_INPUT" | yq e '.app_url // ""' -)

    # Build JSON safely via node (handles special chars in passwords/URLs)
    # Values passed one-per-line to avoid process.argv quoting issues
    CONFIG_JSON=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s' \
        "$EMAIL_PROVIDER" "$GMAIL_USER" "$GMAIL_PASS" \
        "$SMTP_HOST" "$SMTP_PORT" "$SMTP_USER" "$SMTP_PASS" "$APP_URL" | \
        node -e '
const lines = require("fs").readFileSync("/dev/stdin", "utf8").split("\n");
const v = s => (s === "" || s === "~" || s === "null") ? null : s;
const cfg = {
  email_provider: lines[0] || "gmail",
  gmail_user: v(lines[1]),
  gmail_password: v(lines[2]),
  smtp_host: v(lines[3]),
  smtp_port: parseInt(lines[4]) || 587,
  smtp_user: v(lines[5]),
  smtp_password: v(lines[6]),
  app_url: v(lines[7])
};
process.stdout.write(JSON.stringify(cfg));
')

    # Primary: POST to the running service (requires inject:true in manifest.yaml)
    if curl -sf --max-time 5 \
        -X POST \
        -H "Content-Type: application/json" \
        -d "$CONFIG_JSON" \
        "$INTERNAL_URL" > /dev/null 2>&1; then
        : # Config saved via HTTP API — service will reload on restart
    else
        # Fallback: write files (used when service is not yet running, or if inject fails)
        mkdir -p "$(dirname "$CONFIG_FILE")"
        echo "$CONFIG_INPUT" > "$CONFIG_FILE"

        # Preserve or generate SECRET_KEY for the .env fallback
        if [ -f "$ENV_FILE" ] && grep -q "SECRET_KEY=" "$ENV_FILE"; then
            SECRET_KEY=$(grep "SECRET_KEY=" "$ENV_FILE" | cut -d'=' -f2-)
        else
            SECRET_KEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
        fi

        cat > "$ENV_FILE" << EOF
SECRET_KEY=${SECRET_KEY}
PORT=3000
NODE_ENV=production
APP_URL=${APP_URL}
EMAIL_PROVIDER=${EMAIL_PROVIDER}
EMAIL_USER=${GMAIL_USER}
EMAIL_PASS=${GMAIL_PASS}
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
EOF
    fi

    # Required by Start9 — signals successful config save
    echo "depends-on: {}"
}

case "$ACTION" in
    get)
        get_config
        ;;
    set)
        set_config
        ;;
    *)
        echo "Usage: $0 [get|set]"
        exit 1
        ;;
esac

#!/bin/bash

set -ea

ACTION="${1:-get}"
CONFIG_FILE="/app/start9/config.yaml"
ENV_FILE="/app/.env"

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

# Read saved values (or emit defaults)
get_config() {
    if [ -f "$CONFIG_FILE" ]; then
        # Return spec + current saved values
        config_spec
        echo "value:"
        sed 's/^/  /' "$CONFIG_FILE"
    else
        # Return spec + default values
        config_spec
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

# Set configuration — Start9 passes the flat `value` object via stdin
set_config() {
    CONFIG_INPUT=$(cat)

    # Save values for next get
    mkdir -p /app/start9
    echo "$CONFIG_INPUT" > "$CONFIG_FILE"

    EMAIL_PROVIDER=$(echo "$CONFIG_INPUT" | yq e '.email_provider // "gmail"' -)

    # Generate SECRET_KEY if not exists
    if [ ! -f "$ENV_FILE" ] || ! grep -q "SECRET_KEY=" "$ENV_FILE"; then
        SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    else
        SECRET_KEY=$(grep "SECRET_KEY=" "$ENV_FILE" | cut -d'=' -f2)
    fi

    APP_URL=$(echo "$CONFIG_INPUT" | yq e '.app_url // ""' -)

    cat > "$ENV_FILE" << EOF
SECRET_KEY=${SECRET_KEY}
PORT=3000
NODE_ENV=production
APP_URL=${APP_URL}
EOF

    if [ "$EMAIL_PROVIDER" = "gmail" ]; then
        EMAIL_USER=$(echo "$CONFIG_INPUT" | yq e '.gmail_user // ""' -)
        EMAIL_PASS=$(echo "$CONFIG_INPUT" | yq e '.gmail_password // ""' -)
        cat >> "$ENV_FILE" << EOF
EMAIL_PROVIDER=gmail
EMAIL_USER=${EMAIL_USER}
EMAIL_PASS=${EMAIL_PASS}
EOF
    else
        SMTP_HOST=$(echo "$CONFIG_INPUT" | yq e '.smtp_host // ""' -)
        SMTP_PORT=$(echo "$CONFIG_INPUT" | yq e '.smtp_port // 587' -)
        SMTP_USER=$(echo "$CONFIG_INPUT" | yq e '.smtp_user // ""' -)
        SMTP_PASS=$(echo "$CONFIG_INPUT" | yq e '.smtp_password // ""' -)
        cat >> "$ENV_FILE" << EOF
EMAIL_PROVIDER=smtp
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
EOF
    fi

    # Required by Start9 — signal successful config save
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

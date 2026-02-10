#!/bin/bash

set -ea

ACTION="${1:-get}"
CONFIG_FILE="/app/start9/config.yaml"
ENV_FILE="/app/.env"

# Default configuration
default_config() {
cat << EOF
email:
  provider:
    type: enum
    name: "Email Provider"
    description: "Choose your email service provider"
    default: gmail
    values:
      - gmail
      - smtp
  gmail:
    enabled: true
    user:
      type: string
      name: "Gmail Address"
      description: "Your Gmail email address"
      nullable: false
      masked: false
      placeholder: "your-email@gmail.com"
    password:
      type: string
      name: "Gmail App Password"
      description: "Gmail app password (not your regular password)"
      nullable: false
      masked: true
      placeholder: "16-character app password"
  smtp:
    enabled: false
    host:
      type: string
      name: "SMTP Host"
      description: "SMTP server hostname"
      nullable: true
      placeholder: "smtp.your-provider.com"
    port:
      type: number
      name: "SMTP Port"
      description: "SMTP server port (usually 587 for TLS)"
      nullable: true
      default: 587
      range: "[1,65535]"
    user:
      type: string
      name: "SMTP Username"
      description: "SMTP authentication username"
      nullable: true
      placeholder: "your-smtp-username"
    password:
      type: string
      name: "SMTP Password"
      description: "SMTP authentication password"
      nullable: true
      masked: true
      placeholder: "your-smtp-password"
advanced:
  port:
    type: number
    name: "Server Port"
    description: "Internal server port (default: 3000)"
    nullable: false
    default: 3000
    range: "[1024,65535]"
  node_env:
    type: enum
    name: "Environment"
    description: "Node.js environment setting"
    default: production
    values:
      - production
      - development
EOF
}

# Get current configuration
get_config() {
    if [ -f "$CONFIG_FILE" ]; then
        cat "$CONFIG_FILE"
    else
        default_config
    fi
}

# Set configuration
set_config() {
    # Read configuration from stdin
    CONFIG_INPUT=$(cat)

    # Save to config file
    echo "$CONFIG_INPUT" > "$CONFIG_FILE"

    # Extract values and update .env file
    EMAIL_PROVIDER=$(echo "$CONFIG_INPUT" | yq e '.email.provider' -)
    PORT=$(echo "$CONFIG_INPUT" | yq e '.advanced.port // 3000' -)
    NODE_ENV=$(echo "$CONFIG_INPUT" | yq e '.advanced.node_env // "production"' -)

    # Generate SECRET_KEY if not exists
    if [ ! -f "$ENV_FILE" ] || ! grep -q "SECRET_KEY=" "$ENV_FILE"; then
        SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    else
        SECRET_KEY=$(grep "SECRET_KEY=" "$ENV_FILE" | cut -d'=' -f2)
    fi

    # Create .env file
    cat > "$ENV_FILE" << EOF
SECRET_KEY=${SECRET_KEY}
PORT=${PORT}
NODE_ENV=${NODE_ENV}
APP_URL=https://$(hostname).local
EOF

    # Add email configuration based on provider
    if [ "$EMAIL_PROVIDER" = "gmail" ]; then
        EMAIL_USER=$(echo "$CONFIG_INPUT" | yq e '.email.gmail.user // ""' -)
        EMAIL_PASS=$(echo "$CONFIG_INPUT" | yq e '.email.gmail.password // ""' -)

        cat >> "$ENV_FILE" << EOF
EMAIL_USER=${EMAIL_USER}
EMAIL_PASS=${EMAIL_PASS}
EOF
    elif [ "$EMAIL_PROVIDER" = "smtp" ]; then
        SMTP_HOST=$(echo "$CONFIG_INPUT" | yq e '.email.smtp.host // ""' -)
        SMTP_PORT=$(echo "$CONFIG_INPUT" | yq e '.email.smtp.port // 587' -)
        SMTP_USER=$(echo "$CONFIG_INPUT" | yq e '.email.smtp.user // ""' -)
        SMTP_PASS=$(echo "$CONFIG_INPUT" | yq e '.email.smtp.password // ""' -)

        cat >> "$ENV_FILE" << EOF
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
EOF
    fi

    echo "Configuration updated successfully"
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
